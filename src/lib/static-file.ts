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

/**
 * 파일을 HTTP Range(206) 지원과 함께 서빙한다.
 *
 * 배경: 기존 라우트들은 `fs.readFileSync` 결과를 그대로 `NextResponse`에 넘겼는데,
 * 그러면 Next가 `Transfer-Encoding: chunked`로 내보내며 `Content-Length`도
 * `Accept-Ranges`도 붙지 않고 `Range` 헤더는 통째로 무시된다(항상 200).
 * 이미지에는 문제가 없지만 `<video>`/`<audio>`는 그 조합에서
 * 길이를 알 수 없어 탐색이 막히고, Safari는 206을 요구해 재생 자체를 거부한다
 * (2026-08-27 실측 — H3 mp4가 채팅에서 재생되지 않던 원인. 파일은 정상이었고
 *  moov도 선두에 있었다).
 *
 * @param rangeHeader 요청의 `Range` 헤더 값 (없으면 null)
 */
export function fileResponseWithRange(
  data: Buffer,
  contentType: string,
  rangeHeader: string | null,
  cacheControl = "public, max-age=60"
): Response {
  const total = data.length;
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };

  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match) {
    const [, rawStart, rawEnd] = match;
    let start: number;
    let end: number;
    if (rawStart === "") {
      // suffix range: "bytes=-500" = 마지막 500바이트
      const suffix = parseInt(rawEnd, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return unsatisfiable(total, baseHeaders);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = parseInt(rawStart, 10);
      end = rawEnd === "" ? total - 1 : parseInt(rawEnd, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return unsatisfiable(total, baseHeaders);
      end = Math.min(end, total - 1);
    }
    if (start > end || start >= total) return unsatisfiable(total, baseHeaders);

    const chunk = data.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(chunk.length),
      },
    });
  }

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}

function unsatisfiable(total: number, baseHeaders: Record<string, string>): Response {
  return new Response(null, {
    status: 416,
    headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
  });
}
