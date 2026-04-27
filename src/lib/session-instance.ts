import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { GeminiProcess } from "./gemini-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { AIProvider } from "./ai-provider";
import { generateEdgeTts } from "./edge-tts-client";
import { buildHintSnapshotLine } from "./hint-snapshot";

// --- Constants & helpers (extracted from services.ts) ---

/** Character-level merge of two versions of the same text for UTF-8 healing. */
function mergeUtf8Texts(a: string, b: string): string {
  const charsA = Array.from(a);
  const charsB = Array.from(b);
  if (charsA.length !== charsB.length) {
    const countA = charsA.filter(c => c === "\ufffd").length;
    const countB = charsB.filter(c => c === "\ufffd").length;
    return countB < countA ? b : a;
  }
  let merged = false;
  const result = charsA.map((ca, i) => {
    const cb = charsB[i];
    if (ca === "\ufffd" && cb !== "\ufffd") { merged = true; return cb; }
    return ca;
  });
  return merged ? result.join("") : a;
}

const DIALOG_OPEN = "<dialog_response>";
const DIALOG_CLOSE = "</dialog_response>";
const SPECIAL_TOKEN_REGEX = /\$(?:IMAGE|PANEL):[^$]+\$/g;
const CHOICE_OPEN = "<choice>";
const CHOICE_CLOSE = "</choice>";

/** Event-header prefixes that should be replaced (singleton semantics) rather than accumulated.
 *  Prefixes NOT in this set accumulate — multiple [TIME] lines, multiple [EVENT] lines, etc.
 *  Keep this list tight; default behavior is append. */
const REPLACE_ONLY_PREFIXES = new Set<string>([
  "[SCHEDULE_SET]",
  "[SCHEDULE_ERROR]",
  "[NEW_GAME]",
  "[MODE]",
]);
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

export interface ActionRecord {
  panel: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
  ooc?: boolean;
}

export type AIProcess = ClaudeProcess | CodexProcess | GeminiProcess;

export type BroadcastFn = (
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean; exclude?: unknown }
) => void;

