import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const SKIP_FILES = new Set(["profile.png", "icon.png"]);

function walkImages(dir: string, rel: string): { path: string; folder: string; mtime: number }[] {
  if (!fs.existsSync(dir)) return [];
  const results: { path: string; folder: string; mtime: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...walkImages(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
    } else if (IMAGE_RE.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      results.push({
        path: rel ? `images/${rel}/${entry.name}` : `images/${entry.name}`,
        folder: rel || "",
        mtime: stat.mtimeMs,
      });
    }
  }
  return results;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const recursive = url.searchParams.get("recursive") === "true";
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const imagesDir = path.join(sessionDir, "images");

  if (!fs.existsSync(imagesDir)) {
    return NextResponse.json({ images: [], folders: [] });
  }

  if (recursive) {
    const all = walkImages(imagesDir, "");
    // Sort by mtime descending (newest first)
    all.sort((a, b) => b.mtime - a.mtime);
    const folders = [...new Set(all.map((f) => f.folder).filter(Boolean))].sort();
    return NextResponse.json({
      images: all.map((f) => ({ path: f.path, folder: f.folder, mtime: f.mtime })),
      folders,
      total: all.length,
    });
  }

  // Legacy flat mode
  const files = fs.readdirSync(imagesDir)
    .filter((f) => IMAGE_RE.test(f))
    .filter((f) => !SKIP_FILES.has(f))
    .sort()
    .map((f) => `images/${f}`);

  return NextResponse.json({ images: files });
}
