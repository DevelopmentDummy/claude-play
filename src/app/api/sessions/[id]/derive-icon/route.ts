// /api/sessions/[id]/derive-icon
//
// Generates a 256×256 face-area icon from an existing full portrait by
// cropping the top-center square region. Used as a cheap fallback when the
// ComfyUI face-detector workflow fails to produce {id}_icon.png but the full
// portrait {id}.png does exist.
//
// Body: { girl_id: string }
// Reads:  <personaDir>/images/girls/{girl_id}.png
// Writes: <personaDir>/images/girls/{girl_id}_icon.png

import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { getServices } from "@/lib/services";

function resolvePersonaImagesDir(sessionId: string): string | null {
  const svc = getServices();
  const info = svc.sessions.getSessionInfo(sessionId);
  if (!info?.persona) return null;
  const personaDir = svc.sessions.getPersonaDir(info.persona);
  return path.join(personaDir, "images");
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { girl_id?: string };
  const girlId = body.girl_id;
  if (!girlId) {
    return NextResponse.json({ error: "missing girl_id" }, { status: 400 });
  }

  const imagesDir = resolvePersonaImagesDir(id);
  if (!imagesDir) {
    return NextResponse.json({ error: "session/persona not resolved" }, { status: 404 });
  }

  const fullPath = path.join(imagesDir, "girls", `${girlId}.png`);
  if (!fs.existsSync(fullPath)) {
    return NextResponse.json({ error: "full portrait missing" }, { status: 404 });
  }

  const iconPath = path.join(imagesDir, "girls", `${girlId}_icon.png`);

  try {
    const meta = await sharp(fullPath).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) {
      return NextResponse.json({ error: "image metadata unavailable" }, { status: 500 });
    }
    // For typical 832×1216 character portraits, faces sit roughly in the top 20–35%
    // of the image. Crop a square centered horizontally, with the top edge offset
    // ~6% down from the very top so a bit of hair / breathing room is included.
    const size = Math.min(w, h);
    const left = Math.max(0, Math.round((w - size) / 2));
    const top = Math.max(0, Math.round(h * 0.06));
    // Clamp crop so we never extend past image bounds
    const cropW = Math.min(size, w - left);
    const cropH = Math.min(size, h - top);
    await sharp(fullPath)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(256, 256, { fit: "cover" })
      .png()
      .toFile(iconPath);
    return NextResponse.json({ ok: true, path: `girls/${girlId}_icon.png` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
