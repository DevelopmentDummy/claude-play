// 세션/페르소나 dir-scoped 설정 I/O (layout/voice/options). SessionManager에서 추출(Wave 12 cluster 3).
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./data-dir";
import type { LayoutConfig } from "./session-manager";

const DEFAULT_LAYOUT: LayoutConfig = {
  panels: { position: "right", size: 380 },
  chat: { maxWidth: null, align: "stretch" },
  theme: {
    accent: "#7c6fff",
    bg: "#0f0f1a",
    surface: "#16213e",
    surfaceLight: "#1f2f50",
    userBubble: "#2a3a5e",
    assistantBubble: "#1e2d4a",
    border: "#2a3a5e",
    text: "#e8e8f0",
    textDim: "#8888a0",
  },
  customCSS: "",
};

export function readLayout(dir: string): LayoutConfig {
  const layoutPath = path.join(dir, "layout.json");
  if (!fs.existsSync(layoutPath)) return { ...DEFAULT_LAYOUT };
  try {
    const raw = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
    return {
      panels: { ...DEFAULT_LAYOUT.panels, ...(raw.panels || {}) },
      chat: { ...DEFAULT_LAYOUT.chat, ...(raw.chat || {}) },
      theme: { ...DEFAULT_LAYOUT.theme, ...(raw.theme || {}) },
      customCSS: raw.customCSS ?? DEFAULT_LAYOUT.customCSS,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Read voice.json from a directory (persona or session) */
export function readVoiceConfig(dir: string): { enabled: boolean; ttsProvider?: "comfyui" | "edge" | "local" | "voxcpm"; edgeVoice?: string; edgeRate?: string; edgePitch?: string; referenceAudio?: string; referenceText?: string; design?: string; language?: string; speed?: number; modelSize?: string; speaker?: string; voiceFile?: string; chunkDelay?: number } | null {
  const voicePath = path.join(dir, "voice.json");
  if (!fs.existsSync(voicePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(voicePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Write voice.json to a directory */
export function writeVoiceConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify(config, null, 2), "utf-8");
}

/** Read chat-options-schema.json from data dir */
export function readOptionsSchema(): Record<string, unknown>[] {
  const schemaPath = path.join(getDataDir(), "chat-options-schema.json");
  if (!fs.existsSync(schemaPath)) return [];
  try { return JSON.parse(fs.readFileSync(schemaPath, "utf-8")); } catch { return []; }
}

/** Read chat-options.json from a directory */
export function readOptions(dir: string): Record<string, unknown> {
  const optPath = path.join(dir, "chat-options.json");
  if (!fs.existsSync(optPath)) return {};
  try { return JSON.parse(fs.readFileSync(optPath, "utf-8")); } catch { return {}; }
}

/** Write chat-options.json to a directory */
export function writeOptions(dir: string, options: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "chat-options.json"), JSON.stringify(options, null, 2), "utf-8");
}
