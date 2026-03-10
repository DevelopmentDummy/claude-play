// src/lib/tts-client.ts
import * as fs from "fs";
import * as path from "path";

interface TtsConfig {
  baseUrl: string;
}

interface TtsGenerateRequest {
  text: string;
  referenceAudio?: string;
  design?: string;
  language?: string;
  speed?: number;
  outputPath: string;
}

interface TtsResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

export class TtsClient {
  private baseUrl: string;

  constructor(config: TtsConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/tts/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { status: string };
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  async generate(req: TtsGenerateRequest): Promise<TtsResult> {
    try {
      fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });

      const res = await fetch(`${this.baseUrl}/tts/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          reference_audio: req.referenceAudio || null,
          design: req.design || null,
          language: req.language || "ko",
          speed: req.speed || 1.0,
          output_path: req.outputPath,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          success: false,
          error: `TTS server error (${res.status}): ${errText}`,
        };
      }

      const data = (await res.json()) as TtsResult;
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}

const TTS_KEY = "__claude_bridge_tts_client__";

export function getTtsClient(): TtsClient | null {
  if (process.env.TTS_ENABLED === "false") return null;

  const g = globalThis as unknown as Record<string, TtsClient>;
  if (!g[TTS_KEY]) {
    const baseUrl = process.env.TTS_URL || "http://127.0.0.1:8800";
    g[TTS_KEY] = new TtsClient({ baseUrl });
  }
  return g[TTS_KEY];
}
