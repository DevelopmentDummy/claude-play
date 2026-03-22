import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import * as path from "path";
import * as fs from "fs";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const url = new URL(req.url);
  const file = url.searchParams.get("file");

  if (!file) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }

  const { sessions } = getServices();
  const personaDir = sessions.getPersonaDir(name);
  // Preserve subdirectory structure, block traversal
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  const safeName = normalized.split("/").filter(s => s && s !== ".." && s !== ".").join("/") || path.basename(file);
  const filePath = path.join(personaDir, "images", safeName);

  // Verify resolved path stays within images dir
  const imagesDir = path.join(personaDir, "images");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(imagesDir + path.sep) && resolved !== imagesDir) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(safeName).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
    },
  });
}
