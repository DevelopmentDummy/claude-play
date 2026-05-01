import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  const config = sessions.readVoiceConfig(dir);
  return NextResponse.json(config || { enabled: false });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);

  // Sync ttsAutoPlay to live session instance AND persist to voice.json.enabled.
  // Each TTS provider already early-returns when its own config is missing
  // (voiceFile/edgeVoice/etc.), so flipping enabled=true with no setup is harmless.
  let persistEnabled: boolean | undefined;
  if (body.ttsAutoPlay !== undefined) {
    const next = !!body.ttsAutoPlay;
    const instance = getSessionInstance(id);
    if (instance) {
      instance.ttsAutoPlay = next;
      console.log(`[voice] ttsAutoPlay=${next} for ${id}`);
    } else {
      console.warn(`[voice] No active instance for ${id}, ttsAutoPlay not applied to runtime`);
    }
    persistEnabled = next;
    delete body.ttsAutoPlay;
  }

  const existing = sessions.readVoiceConfig(dir) || { enabled: false };
  const merged = { ...existing, ...body };
  if (persistEnabled !== undefined) {
    merged.enabled = persistEnabled;
  }
  sessions.writeVoiceConfig(dir, merged);
  return NextResponse.json({ ok: true });
}
