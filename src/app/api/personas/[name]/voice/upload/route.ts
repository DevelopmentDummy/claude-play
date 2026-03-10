import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);

  const formData = await req.formData();
  const file = formData.get("audio") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase();
  if (![".wav", ".mp3", ".ogg", ".flac"].includes(ext)) {
    return NextResponse.json({ error: "Unsupported audio format" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = `voice-ref${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);

  const config = sessions.readVoiceConfig(dir) || { enabled: true };
  config.referenceAudio = filename;
  sessions.writeVoiceConfig(dir, config);

  return NextResponse.json({ ok: true, filename });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const config = sessions.readVoiceConfig(dir);

  if (!config?.referenceAudio) {
    return new NextResponse(null, { status: 404 });
  }

  const filePath = path.join(dir, config.referenceAudio);
  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
  };

  const data = fs.readFileSync(filePath);
  return new NextResponse(data, {
    headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);

  const config = sessions.readVoiceConfig(dir);
  if (config?.referenceAudio) {
    const filePath = path.join(dir, config.referenceAudio);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    config.referenceAudio = undefined;
    sessions.writeVoiceConfig(dir, config);
  }

  return NextResponse.json({ ok: true });
}
