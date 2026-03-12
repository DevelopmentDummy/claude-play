/**
 * TTS request handler — runs in plain Node context (via server.ts)
 * to avoid Next.js App Router runtime interference with ws WebSocket connections.
 */
import * as path from "path";
import * as fs from "fs";
import { getServices, getSessionManager } from "./services";
import { ComfyUIClient } from "./comfyui-client";
import { generateEdgeTts } from "./edge-tts-client";
import { wsBroadcast } from "./ws-server";

interface HandlerResult {
  status: number;
  data: unknown;
  binary?: Buffer;
}

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

function splitTtsChunks(text: string): string[] {
  return text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 1);
}

const languageMap: Record<string, string> = {
  ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
  de: "German", fr: "French", ru: "Russian", pt: "Portuguese",
  es: "Spanish", it: "Italian",
};

async function handleChatTts(body: Record<string, unknown>): Promise<HandlerResult> {
  if (!body.messageId || !body.text) {
    return { status: 400, data: { error: "Missing messageId or text" } };
  }

  const sessionId = body.sessionId as string;
  if (!sessionId) {
    return { status: 400, data: { error: "sessionId required" } };
  }

  const sm = getSessionManager();
  const sessionDir = sm.getSessionDir(sessionId);
  const voiceConfig = sm.readVoiceConfig(sessionDir);
  if (!voiceConfig?.enabled) {
    return { status: 400, data: { error: "TTS not enabled" } };
  }

  const sanitized = sanitizeTtsText(body.text as string);
  const chunks = splitTtsChunks(sanitized);

  if (chunks.length === 0) {
    return { status: 400, data: { error: "No text to synthesize" } };
  }

  const totalChunks = chunks.length;
  const messageId = body.messageId as string;
  const chunkDelay = voiceConfig.chunkDelay ?? 500;
  const provider = voiceConfig.ttsProvider || "comfyui";

  wsBroadcast("audio:status", { status: "generating", messageId, totalChunks });

  if (provider === "edge") {
    const edgeVoice = voiceConfig.edgeVoice;
    if (!edgeVoice) {
      return { status: 400, data: { error: "No Edge TTS voice configured" } };
    }

    (async () => {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, chunkDelay));

        const timestamp = Date.now();
        const audioFilename = `tts-${timestamp}-${i}.mp3`;
        const outputPath = path.join(sessionDir, "audio", audioFilename);

        try {
          const result = await generateEdgeTts(chunks[i], outputPath, {
            voice: edgeVoice,
            rate: voiceConfig.edgeRate,
            pitch: voiceConfig.edgePitch,
          });
          if (result.success) {
            const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
            wsBroadcast("audio:ready", { url, messageId, chunkIndex: i, totalChunks });
          } else {
            console.error(`[tts] Edge chunk ${i} failed:`, result.error);
            wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
          }
        } catch (err) {
          console.error(`[tts] Edge chunk ${i} error:`, err);
          wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
        }
      }
    })();
  } else {
    const voiceFile = voiceConfig.voiceFile
      ? path.join(sessionDir, voiceConfig.voiceFile)
      : undefined;
    if (!voiceFile || !fs.existsSync(voiceFile)) {
      return { status: 400, data: { error: "No voice .pt file" } };
    }

    const host = process.env.COMFYUI_HOST || "127.0.0.1";
    const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
    const client = new ComfyUIClient({ host, port }, "");

    const lang = languageMap[voiceConfig.language || "ko"] || "Korean";
    const modelSize = voiceConfig.modelSize || "1.7B";
    const seed = Math.floor(Math.random() * 2 ** 32);

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
              max_new_tokens: 512,
              repetition_penalty: 1.2,
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
  }

  return { status: 200, data: { status: "queued", totalChunks } };
}

