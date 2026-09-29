import { NextRequest, NextResponse } from "next/server";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { getSttContext, transcribeWithQwenAsr, warmupQwenAsr } from "@/lib/stt";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Legacy path: ComfyUI Whisper node (no context). Used when Qwen3-ASR is unavailable. */
async function transcribeWithWhisper(buffer: Buffer, mime: string, language: string, modelSize: string) {
  const ext = mime.includes("webm") ? ".webm"
    : mime.includes("mp4") ? ".m4a"
    : mime.includes("ogg") ? ".ogg"
    : ".wav";
  const tmpPath = path.join(os.tmpdir(), `stt-${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const host = process.env.COMFYUI_HOST || "127.0.0.1";
    const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
    const client = new ComfyUIClient({ host, port }, "");
    return await client.transcribeAudio(tmpPath, language, modelSize);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export async function POST(req: NextRequest) {
  try {
    // 녹음 시작 시 모델 선로딩 (fire-and-forget)
    if (req.nextUrl.searchParams.get("warmup") === "1") {
      return NextResponse.json({ ok: await warmupQwenAsr() });
    }

    const formData = await req.formData();
    const audio = formData.get("audio") as Blob | null;
    const language = (formData.get("language") as string) || "ko";
    const modelSize = (formData.get("model_size") as string) || "base";
    const sessionId = formData.get("sessionId") as string | null;

    if (!audio) {
      return NextResponse.json({ error: "No audio provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await audio.arrayBuffer());

    const qwen = await transcribeWithQwenAsr(buffer, { language, context: getSttContext(sessionId) });
    if (qwen.ok) return NextResponse.json({ text: qwen.text, engine: "qwen3-asr" });
    if (!qwen.unavailable) {
      return NextResponse.json({ error: qwen.error }, { status: 500 });
    }
    console.warn("[api/stt] Qwen3-ASR unavailable, falling back to Whisper:", qwen.error);

    const result = await transcribeWithWhisper(buffer, audio.type, language, modelSize);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ text: result.text, engine: "whisper" });
  } catch (err) {
    console.error("[api/stt] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STT failed" },
      { status: 500 }
    );
  }
}
