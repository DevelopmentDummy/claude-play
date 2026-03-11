import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { AIProvider } from "./ai-provider";
import { ComfyUIClient } from "./comfyui-client";

// --- Constants & helpers (extracted from services.ts) ---

const DIALOG_OPEN = "<dialog_response>";
const DIALOG_CLOSE = "</dialog_response>";
const SPECIAL_TOKEN_REGEX = /\$(?:IMAGE|PANEL):[^$]+\$/g;
const CHOICE_OPEN = "<choice>";
const CHOICE_CLOSE = "</choice>";
const HISTORY_FILE = "chat-history.json";

function extractSpecialTokens(raw: string): string[] {
  const matches = raw.match(SPECIAL_TOKEN_REGEX) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of matches) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function sanitizeFilename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function detectImageToken(toolName: string, input: unknown): string | null {
  const imageToolNames = new Set([
    "mcp__claude_bridge__generate_image",
    "mcp__claude_bridge__generate_image_gemini",
    "mcp__claude_bridge__comfyui_generate",
    "mcp__claude_bridge__gemini_generate",
  ]);
  if (!imageToolNames.has(toolName)) return null;
  if (!input || typeof input !== "object") return null;

  const body = input as Record<string, unknown>;
  const fromPath = typeof body.path === "string" ? body.path.trim() : "";
  if (fromPath.startsWith("images/")) {
    return `$IMAGE:${fromPath}$`;
  }

  const filename = typeof body.filename === "string" ? sanitizeFilename(body.filename) : "";
  if (!filename) return null;
  return `$IMAGE:images/${filename}$`;
}

