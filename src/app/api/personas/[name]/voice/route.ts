import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const config = sessions.readVoiceConfig(dir);
  return NextResponse.json(config || { enabled: false });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  sessions.writeVoiceConfig(dir, body);
  return NextResponse.json({ ok: true });
}
