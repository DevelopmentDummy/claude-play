import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  const config = sessions.readVoiceConfig(dir);
  return NextResponse.json(config || { enabled: false });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);

  // Sync ttsAutoPlay to live session instance (controls TTS generation)
  if (body.ttsAutoPlay !== undefined) {
    const instance = getSessionInstance(id);
    if (instance) {
      instance.ttsAutoPlay = !!body.ttsAutoPlay;
    }
    // Don't persist ttsAutoPlay to voice.json — it's a runtime toggle
    delete body.ttsAutoPlay;
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ ok: true });
    }
  }

  const existing = sessions.readVoiceConfig(dir) || { enabled: false };
  sessions.writeVoiceConfig(dir, { ...existing, ...body });
  return NextResponse.json({ ok: true });
}
