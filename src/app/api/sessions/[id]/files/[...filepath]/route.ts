import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";

const THUMB_IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function resolveAndValidate(
  sessionDir: string,
  filePath: string
): string | null {
  const resolved = path.resolve(sessionDir, filePath);
  if (!resolved.startsWith(sessionDir + path.sep) && resolved !== sessionDir) {
    return null;
  }
  return resolved;
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

  const resolved = resolveAndValidate(sessionDir, filePath);
  if (!resolved) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

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

  const data = fs.readFileSync(resolved);
  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
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

  const resolved = resolveAndValidate(sessionDir, filePath);
  if (!resolved) {
    return new NextResponse(null, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
