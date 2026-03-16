import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { AIProvider } from "./ai-provider";
import { generateEdgeTts } from "./edge-tts-client";

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
    .replace(/\.{4,}/g, "...")
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

  // Pending event headers are persisted to pending-events.json in the session dir

  // Accumulator for assistant turn
  private segments: string[] = [];
  private tools: Array<{ name: string; input: unknown }> = [];
  private autoImageTokens = new Set<string>();
  private seenToolKeys = new Set<string>();
  private sawTextDelta = false;
  private currentBlockType = "text";
  private isCompacting = false;
  private historyId = 0;

  // TTS queue — serialize requests to avoid ENOBUFS
  private ttsQueue: Array<() => Promise<void>> = [];
  private ttsRunning = false;

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
      (filename) => this.broadcast("image:updated", { filename }),
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

  // --- Event queue (file-backed: pending-events.json) ---

  private get pendingEventsPath(): string | null {
    const dir = this.getDir();
    return dir ? path.join(dir, "pending-events.json") : null;
  }

  private readPendingEvents(): string[] {
    const fp = this.pendingEventsPath;
    if (!fp) return [];
    try {
      if (fs.existsSync(fp)) {
        return JSON.parse(fs.readFileSync(fp, "utf-8"));
      }
    } catch { /* ignore */ }
    return [];
  }

  private writePendingEvents(headers: string[]): void {
    const fp = this.pendingEventsPath;
    if (!fp) return;
    try {
      if (headers.length === 0) {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } else {
        fs.writeFileSync(fp, JSON.stringify(headers), "utf-8");
      }
    } catch { /* ignore */ }
  }

  /** Queue an event header to prepend to the next user message */
  queueEvent(header: string): void {
    const headers = this.readPendingEvents();
    headers.push(header);
    this.writePendingEvents(headers);
  }

  /** Flush all pending event headers, returning formatted string (or empty) */
  flushEvents(): string {
    const headers = this.readPendingEvents();
    if (headers.length === 0) return "";
    this.writePendingEvents([]);
    this.broadcast("event:pending", { headers: [] });
    return headers.join("\n");
  }

  /** Get current pending event headers (read-only) */
  getPendingEvents(): string[] {
    return this.readPendingEvents();
  }

  /** Clear __popups from variables.json (called on new user message) */
  clearPopups(): void {
    const dir = this.getDir();
    if (!dir) return;
    const varsPath = path.join(dir, "variables.json");
    try {
      if (!fs.existsSync(varsPath)) return;
      const vars = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
      if (!Array.isArray(vars.__popups) || vars.__popups.length === 0) return;
      vars.__popups = [];
      fs.writeFileSync(varsPath, JSON.stringify(vars, null, 2), "utf-8");
      this.panels.scheduleRender();
    } catch { /* ignore */ }
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

    // TTS for user messages (skip OOC)
    if (!ooc && text && !text.startsWith("OOC:")) {
      this.triggerTts(text, `hist-u-${this.historyId}`);
    }
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

  /** Enqueue a TTS job; jobs run sequentially to avoid ENOBUFS. */
  private triggerTts(dialogText: string, overrideMessageId?: string): void {
    if (process.env.TTS_ENABLED === "false") return;
    if (this.isBuilder) return;

    const dir = this.getDir();
    if (!dir) return;

    const voiceConfig = this.sessions.readVoiceConfig(dir);
    if (!voiceConfig?.enabled) return;

    const messageId = overrideMessageId || this.chatHistory[this.chatHistory.length - 1]?.id;
    if (!messageId) return;

    const sanitized = sanitizeTtsText(dialogText);
    const chunks = splitTtsChunks(sanitized);
    if (chunks.length === 0) return;

    const totalChunks = chunks.length;
    const chunkDelay = voiceConfig.chunkDelay ?? 1000;
    const sessionId = this.id;
    const broadcastRef = this.broadcast.bind(this);
    const provider = voiceConfig.ttsProvider || "comfyui";

    // Build the async job, then enqueue it
    const job = async (): Promise<void> => {
      if (provider === "edge") {
        const edgeVoice = voiceConfig.edgeVoice;
        if (!edgeVoice) return;

        broadcastRef("audio:status", { status: "queued", messageId, totalChunks });

        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, chunkDelay));

          const timestamp = Date.now();
          const audioFilename = `tts-${timestamp}-${i}.mp3`;
          const outputPath = path.join(dir, "audio", audioFilename);

          try {
            const result = await generateEdgeTts(chunks[i], outputPath, {
              voice: edgeVoice,
              rate: voiceConfig.edgeRate,
              pitch: voiceConfig.edgePitch,
            });
            if (result.success) {
              const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
              broadcastRef("audio:ready", { url, messageId, chunkIndex: i, totalChunks });
            } else {
              console.error(`[tts] Edge chunk ${i} failed:`, result.error);
              broadcastRef("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
            }
          } catch (err) {
            console.error(`[tts] Edge chunk ${i} error:`, err);
            broadcastRef("audio:status", { status: "error", messageId, chunkIndex: i, totalChunks });
          }
        }
      } else {
        // --- GPU Manager / Qwen3-TTS (local GPU) ---
        const voiceFile = voiceConfig.voiceFile
          ? path.join(dir, voiceConfig.voiceFile)
          : undefined;
        if (!voiceFile || !fs.existsSync(voiceFile)) return;

        const lang = voiceConfig.language || "ko";
        const modelSize = voiceConfig.modelSize || "1.7B";
        const gpuManagerUrl = `http://127.0.0.1:${process.env.GPU_MANAGER_PORT || "3342"}`;

        broadcastRef("audio:status", { status: "queued", messageId, totalChunks });

        const audioDir = path.join(dir, "audio");
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

        const TTS_BATCH_SIZE = 3;

        for (let batchStart = 0; batchStart < chunks.length; batchStart += TTS_BATCH_SIZE) {
          if (batchStart > 0) await new Promise(r => setTimeout(r, chunkDelay));

          const batch = chunks.slice(batchStart, batchStart + TTS_BATCH_SIZE);

          try {
            const res = await fetch(`${gpuManagerUrl}/tts/synthesize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chunks: batch,
                voice_file: voiceFile,
                language: lang,
                model_size: modelSize,
                batch_size: TTS_BATCH_SIZE,
              }),
            });

            if (!res.ok) {
              const err = await res.text();
              throw new Error(`GPU Manager TTS error: ${err}`);
            }

            const text = await res.text();
            const lines = text.split("\n").filter(l => l.trim());
            for (const line of lines) {
              const item = JSON.parse(line);
              const globalIdx = batchStart + item.chunk_index;
              const audioBuffer = Buffer.from(item.audio_base64, "base64");

              const timestamp = Date.now();
              const audioFilename = `tts-${timestamp}-${globalIdx}.mp3`;
              fs.writeFileSync(path.join(audioDir, audioFilename), audioBuffer);

              const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
              broadcastRef("audio:ready", { url, messageId, chunkIndex: globalIdx, totalChunks });
            }
          } catch (err) {
            console.error(`[tts] GPU Manager batch ${batchStart} error:`, err);
            for (let j = 0; j < batch.length; j++) {
              broadcastRef("audio:status", { status: "error", messageId, chunkIndex: batchStart + j, totalChunks });
            }
          }
        }
      }
    };

    this.ttsQueue.push(job);
    this.processTtsQueue();
  }

  /** Process TTS queue sequentially — one job at a time. */
  private processTtsQueue(): void {
    if (this.ttsRunning) return;
    const job = this.ttsQueue.shift();
    if (!job) return;

    this.ttsRunning = true;
    job()
      .catch((err) => console.error("[tts] Queue job error:", err))
      .finally(() => {
        this.ttsRunning = false;
        this.processTtsQueue();
      });
  }

  // --- Process event binding ---

  private bindProcessEvents(p: AIProcess): void {
    p.on("message", (d) => {
      const msg = d as Record<string, unknown>;

      // For result messages, defer broadcasting until after TTS is triggered
      // so frontend receives audio:status (ttsPlaying=true) BEFORE result (isStreaming=false)
      if (msg.type !== "result") {
        this.broadcast("claude:message", d);
      }

      if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
        this.isCompacting = true;
        this.broadcast("claude:status", "compacting");
      }

      if (msg.type === "stream_event") {
        // Compacting finished — resume streaming status
        if (this.isCompacting) {
          this.isCompacting = false;
          this.broadcast("claude:status", "streaming");
        }
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
        this.isCompacting = false;

        this.panels.reload();

        if (!isOOC && this.chatHistory.length > 0) {
          const lastMsg = this.chatHistory[this.chatHistory.length - 1];
          if (lastMsg.role === "assistant" && lastMsg.content) {
            this.triggerTts(lastMsg.content);
          }
        }

        // Broadcast result AFTER TTS trigger so frontend gets
        // audio:status (ttsPlaying=true) before result (isStreaming=false)
        this.broadcast("claude:message", d);
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
