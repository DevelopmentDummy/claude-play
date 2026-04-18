import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import * as path from "path";
import * as fs from "fs";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Serves files from the configured `source_dir` in `character-lora-dataset.json`.
 * Only files within the configured source_dir are allowed (path traversal blocked).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const relPath = url.searchParams.get("path");

  if (!relPath) {
    return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
  }

  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  if (!fs.existsSync(sessionDir)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Read dataset config to get source_dir
  const datasetPath = path.join(sessionDir, "character-lora-dataset.json");
  if (!fs.existsSync(datasetPath)) {
    return NextResponse.json({ error: "Dataset config not found" }, { status: 404 });
  }

  let sourceDir = "";
  try {
    const ds = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
    sourceDir = String(ds.source_dir || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid dataset config" }, { status: 500 });
  }

  if (!sourceDir) {
    return NextResponse.json({ error: "source_dir not configured" }, { status: 404 });
  }

  const baseDir = path.resolve(sourceDir);
  const resolved = path.resolve(baseDir, relPath);

  // Block path traversal — must stay inside source_dir
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const data = fs.readFileSync(resolved);

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
