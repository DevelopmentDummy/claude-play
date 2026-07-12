import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { mimeForPath } from "@/lib/static-file";
import * as path from "path";
import * as fs from "fs";

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
  // "images" 리터럴을 런타임 조립 — 정적이면 next build의 file tracer가 **/images/* 글롭으로
  // data/ 전체를 걷는다 (data-dir.ts의 DATA_DIR_NAME과 같은 방어)
  const IMAGES_SEG = Buffer.from([0x69, 0x6d, 0x61, 0x67, 0x65, 0x73]).toString();
  // Preserve subdirectory structure, block traversal
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  const safeName = normalized.split("/").filter(s => s && s !== ".." && s !== ".").join("/") || path.basename(file);
  const imagesDir = path.join(personaDir, IMAGES_SEG);
  const filePath = path.join(imagesDir, safeName);

  // Verify resolved path stays within images dir
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(imagesDir + path.sep) && resolved !== imagesDir) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const contentType = mimeForPath(safeName);
  const data = fs.readFileSync(filePath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=60",
    },
  });
}
