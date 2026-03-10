import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import { getServices } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { wsBroadcast } from "@/lib/ws-server";

/** Sanitize text for TTS: remove tokens, tags, markdown emphasis */
function sanitizeTtsText(raw: string): string {
  return raw
    .replace(/\$(?:IMAGE|PANEL):[^$]+\$/g, "")
    .replace(/<choice>[\s\S]*?<\/choice>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\*+/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/["""""]/g, "")
    .trim();
}

/** Split sanitized TTS text into chunks by newline, skip empty/trivial lines */
function splitTtsChunks(text: string): string[] {
  return text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 1);
}

export async function POST(req: Request) {
  const svc = getServices();
  const body = (await req.json()) as { messageId: string; text: string };

  if (!body.messageId || !body.text) {
    return NextResponse.json({ error: "Missing messageId or text" }, { status: 400 });
  }

  const sessionId = svc.currentSessionId;
  if (!sessionId) {
    return NextResponse.json({ error: "No active session" }, { status: 400 });
  }

  const sessionDir = svc.sessions.getSessionDir(sessionId);
  const voiceConfig = svc.sessions.readVoiceConfig(sessionDir);
  if (!voiceConfig?.enabled) {
    return NextResponse.json({ error: "TTS not enabled" }, { status: 400 });
  }

  const voiceFile = voiceConfig.voiceFile
    ? path.join(sessionDir, voiceConfig.voiceFile)
    : undefined;
  if (!voiceFile || !fs.existsSync(voiceFile)) {
    return NextResponse.json({ error: "No voice .pt file" }, { status: 400 });
  }

  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const client = new ComfyUIClient({ host, port }, "");

  const languageMap: Record<string, string> = {
    ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
    de: "German", fr: "French", ru: "Russian", pt: "Portuguese",
    es: "Spanish", it: "Italian",
  };
  const lang = languageMap[voiceConfig.language || "ko"] || "Korean";
  const modelSize = voiceConfig.modelSize || "1.7B";
  const chunkDelay = voiceConfig.chunkDelay ?? 500;

  const sanitized = sanitizeTtsText(body.text);
  const chunks = splitTtsChunks(sanitized);

  if (chunks.length === 0) {
    return NextResponse.json({ error: "No text to synthesize" }, { status: 400 });
  }

  const totalChunks = chunks.length;
  const { messageId } = body;

  const seed = Math.floor(Math.random() * 2 ** 32);

  wsBroadcast("audio:status", { status: "generating", messageId, totalChunks });

  // Fire-and-forget: submit chunks sequentially
  (async () => {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, chunkDelay));

      const timestamp = Date.now();
      const audioFilename = `tts-${timestamp}-${i}.mp3`;
      const outputPath = path.join(sessionDir, "audio", audioFilename);

      const prompt: Record<string, unknown> = {
        "10": {
          class_type: "AILab_Qwen3TTSLoadVoice",
          inputs: { voice_name: "", custom_path: voiceFile },
        },
        "1": {
          class_type: "AILab_Qwen3TTSVoiceClone",
          inputs: {
            target_text: chunks[i],
            model_size: modelSize,
            language: lang,
            voice: ["10", 0],
            unload_models: false,
            seed,
          },
        },
        "2": {
          class_type: "SaveAudioMP3",
          inputs: {
            audio: ["1", 0],
            filename_prefix: "tts_bridge",
            quality: "128k",
          },
        },
      };

      try {
        const result = await client.generateTts(prompt, outputPath);
        if (result.success) {
          const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
          wsBroadcast("audio:ready", { url, messageId, chunkIndex: i, totalChunks });
        } else {
          console.error(`[tts] Chunk ${i} failed:`, result.error);
          wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
        }
      } catch (err) {
        console.error(`[tts] Chunk ${i} error:`, err);
        wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
      }
    }
  })();

  return NextResponse.json({ status: "queued", totalChunks });
}
