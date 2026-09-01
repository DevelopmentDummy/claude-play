import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { mimeForPath, resolveInside, fileResponseWithRange } from "@/lib/static-file";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";

const THUMB_IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
// WebKit(사파리 맥/iOS)은 <video>/<audio>에 대해 바이트 범위 요청을 전제로 한다.
// 206 Partial Content를 못 받으면 재생 자체를 거부하므로 미디어는 반드시 Range를 지원해야 한다.
const MEDIA_RE = /\.(mp4|webm|mov|mp3|m4a|wav|ogg|flac)$/i;
// 채팅 인라인 이미지. 같은 파일명으로 재생성되는 흐름이 있어 장기 캐시는 위험하지만,
// ETag 재검증을 붙이면 재마운트 때 304(바디 0바이트)로 끝난다.
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

/** size+mtime 기반 약한 ETag. 파일이 바뀌면 값이 바뀌므로 재생성 즉시 반영된다. */
function fileEtag(stat: fs.Stats): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; filepath: string[] }> }
) {
  const { id, filepath } = await params;
  const filePath = filepath.join("/");

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);

  if (!fs.existsSync(sessionDir)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const resolved = resolveInside(sessionDir, filePath);
  if (!resolved) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const contentType = mimeForPath(resolved);

  // Optional thumbnail support: ?thumb=240 → resize to fit, webp, disk-cached
  const url = new URL(req.url);
  const thumbParam = url.searchParams.get("thumb");
  const thumbSize = thumbParam ? Math.max(32, Math.min(1024, parseInt(thumbParam, 10) || 0)) : 0;
  if (thumbSize && THUMB_IMAGE_RE.test(resolved)) {
    try {
      const dir = path.dirname(resolved);
      const baseName = path.basename(resolved);
      const cacheDir = path.join(dir, ".thumbs");
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, `${baseName}.${thumbSize}.webp`);
      const srcStat = fs.statSync(resolved);
      let cacheValid = false;
      if (fs.existsSync(cacheFile)) {
        cacheValid = fs.statSync(cacheFile).mtimeMs >= srcStat.mtimeMs;
      }
      if (!cacheValid) {
        await sharp(resolved)
          .rotate()
          .resize(thumbSize, thumbSize, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(cacheFile);
      }
      const data = fs.readFileSync(cacheFile);
      return new NextResponse(data, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch (e) {
      console.warn("[files] thumb failed:", e);
    }
  }

  const stat = fs.statSync(resolved);
  const size = stat.size;
  const isMedia = MEDIA_RE.test(resolved);

  // 미디어는 Range/206을 지원하고 스트리밍으로 흘린다 (static-file.ts).
  if (isMedia) {
    return fileResponseWithRange(resolved, {
      contentType,
      rangeHeader: req.headers.get("range"),
      signal: req.signal ?? null,
      cacheControl: "private, max-age=3600",
    });
  }

  if (IMAGE_RE.test(resolved)) {
    const etag = fileEtag(stat);
    const cacheHeaders = {
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: etag,
      "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
    };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: cacheHeaders });
    }
    const data = fs.readFileSync(resolved);
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        ...cacheHeaders,
      },
    });
  }

  // 미디어·이미지 외(.vtt 등) 폴백 — Range 불필요.
  const data = fs.readFileSync(resolved);
  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ id: string; filepath: string[] }> }
) {
  const { id, filepath } = await params;
  const filePath = filepath.join("/");

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);

  if (!fs.existsSync(sessionDir)) {
    return new NextResponse(null, { status: 404 });
  }

  const resolved = resolveInside(sessionDir, filePath);
  if (!resolved) {
    return new NextResponse(null, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return new NextResponse(null, { status: 404 });
  }

  const contentType = mimeForPath(resolved);
  const size = fs.statSync(resolved).size;
  const isMedia = MEDIA_RE.test(resolved);

  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      ...(isMedia ? { "Accept-Ranges": "bytes" } : {}),
      "Cache-Control": isMedia ? "private, max-age=3600" : "no-store, max-age=0",
    },
  });
}
