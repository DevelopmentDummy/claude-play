// /api/sessions/[id]/persona-images?file=...
//
// Reads images from the session's parent persona's images dir.
// Sessions can render persona-scoped images via this route while keeping
// their own session-local images served at /api/sessions/[id]/files/images/...
//
// Two modes:
//   - GET ?file=foo.png        → serve a single image (binary)
//   - GET (no ?file)           → list all images in persona dir (JSON)

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const SKIP_FILES = new Set(["profile.png", "icon.png"]);

function resolvePersonaImagesDir(sessionId: string): { personaName: string; imagesDir: string } | null {
  const svc = getServices();
  const info = svc.sessions.getSessionInfo(sessionId);
  if (!info?.persona) return null;
  const personaDir = svc.sessions.getPersonaDir(info.persona);
  return { personaName: info.persona, imagesDir: path.join(personaDir, "images") };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const file = url.searchParams.get("file");

  const resolved = resolvePersonaImagesDir(id);
  if (!resolved) {
    return NextResponse.json({ error: "Session or persona not found" }, { status: 404 });
  }
  const { imagesDir } = resolved;

  // ── Single file mode ──
  if (file) {
    const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
    const safeName = normalized.split("/").filter(s => s && s !== ".." && s !== ".").join("/") || path.basename(file);
    const filePath = path.join(imagesDir, safeName);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(imagesDir + path.sep) && resolvedPath !== imagesDir) {
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }
    if (!fs.existsSync(filePath)) {
      return new NextResponse(null, { status: 404 });
    }
    const ext = path.extname(safeName).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    // Optional thumbnail: ?thumb=240 → resize to fit within 240x240, webp output, disk-cached
    const thumbParam = url.searchParams.get("thumb");
    const thumbSize = thumbParam ? Math.max(32, Math.min(1024, parseInt(thumbParam, 10) || 0)) : 0;
    if (thumbSize && IMAGE_RE.test(safeName)) {
      try {
        const cacheDir = path.join(imagesDir, ".thumbs");
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const cacheFile = path.join(cacheDir, `${safeName}.${thumbSize}.webp`);
        const srcStat = fs.statSync(filePath);
        let cacheValid = false;
        if (fs.existsSync(cacheFile)) {
          const cacheStat = fs.statSync(cacheFile);
          cacheValid = cacheStat.mtimeMs >= srcStat.mtimeMs;
        }
        if (!cacheValid) {
          await sharp(filePath)
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
        // fallthrough to original on thumbnail failure
        console.warn("[persona-images] thumb failed:", e);
      }
    }

    const data = fs.readFileSync(filePath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // ── List mode ──
  if (!fs.existsSync(imagesDir)) {
    return NextResponse.json({ images: [] });
  }
  const files = fs.readdirSync(imagesDir)
    .filter(f => IMAGE_RE.test(f) && !SKIP_FILES.has(f))
    .map(f => {
      const stat = fs.statSync(path.join(imagesDir, f));
      return { filename: f, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return NextResponse.json({ images: files });
}
