import * as fs from "fs";
import * as path from "path";

export interface EdgeTtsOptions {
  voice: string;
  rate?: string;
  pitch?: string;
  outputFormat?: string;
}

export interface EdgeTtsVoice {
  id: string;
  label: string;
  lang: string;
  gender: "F" | "M";
}

export const EDGE_TTS_VOICES: EdgeTtsVoice[] = [
  { id: "ko-KR-SunHiNeural", label: "선히 (여성)", lang: "ko", gender: "F" },
  { id: "ko-KR-InJoonNeural", label: "인준 (남성)", lang: "ko", gender: "M" },
  { id: "ko-KR-HyunsuMultilingualNeural", label: "현수 (남성, 다국어)", lang: "ko", gender: "M" },
  { id: "en-US-AriaNeural", label: "Aria (F)", lang: "en", gender: "F" },
  { id: "en-US-GuyNeural", label: "Guy (M)", lang: "en", gender: "M" },
  { id: "ja-JP-NanamiNeural", label: "七海 (女性)", lang: "ja", gender: "F" },
  { id: "ja-JP-KeitaNeural", label: "圭太 (男性)", lang: "ja", gender: "M" },
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 (女)", lang: "zh", gender: "F" },
  { id: "zh-CN-YunjianNeural", label: "云健 (男)", lang: "zh", gender: "M" },
];

const TTS_SERVER_URL = `http://127.0.0.1:${process.env.TTS_PORT || "3341"}`;

/**
 * Generate TTS audio via the standalone TTS server.
 * The TTS server runs node-edge-tts in a clean Node.js process,
 * avoiding Next.js runtime interference with ws WebSocket connections.
 */
export async function generateEdgeTts(
  text: string,
  outputPath: string,
  options: EdgeTtsOptions,
): Promise<{ success: boolean; error?: string }> {
  const t0 = Date.now();

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const res = await fetch(`${TTS_SERVER_URL}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: options.voice,
        rate: options.rate,
        pitch: options.pitch,
        outputFormat: options.outputFormat,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const elapsed = Date.now() - t0;
      console.error(`[edge-tts] Error after ${elapsed}ms:`, (err as { error: string }).error);
      return { success: false, error: (err as { error: string }).error || `HTTP ${res.status}` };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    const elapsed = Date.now() - t0;
    console.log(`[edge-tts] Generated in ${elapsed}ms: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`);

    return { success: true };
  } catch (err: unknown) {
    const elapsed = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[edge-tts] Error after ${elapsed}ms:`, message);

    if (message.includes("ECONNREFUSED")) {
      return { success: false, error: "TTS server not running (port " + (process.env.TTS_PORT || "3341") + ")" };
    }
    return { success: false, error: message };
  }
}
