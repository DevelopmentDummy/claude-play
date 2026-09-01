import * as fs from "fs";
import * as path from "path";

/**
 * Content-Type lookup for static files served from disk. Superset of the
 * per-route maps that previously drifted (some omitted .svg / .gif / audio);
 * every shared extension maps to the same type, so consolidating here only
 * adds correct types for extensions that previously fell back to octet-stream.
 */
export const STATIC_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".vtt": "text/vtt",
};

/** Content-Type for a file path; defaults to application/octet-stream. */
export function mimeForPath(filePath: string): string {
  return STATIC_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Resolve `relPath` against `baseDir` and ensure the result stays inside it
 * (blocks path traversal). Returns the absolute path, or null if it escapes.
 */
export function resolveInside(baseDir: string, relPath: string): string | null {
  const resolved = path.resolve(baseDir, relPath);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    return null;
  }
  return resolved;
}

/** `bytes=start-end` 파싱. 유효하지 않거나 만족 불가(416 대상)면 null. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // suffix range: "bytes=-500" = 마지막 500바이트
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 파일 구간을 web ReadableStream으로 흘린다.
 *
 * `Readable.toWeb()`를 쓰면 클라이언트가 중간에 연결을 끊었을 때(사파리는 탐색·버퍼링
 * 과정에서 range 요청을 수시로 중단한다) 이미 닫힌 controller에 enqueue를 시도해
 * `ERR_INVALID_STATE: Controller is already closed`가 uncaughtException으로 터진다.
 * 그래서 직접 구성하고, 닫힘/중단 시 node 스트림을 확실히 destroy한다.
 */
export function fileStream(
  filePath: string,
  opts: { start?: number; end?: number },
  signal: AbortSignal | null
): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(filePath, opts);
  let done = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  // abort/cancel 정리. node 스트림 destroy만으로는 web 쪽이 닫히지 않아(destroy는
  // 'error'를 내지 않는다) 대기 중인 read()가 영구 pending으로 남으므로 controller도 닫는다.
  const finish = () => {
    done = true;
    if (!node.destroyed) node.destroy();
    try { ctrl?.close(); } catch { /* already closed */ }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      node.on("data", (chunk) => {
        if (done) return;
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          // 소비자가 이미 사라진 경우 — 조용히 정리한다
          finish();
          return;
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) node.pause();
      });
      node.on("end", () => {
        if (done) return;
        done = true;
        try { controller.close(); } catch { /* already closed */ }
      });
      node.on("error", (err) => {
        if (done) return;
        done = true;
        try { controller.error(err); } catch { /* already closed */ }
        if (!node.destroyed) node.destroy();
      });
      if (signal) {
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      }
    },
    pull() {
      if (!done) node.resume();
    },
    cancel() {
      finish();
    },
  });
}

/**
 * 디스크 파일을 HTTP Range(206) 지원과 함께 스트리밍으로 서빙한다.
 *
 * 배경: 기존 라우트들은 `fs.readFileSync` 결과를 그대로 `NextResponse`에 넘겼는데,
 * 그러면 Next가 `Transfer-Encoding: chunked`로 내보내며 `Content-Length`도
 * `Accept-Ranges`도 붙지 않고 `Range` 헤더는 통째로 무시된다(항상 200).
 * 이미지에는 문제가 없지만 `<video>`/`<audio>`는 그 조합에서
 * 길이를 알 수 없어 탐색이 막히고, Safari는 206을 요구해 재생 자체를 거부한다
 * (2026-08-27 실측 — H3 mp4가 채팅에서 재생되지 않던 원인. 파일은 정상이었고
 *  moov도 선두에 있었다).
 *
 * 브라우저는 재생·탐색마다 Range 프로브를 여러 번 보내므로(`bytes=0-1` 등) 파일
 * 전체를 메모리에 올리지 않고 `createReadStream`으로 요청 구간만 흘린다.
 */
export function fileResponseWithRange(
  filePath: string,
  opts: {
    contentType: string;
    /** 요청의 `Range` 헤더 값 (없으면 null) */
    rangeHeader: string | null;
    /** 요청 abort 시 node 스트림 정리용 — `req.signal` */
    signal?: AbortSignal | null;
    cacheControl?: string;
  }
): Response {
  const { contentType, rangeHeader, signal = null, cacheControl = "public, max-age=60" } = opts;
  const size = fs.statSync(filePath).size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    return new Response(fileStream(filePath, range, signal), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  return new Response(fileStream(filePath, {}, signal), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
