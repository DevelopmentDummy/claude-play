import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

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
  const existing = sessions.readVoiceConfig(dir) || { enabled: false };
  sessions.writeVoiceConfig(dir, { ...existing, ...body });
  return NextResponse.json({ ok: true });
}