function toolUseKey(name: string, input: unknown): string {
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:${String(input)}`;
  }
}

function extractChoiceBlock(raw: string): string | null {
  const openIdx = raw.lastIndexOf(CHOICE_OPEN);
  if (openIdx === -1) return null;
  const closeIdx = raw.indexOf(CHOICE_CLOSE, openIdx);
  if (closeIdx === -1) return null;
  return raw.substring(openIdx, closeIdx + CHOICE_CLOSE.length);
}

function extractDialog(raw: string): string {
  const parts: string[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = raw.indexOf(DIALOG_OPEN, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + DIALOG_OPEN.length;
    const closeIdx = raw.indexOf(DIALOG_CLOSE, contentStart);
    if (closeIdx !== -1) {
      parts.push(raw.substring(contentStart, closeIdx).trim());
      searchFrom = closeIdx + DIALOG_CLOSE.length;
    } else {
      parts.push(raw.substring(contentStart).trim());
      break;
    }
  }

  if (parts.length > 0) {
    const base = parts.join("\n\n").trim();
    const extras: string[] = [];
    const tokens = extractSpecialTokens(raw).filter((token) => !base.includes(token));
    extras.push(...tokens);
    const choiceBlock = extractChoiceBlock(raw);
    if (choiceBlock && !base.includes(CHOICE_OPEN)) {
      extras.push(choiceBlock);
    }
    if (extras.length === 0) return base;
    return `${base}\n\n${extras.join("\n")}`;
  }

  return raw;
}

// --- Exports ---

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
  ooc?: boolean;
}

export type AIProcess = ClaudeProcess | CodexProcess;

export type BroadcastFn = (
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean; exclude?: unknown }
) => void;

function createProcess(provider: AIProvider): AIProcess {
  return provider === "codex" ? new CodexProcess() : new ClaudeProcess();
}

// --- TTS helpers ---

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
  const lines = text.split(/\n+/).map(s => s.trim()).filter(s => s.length > 1);
  const chunks: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (buf.length === 0) {
      buf = line;
    } else if ((buf + " " + line).length <= 60) {
      buf += " " + line;
    } else {
      chunks.push(buf);
      buf = line;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

function buildTtsPrompt(
  text: string, voiceFile: string, lang: string, modelSize: string, seed: number
): Record<string, unknown> {
  return {
    "10": {
      class_type: "AILab_Qwen3TTSLoadVoice",
      inputs: { voice_name: "", custom_path: voiceFile },
    },
    "1": {
      class_type: "AILab_Qwen3TTSVoiceClone",
      inputs: {
        target_text: text,
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
}

// --- SessionInstance ---

export class SessionInstance {
  readonly id: string;
  readonly isBuilder: boolean;
  isOOC = false;
  chatHistory: HistoryMessage[] = [];

  private _process: AIProcess;
  private _provider: AIProvider;
  readonly panels: PanelEngine;
  readonly sessions: SessionManager;
  private readonly broadcastFn: BroadcastFn;

  // Accumulator for assistant turn
  private segments: string[] = [];
  private tools: Array<{ name: string; input: unknown }> = [];
  private autoImageTokens = new Set<string>();
  private seenToolKeys = new Set<string>();
  private sawTextDelta = false;
  private currentBlockType = "text";
  private historyId = 0;

  constructor(
    id: string,
    isBuilder: boolean,
    provider: AIProvider,
    sessions: SessionManager,
    broadcastFn: BroadcastFn,
  ) {
    this.id = id;
    this.isBuilder = isBuilder;
    this._provider = provider;
    this.sessions = sessions;
    this.broadcastFn = broadcastFn;

    this._process = createProcess(provider);

    this.panels = new PanelEngine(
      (update) => this.broadcast("panels:update", update),
      () => {
        const dir = this.getDir();
        if (dir) {
          this.broadcast("layout:update", { layout: sessions.readLayout(dir) });
        }
      },
    );

    this.bindProcessEvents(this._process);
  }

  // --- Accessors ---

  get claude(): AIProcess { return this._process; }
  get provider(): AIProvider { return this._provider; }

  /** Resolve the working directory for this instance */
  getDir(): string | null {
    try {
      if (this.isBuilder) return this.sessions.getPersonaDir(this.id);
      return this.sessions.getSessionDir(this.id);
    } catch {
      return null;
    }
  }

  /** Broadcast scoped to this session */
  broadcast(event: string, data: unknown): void {
    if (this.isBuilder) {
      this.broadcastFn(event, data, { sessionId: this.id, isBuilder: true });
    } else {
      this.broadcastFn(event, data, { sessionId: this.id });
    }
  }

  // --- History ---

  addUserToHistory(text: string, ooc?: boolean): void {
    this.chatHistory.push({
      id: `hist-u-${++this.historyId}`,
      role: "user",
      content: text,
      ooc: ooc || undefined,
    });
    this.saveHistory();
  }

  addOpeningToHistory(text: string): void {
    this.chatHistory.push({
      id: `hist-a-${++this.historyId}`,
      role: "assistant",
      content: text,
    });
    this.saveHistory();
  }

  clearHistory(): void {
    this.chatHistory = [];
    this.segments = [];
    this.tools = [];
    this.autoImageTokens.clear();
    this.seenToolKeys.clear();
    this.sawTextDelta = false;
    const dir = this.getDir();
    if (dir) {
      const fp = path.join(dir, HISTORY_FILE);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  }

  loadHistory(): void {
    const dir = this.getDir();
    if (!dir) { this.chatHistory = []; return; }
    const fp = path.join(dir, HISTORY_FILE);
    try {
      if (fs.existsSync(fp)) {
        this.chatHistory = JSON.parse(fs.readFileSync(fp, "utf-8"));
        this.historyId = this.chatHistory.length;
      } else {
        this.chatHistory = [];
      }
    } catch {
      this.chatHistory = [];
    }
  }

  saveHistory(): void {
    const dir = this.getDir();
    if (!dir) return;
    try {
      fs.writeFileSync(
        path.join(dir, HISTORY_FILE),
        JSON.stringify(this.chatHistory),
        "utf-8"
      );
    } catch { /* ignore */ }
  }

  // --- Provider ---

  switchProvider(newProvider: AIProvider): void {
    if (newProvider === this._provider) return;
    this._process.kill();
    this._process.removeAllListeners();
    this._provider = newProvider;
    this._process = createProcess(newProvider);
    this.bindProcessEvents(this._process);
  }

  // --- Accumulator helpers ---

  private addToolUse(toolName: string, input: unknown): void {
    const key = toolUseKey(toolName, input);
    if (this.seenToolKeys.has(key)) return;
    this.seenToolKeys.add(key);

    this.tools.push({ name: toolName, input });
    const imageToken = detectImageToken(toolName, input);
    if (imageToken && !this.autoImageTokens.has(imageToken)) {
      this.autoImageTokens.add(imageToken);
      const joined = this.segments.join("");
      if (!joined.includes(imageToken)) {
        this.segments.push(`\n${imageToken}\n`);
      }
    }
  }

  // --- TTS ---

  private triggerTts(dialogText: string): void {
    if (process.env.TTS_ENABLED === "false") return;
    if (this.isBuilder) return;

    const dir = this.getDir();
    if (!dir) return;

    const voiceConfig = this.sessions.readVoiceConfig(dir);
    if (!voiceConfig?.enabled) return;

    const messageId = this.chatHistory[this.chatHistory.length - 1]?.id;
    if (!messageId) return;

    const languageMap: Record<string, string> = {
      ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
      de: "German", fr: "French", ru: "Russian", pt: "Portuguese",
      es: "Spanish", it: "Italian",
    };
    const lang = languageMap[voiceConfig.language || "ko"] || "Korean";
    const modelSize = voiceConfig.modelSize || "1.7B";

    const voiceFile = voiceConfig.voiceFile
      ? path.join(dir, voiceConfig.voiceFile)
      : undefined;
    if (!voiceFile || !fs.existsSync(voiceFile)) return;

    const sanitized = sanitizeTtsText(dialogText);
    const chunks = splitTtsChunks(sanitized);
    if (chunks.length === 0) return;

    const totalChunks = chunks.length;
    const chunkDelay = voiceConfig.chunkDelay ?? 1000;
    const seed = Math.floor(Math.random() * 2 ** 32);
    this.broadcast("audio:status", { status: "queued", messageId, totalChunks });

    const host = process.env.COMFYUI_HOST || "127.0.0.1";
    const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
    const client = new ComfyUIClient({ host, port }, "");
    const sessionId = this.id;
    const broadcastRef = this.broadcast.bind(this);

    (async () => {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, chunkDelay));

        const timestamp = Date.now();
        const audioFilename = `tts-${timestamp}-${i}.mp3`;
        const outputPath = path.join(dir, "audio", audioFilename);
        const prompt = buildTtsPrompt(chunks[i], voiceFile, lang, modelSize, seed);

        try {
          const result = await client.generateTts(prompt, outputPath);
          if (result.success) {
            const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
            broadcastRef("audio:ready", { url, messageId, chunkIndex: i, totalChunks });
          } else {
            console.error(`[tts] Chunk ${i} failed:`, result.error);
            broadcastRef("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
          }
        } catch (err) {
          console.error(`[tts] Chunk ${i} error:`, err);
          broadcastRef("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
        }
      }
    })();
  }

  // --- Process event binding ---

  private bindProcessEvents(p: AIProcess): void {
    p.on("message", (d) => {
      this.broadcast("claude:message", d);

      const msg = d as Record<string, unknown>;

      if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
        this.broadcast("claude:status", "compacting");
      }

      if (msg.type === "stream_event") {
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) return;
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          this.currentBlockType = (block?.type as string) || "text";
          if (block?.type === "tool_use") {
            this.addToolUse(block.name as string, block.input);
          }
        }
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && this.currentBlockType === "text") {
            this.sawTextDelta = true;
            this.segments.push(delta.text);
          }
        }
        if (event.type === "content_block_stop") {
          this.currentBlockType = "text";
        }
      }

      if (msg.type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) return;
        if (typeof message.content === "string") {
          if (!this.sawTextDelta) {
            this.segments.push(message.content);
          }
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              if (!this.sawTextDelta && typeof b.text === "string") {
                this.segments.push(b.text);
              }
            } else if (b.type === "tool_use") {
              this.addToolUse(b.name as string, b.input);
            }
          }
        }
      }

      if (msg.type === "result") {
        const isOOC = this.isOOC;
        if (this.segments.length > 0 || this.tools.length > 0) {
          const rawContent = this.segments.join("");
          const dialogContent = isOOC ? rawContent : extractDialog(rawContent);
          if (dialogContent) {
            this.chatHistory.push({
              id: `hist-a-${++this.historyId}`,
              role: "assistant",
              content: dialogContent,
              tools: this.tools.length > 0 ? [...this.tools] : undefined,
              ooc: isOOC || undefined,
            });
          }
        } else if (msg.result) {
          const result = msg.result as Record<string, unknown>;
          const text =
            typeof result === "string" ? result
            : typeof result.text === "string" ? result.text
            : null;
          if (text) {
            this.chatHistory.push({
              id: `hist-a-${++this.historyId}`,
              role: "assistant",
              content: text as string,
              ooc: isOOC || undefined,
            });
          }
        }
        this.saveHistory();

        const lastSaved = this.chatHistory[this.chatHistory.length - 1];
        if (lastSaved) {
          this.broadcast("claude:messageId", { messageId: lastSaved.id });
        }

        this.isOOC = false;
        this.segments = [];
        this.tools = [];
        this.autoImageTokens.clear();
        this.seenToolKeys.clear();
        this.sawTextDelta = false;
        this.currentBlockType = "text";

        this.panels.reload();

        if (!isOOC && this.chatHistory.length > 0) {
          const lastMsg = this.chatHistory[this.chatHistory.length - 1];
          if (lastMsg.role === "assistant" && lastMsg.content) {
            this.triggerTts(lastMsg.content);
          }
        }
      }
    });

    p.on("error", (e) => this.broadcast("claude:error", e));
    p.on("status", (s) => this.broadcast("claude:status", s));
    p.on("exit", () => this.broadcast("claude:status", "disconnected"));

    p.on("sessionId", (sessionId: string) => {
      try {
        if (this.isBuilder) {
          this.sessions.saveBuilderSession(this.id, this._provider, sessionId);
        } else {
          if (this._provider === "codex") {
            this.sessions.saveCodexThreadId(this.id, sessionId);
          } else {
            this.sessions.saveClaudeSessionId(this.id, sessionId);
          }
        }
      } catch (err) {
        console.error("[SessionInstance] ERROR saving sessionId:", err);
      }
    });
  }

  // --- Lifecycle ---

  destroy(): void {
    this._process.kill();
    this._process.removeAllListeners();
    this.panels.stop();
  }
}
