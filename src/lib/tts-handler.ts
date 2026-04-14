/**
 * TTS request handler — runs in plain Node context (via server.ts)
 * to avoid Next.js App Router runtime interference with ws WebSocket connections.
 */
import * as path from "path";
import * as fs from "fs";
import { getServices, getSessionManager } from "./services";
import { generateEdgeTts } from "./edge-tts-client";
import { wsBroadcast } from "./ws-server";

const GPU_MANAGER_URL = `http://127.0.0.1:${process.env.GPU_MANAGER_PORT || "3342"}`;

async function gpuManagerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${GPU_MANAGER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Synthesize via GPU Manager — sends all chunks as a batch,
 * receives NDJSON stream of {chunk_index, total, audio_base64}.
 */
async function synthesizeViaGpuManager(
  chunks: string[],
  voiceFile: string,
  language: string,
  modelSize: string,
  provider: string,
): Promise<Array<{ chunkIndex: number; audioBuffer: Buffer }>> {
  const res = await fetch(`${GPU_MANAGER_URL}/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chunks,
      voice_file: voiceFile,
      language,
      model_size: modelSize,
      provider,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 503) {
      let msg = err;
      try { msg = JSON.parse(err)?.detail || err; } catch { /* ignore */ }
      throw new Error(`503:${msg}`);
    }
    throw new Error(`GPU Manager TTS error: ${err}`);
  }

  const text = await res.text();
  const results: Array<{ chunkIndex: number; audioBuffer: Buffer }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    results.push({
      chunkIndex: item.chunk_index,
      audioBuffer: Buffer.from(item.audio_base64, "base64"),
    });
  }
  return results;
}

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
    .replace(/\.{4,}/g, "...")
    .replace(/["""""]/g, "")
    .trim();
}

function splitTtsChunks(text: string, maxLen = 150): string[] {
  // Split by newlines first, then break long lines by sentence boundaries
  const lines = text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 1);
  const sentences: string[] = [];
  for (const line of lines) {
    if (line.length <= maxLen) {
      sentences.push(line);
    } else {
      // Split on sentence-ending punctuation followed by space or end
      const parts = line.split(/(?<=[.!?。！？…~]+)\s*/);
      for (const p of parts) {
        if (p.trim()) sentences.push(p.trim());
      }
    }
  }
  // Merge short sentences up to maxLen
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (!buf) {
      buf = s;
    } else if ((buf + " " + s).length <= maxLen) {
      buf += " " + s;
    } else {
      chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function handleChatTts(body: Record<string, unknown>): Promise<HandlerResult> {
  if (!body.messageId || !body.text) {
    return { status: 400, data: { error: "Missing messageId or text" } };
  }

  const rawSessionId = body.sessionId as string;
  if (!rawSessionId) {
    return { status: 400, data: { error: "sessionId required" } };
  }
  const sessionId = decodeURIComponent(rawSessionId);

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
  const isLocalTts = provider === "local" || provider === "comfyui" || provider === "voxcpm";

  const wsFilter = { sessionId };
  wsBroadcast("audio:status", { status: "generating", messageId, totalChunks }, wsFilter);

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
            wsBroadcast("audio:ready", { url, messageId, chunkIndex: i, totalChunks }, wsFilter);
          } else {
            console.error(`[tts] Edge chunk ${i} failed:`, result.error);
            wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks }, wsFilter);
          }
        } catch (err) {
          console.error(`[tts] Edge chunk ${i} error:`, err);
          wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks }, wsFilter);
        }
      }
    })();
  } else if (isLocalTts) {
    const voiceFile = voiceConfig.voiceFile
      ? path.join(sessionDir, voiceConfig.voiceFile)
      : undefined;
    if (!voiceFile || !fs.existsSync(voiceFile)) {
      return { status: 400, data: { error: "No voice .pt file" } };
    }

    const lang = voiceConfig.language || "ko";
    const gpuProvider = provider === "voxcpm" ? "voxcpm" : "qwen3";
    const modelSize = voiceConfig.modelSize || "1.7B";

    const audioDir = path.join(sessionDir, "audio");
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    const TTS_BATCH_SIZE = 3;

    (async () => {
      for (let batchStart = 0; batchStart < chunks.length; batchStart += TTS_BATCH_SIZE) {
        if (batchStart > 0) await new Promise(r => setTimeout(r, chunkDelay));

        const batch = chunks.slice(batchStart, batchStart + TTS_BATCH_SIZE);
        try {
          const results = await synthesizeViaGpuManager(batch, voiceFile, lang, modelSize, gpuProvider);
          for (const { chunkIndex, audioBuffer } of results) {
            const globalIdx = batchStart + chunkIndex;
            const timestamp = Date.now();
            const audioFilename = `tts-${timestamp}-${globalIdx}.mp3`;
            fs.writeFileSync(path.join(audioDir, audioFilename), audioBuffer);

            const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
            wsBroadcast("audio:ready", { url, messageId, chunkIndex: globalIdx, totalChunks }, wsFilter);
          }
        } catch (err) {
          const errMsg = String(err);
          console.error(`[tts] GPU Manager batch ${batchStart} error:`, errMsg);
          const is503 = errMsg.startsWith("Error: 503:");
          const errorDetail = is503 ? errMsg.replace("Error: 503:", "").trim() : undefined;
          for (let j = 0; j < batch.length; j++) {
            wsBroadcast("audio:status", { status: "error", messageId, chunkIndex: batchStart + j, totalChunks, ...(errorDetail ? { errorDetail } : {}) }, wsFilter);
          }
          if (is503) break;
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

  const voiceConfig = svc.sessions.readVoiceConfig(personaDir);
  const voiceProvider = voiceConfig?.ttsProvider || "comfyui";
  const isLocalProvider = voiceProvider === "local" || voiceProvider === "comfyui" || voiceProvider === "voxcpm";

  if (body.mode === "create-voice") {
    if (!isLocalProvider) {
      return { status: 400, data: { error: "Voice creation requires local TTS provider" } };
    }

    const refAudioPath = voiceConfig?.referenceAudio
      ? path.join(personaDir, voiceConfig.referenceAudio)
      : null;
    const hasRefAudio = refAudioPath && fs.existsSync(refAudioPath);

    if (!hasRefAudio && !body.design) {
      return { status: 400, data: { error: "Need either reference audio or design prompt" } };
    }

    const voiceName = personaName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const gpuProvider = voiceProvider === "voxcpm" ? "voxcpm" : "qwen3";
    const voiceExt = gpuProvider === "voxcpm" ? "voxcpm.wav" : "pt";
    const outputPath = path.join(personaDir, "voice", `${voiceName}.${voiceExt}`);

    const payload: Record<string, unknown> = {
      output_path: outputPath,
      model_size: voiceConfig?.modelSize || (gpuProvider === "voxcpm" ? "2B" : "1.7B"),
      language: voiceConfig?.language || "ko",
      provider: gpuProvider,
    };

    if (hasRefAudio) {
      payload.mode = "reference";
      payload.reference_audio = refAudioPath;
      payload.reference_text = voiceConfig?.referenceText || "";
    } else {
      payload.mode = "design";
      payload.design_prompt = body.design;
    }

    const res = await fetch(`${GPU_MANAGER_URL}/tts/create-voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      if (res.status === 503) {
        let msg = err;
        try { msg = JSON.parse(err)?.detail || err; } catch { /* ignore */ }
        return { status: 503, data: { error: msg } };
      }
      return { status: 500, data: { error: `Voice creation failed: ${err}` } };
    }

    const result = await res.json() as { success: boolean; voice_file: string; sample_audio: string };
    if (!result.success) {
      return { status: 500, data: { error: "Voice creation failed" } };
    }

    // Save sample audio for preview
    const audioDir = path.join(personaDir, "audio");
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    const timestamp = Date.now();
    const testAudioFilename = `voice-test-${timestamp}.mp3`;
    fs.writeFileSync(
      path.join(audioDir, testAudioFilename),
      Buffer.from(result.sample_audio, "base64"),
    );

    const updatedConfig = svc.sessions.readVoiceConfig(personaDir) || { enabled: true };
    svc.sessions.writeVoiceConfig(personaDir, {
      ...updatedConfig,
      voiceFile: `voice/${voiceName}.${voiceExt}`,
    });

    return {
      status: 200,
      data: {
        ok: true,
        voiceFile: `voice/${voiceName}.${voiceExt}`,
        testAudioUrl: `/api/personas/${encodeURIComponent(personaName)}/voice/generate?file=${testAudioFilename}`,
      },
    };
  } else if (body.mode === "test") {
    if (!body.text) {
      return { status: 400, data: { error: "Missing text" } };
    }

    // Edge TTS test
    if (voiceProvider === "edge") {
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

    // Local TTS test via GPU Manager
    const voiceFile = voiceConfig?.voiceFile ? path.join(personaDir, voiceConfig.voiceFile) : null;
    if (!voiceFile || !fs.existsSync(voiceFile)) {
      return { status: 400, data: { error: "No voice .pt file — create a voice first" } };
    }

    const audioDir = path.join(personaDir, "audio");
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    const gpuProvider = voiceProvider === "voxcpm" ? "voxcpm" : "qwen3";
    const results = await synthesizeViaGpuManager(
      [body.text as string],
      voiceFile,
      voiceConfig?.language || "ko",
      voiceConfig?.modelSize || (gpuProvider === "voxcpm" ? "2B" : "1.7B"),
      gpuProvider,
    );

    if (results.length === 0) {
      return { status: 500, data: { error: "TTS synthesis returned no audio" } };
    }

    const timestamp = Date.now();
    const audioFilename = `tts-test-${timestamp}.mp3`;
    fs.writeFileSync(path.join(audioDir, audioFilename), results[0].audioBuffer);

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