async function handleVoiceGeneratePost(body: Record<string, unknown>, personaName: string): Promise<HandlerResult> {
  const svc = getServices();
  const personaDir = svc.sessions.getPersonaDir(personaName);

  if (!fs.existsSync(personaDir)) {
    return { status: 404, data: { error: "Persona not found" } };
  }

  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const client = new ComfyUIClient({ host, port }, "");

  const lang = languageMap[body.language as string || "ko"] || "Korean";
  const voiceConfig = svc.sessions.readVoiceConfig(personaDir);

  if (body.mode === "create-voice") {
    const refAudioPath = voiceConfig?.referenceAudio
      ? path.join(personaDir, voiceConfig.referenceAudio)
      : null;
    const hasRefAudio = refAudioPath && fs.existsSync(refAudioPath);

    let audioForVoiceLib: string;

    if (hasRefAudio) {
      audioForVoiceLib = refAudioPath;
    } else if (body.design) {
      const samplePrompt: Record<string, unknown> = {
        "1": {
          class_type: "AILab_Qwen3TTSVoiceDesign",
          inputs: {
            text: "안녕하세요. 반갑습니다. 오늘도 좋은 하루 되세요.",
            instruct: body.design,
            model_size: "1.7B",
            language: lang,
            unload_models: true,
            seed: Math.floor(Math.random() * 2 ** 32),
          },
        },
        "2": {
          class_type: "SaveAudio",
          inputs: { audio: ["1", 0], filename_prefix: "voice_sample" },
        },
      };

      const samplePath = path.join(personaDir, "voice-ref-generated.flac");
      const sampleResult = await client.generateTts(samplePrompt, samplePath);
      if (!sampleResult.success) {
        return { status: 500, data: { error: `Failed to generate voice sample: ${sampleResult.error}` } };
      }
      audioForVoiceLib = samplePath;
    } else {
      return { status: 400, data: { error: "Need either reference audio or design prompt" } };
    }

    const voiceName = personaName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const testText = "안녕하세요. 반갑습니다. 오늘도 좋은 하루 되세요.";
    const extractPrompt: Record<string, unknown> = {
      "10": { class_type: "LoadAudio", inputs: { audio: audioForVoiceLib } },
      "1": {
        class_type: "AILab_Qwen3TTSVoicesLibrary",
        inputs: {
          reference_audio: ["10", 0],
          reference_text: voiceConfig?.referenceText || "",
          model_size: voiceConfig?.modelSize || "1.7B",
          device: "auto", precision: "bf16",
          x_vector_only: !(voiceConfig?.referenceText),
          voice_name: voiceName,
          save_path: path.join(personaDir, "voice"),
          unload_models: true,
        },
      },
      "2": {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: testText, model_size: voiceConfig?.modelSize || "1.7B",
          language: lang, voice: ["1", 0], unload_models: true,
          max_new_tokens: 512, repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      },
      "3": {
        class_type: "SaveAudioMP3",
        inputs: { audio: ["2", 0], filename_prefix: "voice_test", quality: "128k" },
      },
    };

    const timestamp = Date.now();
    const testAudioFilename = `voice-test-${timestamp}.mp3`;
    const testOutputPath = path.join(personaDir, "audio", testAudioFilename);
    const result = await client.generateTts(extractPrompt, testOutputPath);

    if (!result.success) {
      return { status: 500, data: { error: `Voice generation failed: ${result.error}` } };
    }

    const ptPath = path.join(personaDir, "voice", `${voiceName}.pt`);
    if (!fs.existsSync(ptPath)) {
      return { status: 500, data: { error: "Voice .pt file was not created" } };
    }

    const updatedConfig = svc.sessions.readVoiceConfig(personaDir) || { enabled: true };
    svc.sessions.writeVoiceConfig(personaDir, {
      ...updatedConfig,
      voiceFile: `voice/${voiceName}.pt`,
    });

    return {
      status: 200,
      data: {
        ok: true,
        voiceFile: `voice/${voiceName}.pt`,
        testAudioUrl: `/api/personas/${encodeURIComponent(personaName)}/voice/generate?file=${testAudioFilename}`,
      },
    };
  } else if (body.mode === "test") {
    if (!body.text) {
      return { status: 400, data: { error: "Missing text" } };
    }

    // Edge TTS test
    if ((voiceConfig?.ttsProvider || "comfyui") === "edge") {
      const edgeVoice = voiceConfig?.edgeVoice;
      if (!edgeVoice) {
        return { status: 400, data: { error: "No Edge TTS voice configured" } };
      }
      const timestamp = Date.now();
      const audioFilename = `tts-test-${timestamp}.mp3`;
      const outputPath = path.join(personaDir, "audio", audioFilename);

      const result = await generateEdgeTts(body.text as string, outputPath, {
        voice: edgeVoice,
        rate: voiceConfig?.edgeRate,
        pitch: voiceConfig?.edgePitch,
      });
      if (!result.success) {
        return { status: 500, data: { error: result.error } };
      }
      return {
        status: 200,
        data: {
          ok: true,
          url: `/api/personas/${encodeURIComponent(personaName)}/voice/generate?file=${audioFilename}`,
        },
      };
    }

    // ComfyUI test
    const prompt: Record<string, unknown> = {};
    let ttsNode: Record<string, unknown>;

    const voiceFile = voiceConfig?.voiceFile ? path.join(personaDir, voiceConfig.voiceFile) : null;
    const hasVoiceFile = voiceFile && fs.existsSync(voiceFile);
    const refAudio = voiceConfig?.referenceAudio ? path.join(personaDir, voiceConfig.referenceAudio) : null;
    const hasRefAudio = refAudio && fs.existsSync(refAudio);

    if (hasVoiceFile) {
      prompt["10"] = { class_type: "AILab_Qwen3TTSLoadVoice", inputs: { voice_name: "", custom_path: voiceFile } };
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: body.text, model_size: voiceConfig?.modelSize || "1.7B",
          language: lang, voice: ["10", 0], unload_models: false,
          max_new_tokens: 512, repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else if (hasRefAudio) {
      prompt["10"] = { class_type: "LoadAudio", inputs: { audio: refAudio } };
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceClone",
        inputs: {
          target_text: body.text, model_size: voiceConfig?.modelSize || "1.7B",
          language: lang, reference_audio: ["10", 0], unload_models: false,
          max_new_tokens: 512, repetition_penalty: 1.2,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else if ((body.design as string) || voiceConfig?.design) {
      ttsNode = {
        class_type: "AILab_Qwen3TTSVoiceDesign",
        inputs: {
          text: body.text, instruct: (body.design as string) || voiceConfig?.design || "",
          model_size: "1.7B", language: lang, unload_models: false,
          seed: Math.floor(Math.random() * 2 ** 32),
        },
      };
    } else {
      return { status: 400, data: { error: "No voice configuration" } };
    }

    prompt["1"] = ttsNode;
    prompt["2"] = {
      class_type: "SaveAudioMP3",
      inputs: { audio: ["1", 0], filename_prefix: "tts_test", quality: "128k" },
    };

    const timestamp = Date.now();
    const audioFilename = `tts-test-${timestamp}.mp3`;
    const outputPath = path.join(personaDir, "audio", audioFilename);

    const result = await client.generateTts(prompt, outputPath);
    if (!result.success) {
      return { status: 500, data: { error: result.error } };
    }

    return {
      status: 200,
      data: {
        ok: true,
        url: `/api/personas/${encodeURIComponent(personaName)}/voice/generate?file=${audioFilename}`,
      },
    };
  }

  return { status: 400, data: { error: "Invalid mode" } };
}

function handleVoiceGenerateGet(query: Record<string, unknown>, personaName: string): HandlerResult {
  const svc = getServices();
  const personaDir = svc.sessions.getPersonaDir(personaName);

  const file = query.file as string;
  if (!file) {
    return { status: 400, data: { error: "Missing file param" } };
  }

  const safeName = path.basename(file);
  const filePath = path.join(personaDir, "audio", safeName);
  if (!fs.existsSync(filePath)) {
    return { status: 404, data: { error: "File not found" } };
  }

  return { status: 200, data: null, binary: fs.readFileSync(filePath) };
}

export async function handleTtsRequest(
  type: string,
  body: unknown,
  personaName?: string,
): Promise<HandlerResult> {
  try {
    const b = (body || {}) as Record<string, unknown>;
    switch (type) {
      case "chat-tts":
        return await handleChatTts(b);
      case "voice-generate-post":
        return await handleVoiceGeneratePost(b, personaName!);
      case "voice-generate-get":
        return handleVoiceGenerateGet(b, personaName!);
      default:
        return { status: 400, data: { error: "Unknown handler type" } };
    }
  } catch (err) {
    console.error("[tts-handler] Error:", err);
    return { status: 500, data: { error: String(err) } };
  }
}
