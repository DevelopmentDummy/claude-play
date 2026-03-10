import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import { getServices } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { wsBroadcast } from "@/lib/ws-server";

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

  const dialogText = body.text
    .replace(/\$(?:IMAGE|PANEL):[^$]+\$/g, "")
    .replace(/<choice>[\s\S]*?<\/choice>/g, "")
    .trim();

  if (!dialogText) {
    return NextResponse.json({ error: "No text to synthesize" }, { status: 400 });
  }

  const prompt: Record<string, unknown> = {
    "10": {
      class_type: "AILab_Qwen3TTSLoadVoice",
      inputs: { voice_name: "", custom_path: voiceFile },
    },
    "1": {
      class_type: "AILab_Qwen3TTSVoiceClone",
      inputs: {
        target_text: dialogText,
        model_size: modelSize,
        language: lang,
        voice: ["10", 0],
        unload_models: false,
        seed: Math.floor(Math.random() * 2 ** 32),
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

  const timestamp = Date.now();
  const audioFilename = `tts-${timestamp}.mp3`;
  const outputPath = path.join(sessionDir, "audio", audioFilename);

  wsBroadcast("audio:status", { status: "generating", messageId: body.messageId });

  // Fire-and-forget
  client
    .generateTts(prompt, outputPath)
    .then((result) => {
      if (result.success) {
        const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
        wsBroadcast("audio:ready", { url, messageId: body.messageId });
      } else {
        console.error("[tts] Generation failed:", result.error);
        wsBroadcast("audio:status", { status: "error", messageId: body.messageId });
      }
    })
    .catch((err) => {
      console.error("[tts] Error:", err);
      wsBroadcast("audio:status", { status: "error", messageId: body.messageId });
    });

  return NextResponse.json({ status: "queued" });
}
