import { NextRequest, NextResponse } from "next/server";
import { ComfyUIClient } from "@/lib/comfyui-client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio") as Blob | null;
    const language = (formData.get("language") as string) || "ko";
    const modelSize = (formData.get("model_size") as string) || "base";

    if (!audio) {
      return NextResponse.json({ error: "No audio provided" }, { status: 400 });
    }

    // Save audio blob to temp file
    const buffer = Buffer.from(await audio.arrayBuffer());
    const ext = audio.type.includes("webm") ? ".webm"
      : audio.type.includes("mp4") ? ".m4a"
      : audio.type.includes("ogg") ? ".ogg"
      : ".wav";
    const tmpPath = path.join(os.tmpdir(), `stt-${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const host = process.env.COMFYUI_HOST || "127.0.0.1";
      const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
      const client = new ComfyUIClient({ host, port }, "");

      const result = await client.transcribeAudio(tmpPath, language, modelSize);

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }

      return NextResponse.json({ text: result.text });
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error("[api/stt] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STT failed" },
      { status: 500 }
    );
  }
}
