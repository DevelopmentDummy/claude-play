import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const imagesDir = path.join(sessionDir, "images");

  if (!fs.existsSync(imagesDir)) {
    return NextResponse.json({ images: [] });
  }

  const files = fs.readdirSync(imagesDir)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .filter((f) => f !== "profile.png" && f !== "icon.png")
    .sort()
    .map((f) => `images/${f}`);

  return NextResponse.json({ images: files });
}