function createProcess(provider: AIProvider): AIProcess {
  if (provider === "codex") return new CodexProcess();
  if (provider === "gemini") return new GeminiProcess();
  return new ClaudeProcess();
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
  private assistantFullText: string | null = null; // full text from assistant message (for UTF-8 healing)
  private tools: Array<{ name: string; input: unknown }> = [];

  private seenToolKeys = new Set<string>();
  private sawTextDelta = false;
  private currentBlockType = "text";
  private pushedTextsByMsgId = new Map<string, Set<string>>();
  private isCompacting = false;
  private isSlashCommand = false;
  private historyId = 0;
  private destroyed = false;

  // Subagent task tracking: hold result until all spawned tasks complete
  private pendingTaskCount = 0;
  private heldResultMsg: unknown = null;
  private resultFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Scheduler notification: track whether AI is mid-turn
  private _pendingTurn = false;
  private idleResolvers: Array<() => void> = [];

  // TTS queue — serialize requests to avoid ENOBUFS
  private ttsQueue: Array<() => Promise<void>> = [];
  private ttsRunning = false;
  /** Client-side TTS toggle — when false, skip TTS generation even if voice.json is configured */
  ttsAutoPlay = true;

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
    if (this.destroyed) return;
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

  /** Queue an event header to prepend to the next user message.
   *  Headers accumulate by default — multiple events with the same prefix are all kept
   *  (e.g., multiple [TIME] +1h lines from a chain of actions stay as separate lines).
   *  Prefixes in REPLACE_ONLY_PREFIXES are treated as singletons: the latest call overrides
   *  any prior one with the same prefix (e.g., [SCHEDULE_SET] always reflects the last state).
   *  Exact-match duplicates are always collapsed. */
  queueEvent(header: string): void {
    let headers = this.readPendingEvents();
    // Dedup exact duplicates (defensive, e.g., double-click)
    headers = headers.filter(h => h !== header);
    const prefixMatch = header.match(/^\[([^\]]+)\]/);
    if (prefixMatch && REPLACE_ONLY_PREFIXES.has(prefixMatch[0])) {
      headers = headers.filter(h => !h.startsWith(prefixMatch[0]));
    }
    headers.push(header);
    this.writePendingEvents(headers);
  }

  /** Whether the AI is currently processing a turn (streaming, tool use, etc.) */
  isBusy(): boolean {
    return this._pendingTurn;
  }

  /** Wait until AI finishes current turn. Resolves immediately if idle. */
  waitForIdle(): Promise<void> {
    if (!this._pendingTurn) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  /** Reset pending turn state and resolve all idle waiters. */
  private flushIdleWaiters(): void {
    this._pendingTurn = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }

  /** Send a message to AI from server-side, triggering a new turn.
   *  If AI is mid-turn, waits for completion first (up to 60s timeout). */
  async sendMessage(text: string): Promise<void> {
    if (!this.claude.isRunning()) {
      console.warn(`[session:${this.id}] sendMessage skipped — AI process not running`);
      return;
    }
    // Wait for idle with timeout
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[session:${this.id}] sendMessage waitForIdle timed out (60s), sending anyway`);
        resolve();
      }, 60_000);
      timer.unref?.();
      this.waitForIdle().then(() => { clearTimeout(timer); resolve(); });
    });
    await timeout;

    if (!this.claude.isRunning() || this.destroyed) {
      console.warn(`[session:${this.id}] sendMessage skipped — AI process died during wait`);
      return;
    }

    const eventHeaders = this.flushEvents();
    const hintSnapshot = this.buildHintSnapshot();
    const actionHistory = this.flushActions();
    const jsonLint = this.buildJsonLint();
    const parts = [eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
    this._pendingTurn = true;
    this.claude.send(parts.join("\n"));
  }

  /** Send raw text to the AI process, marking turn as pending. */
  sendToAI(text: string): void {
    this._pendingTurn = true;
    this.claude.send(text);
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

  // --- Action history queue ---

  private get pendingActionsPath(): string | null {
    const dir = this.getDir();
    return dir ? path.join(dir, "pending-actions.json") : null;
  }

  private readPendingActions(): ActionRecord[] {
    const fp = this.pendingActionsPath;
    if (!fp) return [];
    try {
      if (fs.existsSync(fp)) {
        return JSON.parse(fs.readFileSync(fp, "utf-8"));
      }
    } catch { /* ignore */ }
    return [];
  }

  private writePendingActions(actions: ActionRecord[]): void {
    const fp = this.pendingActionsPath;
    if (!fp) return;
    try {
      if (actions.length === 0) {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } else {
        fs.writeFileSync(fp, JSON.stringify(actions), "utf-8");
      }
    } catch { /* ignore */ }
  }

  queueAction(record: ActionRecord): void {
    const actions = this.readPendingActions();
    actions.push(record);
    this.writePendingActions(actions);
  }

  /** Remove the most recent pending action matching panel+action. Returns true if removed. */
  removeLastAction(panel: string, action: string): boolean {
    const actions = this.readPendingActions();
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].panel === panel && actions[i].action === action) {
        actions.splice(i, 1);
        this.writePendingActions(actions);
        return true;
      }
    }
    return false;
  }

  flushActions(): string {
    const actions = this.readPendingActions();
    if (actions.length === 0) return "";
    this.writePendingActions([]);
    return actions
      .map(a => {
        const paramsStr = a.params && Object.keys(a.params).length > 0
          ? `(${Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(", ")})`
          : "";
        return `[ACTION_LOG] ${a.panel}.${a.action}${paramsStr}`;
      })
      .join("\n");
  }

  getPendingActions(): ActionRecord[] {
    return this.readPendingActions();
  }

  buildHintSnapshot(): string {
    const dir = this.getDir();
    if (!dir) return "";
    return buildHintSnapshotLine(dir);
  }

  /** Lint all non-system JSON files in session dir. Returns warning string or empty. */
  buildJsonLint(): string {
    const dir = this.getDir();
    if (!dir) return "";
    const SYSTEM_JSON = new Set([
      "session.json", "builder-session.json", "layout.json",
      "chat-history.json", "pending-events.json", "pending-actions.json",
      "package.json", "tsconfig.json", "chat-options.json",
    ]);
    const errors: string[] = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) continue;
        const fp = path.join(dir, f);
        try {
          const raw = fs.readFileSync(fp, "utf-8");
          JSON.parse(raw);
        } catch (e) {
          const msg = e instanceof SyntaxError ? e.message : String(e);
          errors.push(`${f}: ${msg}`);
        }
      }
    } catch { /* dir read error — skip */ }
    if (errors.length === 0) return "";
    return `[JSON_LINT] 다음 JSON 파일에 구문 오류가 있습니다. 즉시 수정하세요:\n${errors.map(e => `  - ${e}`).join("\n")}`;
  }

  /**
   * Run session hooks/on-message.js if it exists.
   * Called before building hint snapshot so hooks can massage data.
   * Hook receives { variables, data, sessionDir, message } and may return
   * { variables?: patch, data?: { filename: patch } } to apply changes.
   */
  runMessageHooks(messageText: string): void {
    const dir = this.getDir();
    if (!dir) return;
    const hookPath = path.join(dir, "hooks", "on-message.js");
    if (!fs.existsSync(hookPath)) return;

    try {
      // Build context (same pattern as tools)
      const varsPath = path.join(dir, "variables.json");
      let variables: Record<string, unknown> = {};
      try { variables = JSON.parse(fs.readFileSync(varsPath, "utf-8")); } catch {}

      const SYSTEM_JSON = new Set([
        "variables.json", "session.json", "builder-session.json", "layout.json",
        "chat-history.json", "pending-events.json", "pending-actions.json",
        "package.json", "tsconfig.json", "voice.json", "chat-options.json",
      ]);
      const data: Record<string, unknown> = {};
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith(".json") && !SYSTEM_JSON.has(f)) {
            try { data[f.replace(".json", "")] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch {}
          }
        }
      } catch {}

      // eslint-disable-next-line no-eval
      const nativeRequire = eval("require") as NodeRequire;
      delete nativeRequire.cache[hookPath];
      const mod = nativeRequire(hookPath);
      const fn = typeof mod === "function" ? mod : mod.default;
      if (typeof fn !== "function") return;

      const result = fn({ variables: { ...variables }, data, sessionDir: dir, message: messageText });
      if (!result || typeof result !== "object") return;

      // Apply variable patches
      if (result.variables && typeof result.variables === "object") {
        const current = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
        const merged = { ...current, ...result.variables };
        fs.writeFileSync(varsPath, JSON.stringify(merged, null, 2), "utf-8");
      }

      // Apply data file patches
      if (result.data && typeof result.data === "object") {
        for (const [rawKey, patch] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
          if (!patch || typeof patch !== "object") continue;
          const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
          if (SYSTEM_JSON.has(fileName)) continue;
          const filePath = path.join(dir, fileName);
          let current: Record<string, unknown> = {};
          try { if (fs.existsSync(filePath)) current = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {}
          fs.writeFileSync(filePath, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
        }
      }
    } catch (err) {
      console.error("[hooks/on-message] error:", err);
    }
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

  /** Send a slash command (e.g. /compact, /context) — result skips history & TTS.
   *  Only supported for Claude provider. */
  sendSlashCommand(command: string): void {
    if (this._provider !== "claude") return;
    if (!this.claude.isRunning()) return;
    this.isSlashCommand = true;
    this._pendingTurn = true;
    this.claude.send(`/${command}`);
  }

  addOpeningToHistory(text: string): void {
    this.chatHistory.push({
      id: `hist-a-${++this.historyId}`,
      role: "assistant",
      content: text,
    });
    this.saveHistory();
  }

  /** Kill the AI process and save any partial assistant response accumulated so far. */
  cancelStreaming(): void {
    const partial = this.segments.join("");

    // Kill the process
    this._process.kill();

    // Save partial response to history if any text was accumulated
    if (partial) {
      this.chatHistory.push({
        id: `hist-a-${++this.historyId}`,
        role: "assistant",
        content: partial,
      });
      this.saveHistory();
    }

    // Reset accumulator state
    this.segments = [];
    this.assistantFullText = null;
    this.tools = [];
    this.seenToolKeys.clear();
    this.sawTextDelta = false;
    this.currentBlockType = "text";
    this.pushedTextsByMsgId.clear();
    this.isCompacting = false;
    if (this.resultFinalizeTimer) { clearTimeout(this.resultFinalizeTimer); this.resultFinalizeTimer = null; }
    this.heldResultMsg = null;
    this.pendingTaskCount = 0;

    // Respawn process so next message can be sent
    // NOTE: don't re-bind events — EventEmitter listeners survive kill/respawn
    this._process.respawn();

    // Broadcast cancellation to frontend
    this.broadcast("chat:cancelled", { partial: !!partial });

    // Flush idle waiters
    this.flushIdleWaiters();
  }

  clearHistory(): void {
    this.chatHistory = [];
    this.segments = [];
    this.tools = [];

    this.seenToolKeys.clear();
    this.sawTextDelta = false;
    if (this.resultFinalizeTimer) { clearTimeout(this.resultFinalizeTimer); this.resultFinalizeTimer = null; }
    this.heldResultMsg = null;
    this.pendingTaskCount = 0;
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
  }

  // --- TTS ---

  /** Enqueue a TTS job; jobs run sequentially to avoid ENOBUFS. */
  private triggerTts(dialogText: string, overrideMessageId?: string): void {
    if (process.env.TTS_ENABLED === "false") return;
    if (this.isBuilder) return;
    if (!this.ttsAutoPlay) return;
    if (this.destroyed) return;

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
      if (this.destroyed) return;
      if (provider === "edge") {
        const edgeVoice = voiceConfig.edgeVoice;
        if (!edgeVoice) return;

        broadcastRef("audio:status", { status: "queued", messageId, totalChunks });

        for (let i = 0; i < chunks.length; i++) {
          if (this.destroyed) return;
          if (i > 0) await new Promise(r => setTimeout(r, chunkDelay));
          if (this.destroyed) return;

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
      } else if (provider === "voxcpm") {
        // --- VoxCPM streaming TTS ---
        const voiceFile = voiceConfig.voiceFile
          ? path.join(dir, voiceConfig.voiceFile)
          : undefined;
        if (!voiceFile || !fs.existsSync(voiceFile)) return;

        const modelSize = voiceConfig.modelSize || "2B";
        const gpuManagerUrl = `http://127.0.0.1:${process.env.GPU_MANAGER_PORT || "3342"}`;
        const audioDir = path.join(dir, "audio");
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

        // Send full text (no splitting) — VoxCPM streams audio chunks back.
        // totalChunks is unknown during streaming, use 0 as "streaming mode" signal.
        // The frontend uses audioStatus.generating to know more chunks may arrive.
        const fullText = chunks.join(" ");
        broadcastRef("audio:status", { status: "queued", messageId, totalChunks: 0, streaming: true });

        try {
          const res = await fetch(`${gpuManagerUrl}/tts/synthesize-stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: fullText,
              voice_file: voiceFile,
              model_size: modelSize,
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`GPU Manager TTS stream error: ${err}`);
          }

          // Read NDJSON stream line by line
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let chunkCount = 0;

          try {
            while (true) {
              if (this.destroyed) {
                await reader.cancel();
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;
                const item = JSON.parse(line);
                const audioBuffer = Buffer.from(item.audio_base64, "base64");

                const timestamp = Date.now();
                const audioFilename = `tts-${timestamp}-${chunkCount}.mp3`;
                fs.writeFileSync(path.join(audioDir, audioFilename), audioBuffer);

                const url = `/api/sessions/${sessionId}/files/audio/${audioFilename}`;
                broadcastRef("audio:ready", {
                  url, messageId,
                  chunkIndex: chunkCount,
                  totalChunks: 0,
                });
                chunkCount++;
              }
            }
          } finally {
            reader.releaseLock();
          }

          // Stream done — send final audio:ready with real totalChunks to
          // let the frontend know all chunks have arrived
          if (chunkCount > 0) {
            broadcastRef("audio:ready", {
              url: "", messageId,
              chunkIndex: -1,
              totalChunks: chunkCount,
              streamDone: true,
            });
          }
        } catch (err) {
          console.error("[tts] VoxCPM stream error:", err);
          broadcastRef("audio:status", { status: "error", messageId, totalChunks: 0 });
        }
      } else {
        // --- GPU Manager / Qwen3-TTS (batch) ---
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
          if (this.destroyed) return;
          if (batchStart > 0) await new Promise(r => setTimeout(r, chunkDelay));
          if (this.destroyed) return;

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
                provider: "qwen3",
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
    if (this.destroyed) {
      this.ttsQueue = [];
      this.ttsRunning = false;
      return;
    }
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

  // --- Subagent result merging ---

  /** Fallback: finalize held result when no more result messages arrive */
  private finalizeHeldResult(): void {
    this.resultFinalizeTimer = null;
    if (!this.heldResultMsg) return;
    const held = this.heldResultMsg;
    this.heldResultMsg = null;
    this.pendingTaskCount = 0;
    this.processResult(held);
  }

  /** Process a result message — save history, broadcast, reset state. */
  private processResult(d: unknown): void {
    const msg = d as Record<string, unknown>;
    const isSlash = this.isSlashCommand;
    const isOOC = this.isOOC;

    if (isSlash) {
      const result = msg.result as Record<string, unknown> | string | undefined;
      const text =
        typeof result === "string" ? result
        : result && typeof result.text === "string" ? result.text
        : this.segments.join("") || null;
      this.broadcast("command:result", { text: text || "" });
    } else {
      if (this.segments.length > 0 || this.tools.length > 0) {
        let rawContent = this.segments.join("");
        if (this.assistantFullText && this.sawTextDelta) {
          if (rawContent.includes("\ufffd") || this.assistantFullText.includes("\ufffd")) {
            rawContent = mergeUtf8Texts(rawContent, this.assistantFullText);
          }
        }
        if (rawContent) {
          this.chatHistory.push({
            id: `hist-a-${++this.historyId}`,
            role: "assistant",
            content: rawContent,
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
    }

    this.isOOC = false;
    this.isSlashCommand = false;
    this.segments = [];
    this.assistantFullText = null;
    this.tools = [];

    this.seenToolKeys.clear();
    this.sawTextDelta = false;
    this.currentBlockType = "text";
    this.pushedTextsByMsgId.clear();
    this.isCompacting = false;

    if (!isSlash) {
      this.panels.reload();
    }

    if (!isSlash && !isOOC && this.chatHistory.length > 0) {
      const lastMsg = this.chatHistory[this.chatHistory.length - 1];
      if (lastMsg.role === "assistant" && lastMsg.content) {
        const dialogOnly = extractDialog(lastMsg.content);
        if (dialogOnly) this.triggerTts(dialogOnly);
      }
    }

    // Include messageId in the result broadcast so frontend can finish streaming
    // and assign the backend ID in a single state update (avoids flicker).
    const lastSaved = this.chatHistory[this.chatHistory.length - 1];
    const resultPayload = lastSaved
      ? { ...(d as Record<string, unknown>), messageId: lastSaved.id }
      : d;
    this.broadcast("claude:message", resultPayload);

    // Keep separate messageId broadcast for backwards compat (e.g. reconnected clients)
    if (lastSaved) {
      this.broadcast("claude:messageId", { messageId: lastSaved.id });
    }

    // Flush idle waiters (scheduler sendMessage)
    this.flushIdleWaiters();
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

      // Track subagent tasks for result merging
      if (msg.type === "system") {
        const subtype = msg.subtype as string;
        if (subtype === "task_started") {
          this.pendingTaskCount++;
        } else if (subtype === "task_notification") {
          this.pendingTaskCount = Math.max(0, this.pendingTaskCount - 1);
          // If all tasks done but we're holding a result, set a fallback timer
          if (this.pendingTaskCount === 0 && this.heldResultMsg) {
            if (this.resultFinalizeTimer) clearTimeout(this.resultFinalizeTimer);
            this.resultFinalizeTimer = setTimeout(() => {
              this.finalizeHeldResult();
            }, 5000);
          }
        }
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

        // Per-msgId content-based dedup. CLI emits one block per emission with
        // shared msgId (thinking → text → tool_use). Some CLI modes emit cumulative
        // content arrays; in either case dedup-by-content prevents double-push.
        const assistantMsgId = message.id as string | undefined;
        const pushTextOnce = (text: string): void => {
          if (this.sawTextDelta) return;
          if (!assistantMsgId) { this.segments.push(text); return; }
          let pushed = this.pushedTextsByMsgId.get(assistantMsgId);
          if (!pushed) { pushed = new Set(); this.pushedTextsByMsgId.set(assistantMsgId, pushed); }
          if (pushed.has(text)) return;
          pushed.add(text);
          this.segments.push(text);
        };

        // Always capture full text for UTF-8 healing comparison at result time
        const fullTextParts: string[] = [];
        if (typeof message.content === "string") {
          fullTextParts.push(message.content);
          pushTextOnce(message.content);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              fullTextParts.push(b.text);
              pushTextOnce(b.text);
            } else if (b.type === "tool_use") {
              this.addToolUse(b.name as string, b.input);
            }
          }
        }
        if (fullTextParts.length > 0) {
          this.assistantFullText = fullTextParts.join("");
        }
      }

      if (msg.type === "result") {
        // Subagent pattern: when tasks are pending, hold the result and keep
        // accumulating text from subsequent assistant messages.  Only process
        // once the last subagent result arrives (pendingTaskCount == 0).
        // However, if stop_reason is "end_turn", the CLI has definitively
        // finished — force-finalize regardless of pending task count.
        const stopReason = (msg as Record<string, unknown>).stop_reason as string | undefined;
        if (this.pendingTaskCount > 0 && stopReason !== "end_turn") {
          if (!this.heldResultMsg) this.heldResultMsg = d;
          return;
        }
        if (this.heldResultMsg) {
          // All tasks done — use the original (main) result payload
          if (this.resultFinalizeTimer) { clearTimeout(this.resultFinalizeTimer); this.resultFinalizeTimer = null; }
          const held = this.heldResultMsg;
          this.heldResultMsg = null;
          this.pendingTaskCount = 0;
          this.processResult(held);
          return;
        }
        // end_turn may arrive while pendingTaskCount > 0 (missed task_notification)
        if (this.pendingTaskCount > 0) this.pendingTaskCount = 0;
        this.processResult(d);
      }
    });

    p.on("error", (e) => this.broadcast("claude:error", e));
    p.on("status", (s) => this.broadcast("claude:status", s));
    p.on("exit", () => {
      this.flushIdleWaiters();
      this.broadcast("claude:status", "disconnected");
    });

    p.on("sessionId", (sessionId: string) => {
      try {
        if (this.isBuilder) {
          this.sessions.saveBuilderSession(this.id, this._provider, sessionId);
        } else {
          if (this._provider === "codex") {
            this.sessions.saveCodexThreadId(this.id, sessionId);
          } else if (this._provider === "gemini") {
            this.sessions.saveGeminiSessionId(this.id, sessionId);
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
    this.destroyed = true;
    this.flushIdleWaiters();
    this.ttsQueue = [];
    this.ttsRunning = false;
    if (this.resultFinalizeTimer) { clearTimeout(this.resultFinalizeTimer); this.resultFinalizeTimer = null; }
    this.heldResultMsg = null;
    this.pendingTaskCount = 0;
    this._process.kill();
    this._process.removeAllListeners();
    this.panels.stop();
  }
}
