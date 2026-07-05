import * as fs from "fs";
import * as path from "path";
import { AIProcess, createProcess } from "./ai-process-factory";
export type { AIProcess } from "./ai-process-factory";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { AIProvider } from "./ai-provider";
import { generateEdgeTts } from "./edge-tts-client";
import { getGpuManagerUrl } from "./endpoints";
import { buildHintSnapshotLine } from "./hint-snapshot";
import { spawnBackgroundAI } from "./background-session";
import { SubAgentManager } from "./subagent-manager";
import {
  mutateSessionJsonSync, readSessionJson, applyPatch, loadSessionData,
  resolveSessionFilePath, SYSTEM_JSON, LINT_SKIP_JSON,
} from "./session-state";

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

/**
 * Persona hooks are expected to be synchronous — their { variables, data }
 * patches are read synchronously right after the call. An async hook instead
 * returns a thenable whose eventual rejection would escape the surrounding
 * try/catch (which only traps synchronous throws) and surface as an unhandled
 * promise rejection, crashing the dev server. Detect that case, swallow the
 * rejection, and signal the caller to bail — the patches were never available
 * synchronously anyway, so this changes nothing for well-formed sync hooks.
 */
function guardAsyncHookResult(result: unknown, label: string): boolean {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void (result as Promise<unknown>).catch((err) =>
      console.error(`[hooks/${label}] async hook rejected (ignored — hooks must be synchronous):`, err)
    );
    return true;
  }
  return false;
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


function toolUseKey(name: string, input: unknown, id?: string): string {
  if (id) return `id:${id}`;
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:${String(input)}`;
  }
}

/** Serialized length of a tool input, for picking the more complete of two
 *  deliveries of the same tool_use id (streamed start carries empty input,
 *  the cumulative assistant message carries the full input). */
function toolInputLen(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return 0;
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
  tools?: Array<{ id?: string; name: string; input: unknown; answer?: ToolAnswer }>;
  ooc?: boolean;
}

export type ToolAnswer = {
  answers: Record<string, string | string[]>;
  notes?: Record<string, string>;
};

export type BroadcastFn = (
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean; exclude?: unknown }
) => void;

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
  readonly subAgents: SubAgentManager;
  readonly sessions: SessionManager;
  private readonly broadcastFn: BroadcastFn;

  // Pending event headers are persisted to pending-events.json in the session dir

  // Accumulator for assistant turn
  private segments: string[] = [];
  private assistantFullText: string | null = null; // full text from assistant message (for UTF-8 healing)
  private tools: Array<{
    id?: string;
    name: string;
    input: unknown;
    answer?: ToolAnswer;
  }> = [];

  private seenToolKeys = new Set<string>();
  private sawTextDelta = false;
  private currentBlockType = "text";
  private pushedTextsByMsgId = new Map<string, Set<string>>();
  private isCompacting = false;
  private isSlashCommand = false;
  private _currentStatus: string = "disconnected";
  private historyId = 0;
  private destroyed = false;

  // Subagent task tracking: hold result until all spawned tasks complete
  private pendingTaskCount = 0;
  private heldResultMsg: unknown = null;
  private resultFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Scheduler notification: track whether AI is mid-turn
  private _pendingTurn = false;
  private idleResolvers: Array<() => void> = [];

  // Antigravity silent retry: 모델이 segments/tools 둘 다 비운 채로 turn 종료한 경우
  // 한 번만 silent system prompt로 재시도. 새 user turn마다 false로 리셋.
  private silentRetryDone = false;

  // TTS queue — serialize requests to avoid ENOBUFS
  private ttsQueue: Array<() => Promise<void>> = [];
  private ttsRunning = false;
  /** Client-side TTS toggle — when false, skip TTS generation even if voice.json is configured */
  ttsAutoPlay = true;

  /** 마지막 turn에서 미응답 상태로 남은 AskUserQuestion tool_use_id.
   *  사용자 다음 평문 메시지를 이 도구의 자유 답변으로 흡수한다. */
  public pendingToolUseId: string | null = null;

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

    this.subAgents = new SubAgentManager(id, () => this.getDir(), (ev, data) => this.broadcast(ev, data));
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

  /** Update + broadcast the AI runtime status. Tracking the current value lets
   *  the WS server replay it on (re)connect — otherwise a client reconnecting
   *  mid-turn would render whatever stale status it had at disconnect time. */
  private setStatus(status: string): void {
    this._currentStatus = status;
    this.broadcast("claude:status", status);
  }

  /** Current AI runtime status (for replay on WS connect). */
  getStatus(): string {
    return this._currentStatus;
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

  /** Wait until the underlying AI process is ready to accept input.
   *  Resolves true if ready within timeout, false otherwise. */
  waitForReady(timeoutMs = 20_000): Promise<boolean> {
    return this._process.waitForReady(timeoutMs);
  }

  /** Reset pending turn state and resolve all idle waiters. */
  private flushIdleWaiters(): void {
    this._pendingTurn = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }

  /** Send a message to AI from server-side, triggering a new turn.
   *  If AI is mid-turn, waits for completion first (up to 60s timeout). */
  async sendMessage(text: string, opts?: { _silentRetry?: boolean }): Promise<void> {
    if (!this.claude.isRunning()) {
      console.warn(`[session:${this.id}] sendMessage skipped — AI process not running`);
      return;
    }
    // 새로운 user turn 시작 시 silent retry flag 리셋. silent retry 자기 자신은 리셋 안 함.
    if (!opts?._silentRetry) {
      this.silentRetryDone = false;
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
    // Antigravity Flash 등이 sub-agent orchestration을 hallucinate해서 응답을
    // 가상의 supervisor에게 제출하는 메타 인사말로 끝내는 패턴 방지.
    // 매 user turn마다 role을 명시적으로 reanchor.
    const orchestratorReminder = this._provider === "antigravity"
      ? "[ROLE] 당신이 오케스트레이터입니다. 유저에게 나갈 응답을 직접 작성해야 합니다. 다른 에이전트/슈퍼바이저/시스템에 제출·위임하지 마세요. 백그라운드 task 결과나 SYSTEM_MESSAGE를 받았으면 그 정보는 당신이 직접 처리한 것이며, 본문에 echo하지 말고 narrative에 자연스럽게 녹여 즉시 <dialog_response>로 응답을 마무리하세요."
      : "";
    const parts = [orchestratorReminder, eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
    this._pendingTurn = true;
    this.claude.send(parts.join("\n"));
  }

  /** 사용자가 카드에 응답했거나 평문 fallback이 트리거됐을 때 호출.
   *  1) chatHistory의 해당 tool에 answer를 in-place로 채움
   *  2) WS broadcast로 frontend 동기화
   *  3) provider에 tool_result 전송 — 실패해도 chatHistory에는 답 남음 (graceful degrade) */
  async submitToolAnswer(toolUseId: string, answer: ToolAnswer): Promise<void> {
    // 1) chatHistory의 마지막 assistant 메시지에서 해당 tool 찾아 answer 채움
    let mutated = false;
    for (let i = this.chatHistory.length - 1; i >= 0; i--) {
      const m = this.chatHistory[i];
      if (m.role !== "assistant" || !m.tools) continue;
      const t = m.tools.find(x => x.id === toolUseId);
      if (t) {
        t.answer = answer;
        mutated = true;
        break;
      }
    }
    if (!mutated) {
      console.warn(`[session:${this.id}] submitToolAnswer: tool ${toolUseId} not found in chatHistory`);
    } else {
      this.saveHistory();
    }

    // 2) WS broadcast — 다른 탭/devices 동기화
    this.broadcast("tool:answered", { toolUseId, answer });

    // 3) Clear pending + deliver the answer to the AI.
    if (this.pendingToolUseId === toolUseId) {
      this.pendingToolUseId = null;
    }

    // 헤드리스 `claude -p`는 AskUserQuestion을 **묻는 turn 내부에서** 곧바로 거부한다
    // (CLI가 대화형 TTY 없이 실행 불가 → synthetic tool_result `is_error:true, "Answer questions?"`).
    // 즉 tool_use가 이미 resolve된 상태라 stdin으로 보내는 tool_result는 죽은 no-op이며,
    // 모델은 빈 turn("메시지 내용이 없습니다")으로 끝나 더 이상 진행하지 않는다.
    // → 답을 일반 user 메시지 turn으로 전달한다. 거부 직후 프로세스는 idle이라 정상 이어진다.
    //   (design 문서의 restart "일반 user message로 graceful degrade" 폴백을 전 케이스로 일반화.)
    const answerText = this.formatToolAnswerForAI(answer);
    if (!answerText) {
      // 전달할 내용 없음 (orphan/provider-switch placeholder) — 카드 summary로 시각화는 이미 끝남.
    } else if (this.claude.isRunning()) {
      this.sendToAI(answerText);
    } else {
      console.warn(`[session:${this.id}] tool answer not delivered — process not running (orphan)`);
    }
  }

  /** ToolAnswer를 AI에게 보낼 평문 user-message turn으로 변환한다.
   *  AskUserQuestion은 헤드리스 모드에서 tool_result로 회신 불가하므로(submitToolAnswer 참고),
   *  구조화된 선택을 모델이 바로 이어받을 수 있는 평문으로 펼친다.
   *  전달할 게 없으면(orphan/provider-switch placeholder 등) "" 반환. */
  private formatToolAnswerForAI(answer: ToolAnswer): string {
    const lines: string[] = [];
    for (const [question, sel] of Object.entries(answer.answers || {})) {
      const labels = Array.isArray(sel) ? sel.filter(Boolean).join(", ") : sel;
      if (!labels) continue;
      const note = answer.notes?.[question];
      lines.push(`- ${question}: ${labels}${note ? ` (직접 입력: ${note})` : ""}`);
    }
    const freeform = answer.notes?._freeform;
    if (freeform) lines.push(`- ${freeform}`);
    if (lines.length === 0) return "";
    return `[질문 응답]\n${lines.join("\n")}`;
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
    const errors: string[] = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json") || LINT_SKIP_JSON.has(f)) continue;
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
      const varsPath = path.join(dir, "variables.json");
      const { variables, data } = loadSessionData(dir);

      // eslint-disable-next-line no-eval
      const nativeRequire = eval("require") as NodeRequire;
      delete nativeRequire.cache[hookPath];
      const mod = nativeRequire(hookPath);
      const fn = typeof mod === "function" ? mod : mod.default;
      if (typeof fn !== "function") return;

      const result = fn({ variables: { ...variables }, data, sessionDir: dir, message: messageText });
      if (guardAsyncHookResult(result, "on-message")) return;
      if (!result || typeof result !== "object") return;

      if (result.variables && typeof result.variables === "object") {
        mutateSessionJsonSync(varsPath, (current) => applyPatch(current, result.variables as Record<string, unknown>));
      }

      if (result.data && typeof result.data === "object") {
        for (const [rawKey, patch] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
          if (!patch || typeof patch !== "object") continue;
          const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
          if (SYSTEM_JSON.has(fileName)) continue;
          const fp = resolveSessionFilePath(dir, fileName);
          if (!fp) continue;
          mutateSessionJsonSync(fp, (current) => applyPatch(current, patch));
        }
      }
    } catch (err) {
      console.error("[hooks/on-message] error:", err);
    }
  }

  /**
   * Run session hooks/on-assistant.js if it exists.
   * Called right after AI stream completes and the assistant message is persisted.
   * Hook receives { variables, data, sessionDir, response } where response is the
   * just-finished assistant message text. May return { variables?, data?, fireAi?, dispatch? }:
   *   - variables/data: JSON patches applied to session state
   *   - fireAi: fire-and-forget background claude spawn
   *   - dispatch: [{ to, task }] entries routed to named sub-agents
   * After the hook (and even when no hook file exists), manifest-declared sub-agents
   * with autoTrigger "onAssistantTurn" are dispatched with their default task.
   * Use case: static analysis of the AI response (style tic detection, etc.)
   * that should surface in next turn's [STATE] header, plus sub-agent orchestration.
   */
  runAssistantHooks(responseText: string): void {
    const dir = this.getDir();
    if (!dir) return;
    const hookPath = path.join(dir, "hooks", "on-assistant.js");

    // Track which sub-agents the hook explicitly dispatched this turn so the
    // declarative autoTrigger loop can skip them and avoid double-dispatch.
    const explicitlyDispatched = new Set<string>();

    if (fs.existsSync(hookPath)) {
      try {
        const varsPath = path.join(dir, "variables.json");
        const { variables, data } = loadSessionData(dir);

        // eslint-disable-next-line no-eval
        const nativeRequire = eval("require") as NodeRequire;
        delete nativeRequire.cache[hookPath];
        const mod = nativeRequire(hookPath);
        const fn = typeof mod === "function" ? mod : mod.default;
        if (typeof fn === "function") {
          const result = fn({ variables: { ...variables }, data, sessionDir: dir, response: responseText });
          if (!guardAsyncHookResult(result, "on-assistant") && result && typeof result === "object") {
            if (result.variables && typeof result.variables === "object") {
              mutateSessionJsonSync(varsPath, (current) => applyPatch(current, result.variables as Record<string, unknown>));
            }

            if (result.data && typeof result.data === "object") {
              for (const [rawKey, patch] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
                if (!patch || typeof patch !== "object") continue;
                const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
                if (SYSTEM_JSON.has(fileName)) continue;
                const fp = resolveSessionFilePath(dir, fileName);
                if (!fp) continue;
                mutateSessionJsonSync(fp, (current) => applyPatch(current, patch));
              }
            }

            // Optional fire-and-forget background AI request — hook returns
            // { fireAi: { prompt, model?, effort?, notify?, useSessionContext?, onExit? } } to spawn analysis agent.
            if (result.fireAi && typeof result.fireAi === "object") {
              try {
                const fa = result.fireAi as {
                  prompt?: string;
                  model?: string;
                  effort?: string;
                  notify?: boolean;
                  useSessionContext?: boolean;
                  onExit?: {
                    broadcast?: { event: string; data?: unknown };
                    script?: string;
                  };
                };
                if (typeof fa.prompt === "string" && fa.prompt.trim()) {
                  console.log(`[hooks/on-assistant fireAi] spawning bg AI for ${this.id} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
                  spawnBackgroundAI({
                    sessionDir: dir,
                    prompt: fa.prompt,
                    model: fa.model,
                    effort: fa.effort,
                    notify: fa.notify ?? false,
                    callerSessionId: this.id,
                    useSessionContext: fa.useSessionContext ?? false,
                    onExit: fa.onExit,
                  });
                }
              } catch (err) {
                console.error("[hooks/on-assistant fireAi] spawn error:", err);
              }
            }

            // Handle dispatch[] — route tasks to named sub-agents (hook-driven auto-dispatch).
            const dispatchList = (result as { dispatch?: unknown }).dispatch;
            if (Array.isArray(dispatchList)) {
              for (const item of dispatchList) {
                const d = (item || {}) as { to?: unknown; task?: unknown };
                const to = typeof d.to === "string" ? d.to : "";
                const task = typeof d.task === "string" ? d.task : "";
                if (to && task) {
                  explicitlyDispatched.add(to);
                  const ok = this.subAgents.dispatch(to, task, "hook");
                  if (!ok) console.warn(`[session:${this.id}] on-assistant dispatch to unknown sub "${to}"`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("[hooks/on-assistant] error:", err);
      }
    }

    // Declarative auto-trigger: subs with autoTrigger "onAssistantTurn" fire each main turn,
    // unless the hook already dispatched them explicitly this turn.
    const autoDefs = this.subAgents.autoTriggerDefs();
    if (autoDefs.length > 0) {
      // Cap the appended response so a verbose main turn doesn't bloat every sub's input
      // (computed once, reused across all autoTrigger subs). Tail kept — the end is most relevant.
      const MAX_RESPONSE_CHARS = 4000;
      const excerpt = responseText.length > MAX_RESPONSE_CHARS
        ? `…(앞부분 생략)…\n${responseText.slice(-MAX_RESPONSE_CHARS)}`
        : responseText;
      for (const def of autoDefs) {
        if (explicitlyDispatched.has(def.name)) continue;
        const task = def.autoTriggerTask?.trim() || "최근 메인 턴을 반영해 네 담당 영역의 상태를 갱신하라.";
        this.subAgents.dispatch(def.name, `${task}\n\n[직전 메인 응답]\n${excerpt}`, "auto");
      }
    }
  }

  /**
   * Run session hooks/on-compaction-resume.js if it exists.
   * Called when CLI compaction completes (compact_boundary / status=null+compact_result),
   * giving the persona a chance to re-anchor the AI onto critical state that may have
   * been compressed away (active trainee card, recent diary, commission progress, etc.).
   *
   * Hook receives { variables, data, sessionDir } and may return { contextBlock?: string }.
   * If contextBlock is a non-empty string, it's sent as a silent system turn after the
   * runtime returns to idle. The AI's response to it is broadcast normally — personas
   * should phrase the block so the AI absorbs it without producing in-character content.
   */
  async runCompactionResumeHook(): Promise<void> {
    const dir = this.getDir();
    if (!dir) return;
    const hookPath = path.join(dir, "hooks", "on-compaction-resume.js");
    if (!fs.existsSync(hookPath)) return;

    try {
      const { variables, data } = loadSessionData(dir);

      // eslint-disable-next-line no-eval
      const nativeRequire = eval("require") as NodeRequire;
      delete nativeRequire.cache[hookPath];
      const mod = nativeRequire(hookPath);
      const fn = typeof mod === "function" ? mod : mod.default;
      if (typeof fn !== "function") return;

      const result = await Promise.resolve(fn({ variables: { ...variables }, data, sessionDir: dir }));
      if (!result || typeof result !== "object") return;

      const block = (result as { contextBlock?: unknown }).contextBlock;
      if (typeof block !== "string" || !block.trim()) return;

      // Settle any in-flight turn (e.g. mid-turn compact) before injecting.
      await this.waitForIdle();
      if (!this.claude.isRunning() || this.destroyed) return;
      console.log(`[session:${this.id}] compaction-resume: injecting ${block.length} char context block`);
      this.sendToAI(block);
    } catch (err) {
      console.error("[hooks/on-compaction-resume] error:", err);
    }
  }

  /**
   * Run session hooks/on-style-check.js if enabled via style-check.json.
   * Called after each non-OOC assistant turn (after runAssistantHooks).
   *
   * Opt-in:
   *  - `{sessionDir}/style-check.json` must exist with `{enabled:true, intervalTurns:N}`
   *  - `{sessionDir}/hooks/on-style-check.js` must exist
   *
   * Core handles the counter (persisted in variables.json `__style_check_counter`).
   * On threshold hit, loads defaults + persona rules, slices recent assistant turns,
   * invokes hook with { variables, data, sessionDir, recentTurns, defaults, rules,
   * reviewPromptTemplate, config }. Hook returns { fireAi?, contextBlock? } — same
   * shape as on-assistant.js.
   */
  runStyleCheckHook(): void {
    const dir = this.getDir();
    if (!dir) return;

    // Config gate — opt-in only.
    const configPath = path.join(dir, "style-check.json");
    if (!fs.existsSync(configPath)) return;

    let config: { enabled?: boolean; intervalTurns?: number; rulesPath?: string; model?: string; effort?: string };
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      return;
    }
    if (!config.enabled) return;

    const hookPath = path.join(dir, "hooks", "on-style-check.js");
    if (!fs.existsSync(hookPath)) return;

    const interval = Math.max(1, Number(config.intervalTurns) || 10);

    try {
      const varsPath = path.join(dir, "variables.json");
      let counter = 0;
      const cr = mutateSessionJsonSync(varsPath, (current) => {
        counter = (Number(current.__style_check_counter) || 0) + 1;
        return { ...current, __style_check_counter: counter };
      });
      // variables.json을 읽지 못하면(손상 등) 카운터 증분이 실패하므로 이번 스타일 검토는 건너뜀(쓰기 무결성: 못 읽은 상태로 분석/덮어쓰기 안 함).
      if (!cr.ok) return;
      const variables = cr.value || {};

      if (counter % interval !== 0) return;

      // Load shared defaults + persona rules.
      const projectRoot = process.cwd();
      const defaultsPath = path.join(projectRoot, "data", "style-check", "defaults.md");
      const promptTemplatePath = path.join(projectRoot, "data", "style-check", "review-prompt.md");
      let defaults = "";
      let reviewPromptTemplate = "";
      try { defaults = fs.readFileSync(defaultsPath, "utf-8"); } catch {}
      try { reviewPromptTemplate = fs.readFileSync(promptTemplatePath, "utf-8"); } catch {}

      const rulesFile = config.rulesPath || "style-check-rules.md";
      const rulesPath = path.join(dir, rulesFile);
      let personaRules = "";
      try { if (fs.existsSync(rulesPath)) personaRules = fs.readFileSync(rulesPath, "utf-8"); } catch {}

      const mergedRules = personaRules
        ? `${defaults}\n\n## 페르소나 추가 룰\n\n${personaRules}`
        : defaults;

      // Slice recent assistant turns.
      const histPath = path.join(dir, "chat-history.json");
      let recentTurns: Array<{ role: string; content: string }> = [];
      try {
        const hist = JSON.parse(fs.readFileSync(histPath, "utf-8"));
        const msgs = Array.isArray(hist)
          ? hist
          : ((hist as { messages?: unknown }).messages || (hist as { history?: unknown }).history || []);
        if (Array.isArray(msgs)) {
          recentTurns = (msgs as Array<{ role?: string; content?: string }>)
            .filter(m => m && m.role === "assistant" && typeof m.content === "string")
            .slice(-8)
            .map(m => ({ role: "assistant", content: m.content as string }));
        }
      } catch {}

      const { data } = loadSessionData(dir);

      // eslint-disable-next-line no-eval
      const nativeRequire = eval("require") as NodeRequire;
      delete nativeRequire.cache[hookPath];
      const mod = nativeRequire(hookPath);
      const fn = typeof mod === "function" ? mod : mod.default;
      if (typeof fn !== "function") return;

      const result = fn({
        variables: { ...variables },
        data,
        sessionDir: dir,
        recentTurns,
        defaults,
        rules: mergedRules,
        reviewPromptTemplate,
        config,
      });
      if (guardAsyncHookResult(result, "on-style-check")) return;
      if (!result || typeof result !== "object") return;

      if (result.fireAi && typeof result.fireAi === "object") {
        try {
          const fa = result.fireAi as {
            prompt?: string;
            model?: string;
            effort?: string;
            notify?: boolean;
            useSessionContext?: boolean;
          };
          if (typeof fa.prompt === "string" && fa.prompt.trim()) {
            console.log(`[hooks/on-style-check fireAi] spawning bg AI for ${this.id} (counter=${counter}, model=${fa.model || config.model || "default"})`);
            spawnBackgroundAI({
              sessionDir: dir,
              prompt: fa.prompt,
              model: fa.model || config.model,
              effort: fa.effort || config.effort,
              notify: fa.notify ?? false,
              callerSessionId: this.id,
              useSessionContext: fa.useSessionContext ?? false,
            });
          }
        } catch (err) {
          console.error("[hooks/on-style-check fireAi] spawn error:", err);
        }
      }
    } catch (err) {
      console.error("[hooks/on-style-check] error:", err);
    }
  }

  /** Clear __popups from variables.json (called on new user message) */
  clearPopups(): void {
    const dir = this.getDir();
    if (!dir) return;
    const varsPath = path.join(dir, "variables.json");
    let current: Record<string, unknown> | null;
    try {
      current = readSessionJson(varsPath);
    } catch {
      return; // corrupt/parse error → 덮어쓰지 않고 보존
    }
    if (!current) return; // 파일 없음 → 생성하지 않음
    if (!Array.isArray(current.__popups) || current.__popups.length === 0) return; // 비었으면 no-op
    const r = mutateSessionJsonSync(varsPath, (c) => ({ ...c, __popups: [] }));
    if (r.ok) this.panels.scheduleRender();
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

    // Clear pending tool answer — cancelled turn makes any outstanding tool_use_id invalid
    this.pendingToolUseId = null;

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
    if (!dir) { this.chatHistory = []; this.pendingToolUseId = null; return; }
    const fp = path.join(dir, HISTORY_FILE);
    try {
      if (fs.existsSync(fp)) {
        this.chatHistory = JSON.parse(fs.readFileSync(fp, "utf-8"));
        this.historyId = this.chatHistory.length;
        // Restart-recovery: chatHistory의 마지막 assistant 메시지에서 미답 AskUserQuestion이
        // 있으면 pendingToolUseId를 복원. Claude cascade가 새로 시작된 경우 tool_use_id는
        // 무효일 수 있으므로, submitToolAnswer 시 sendToolResult가 실패해도 graceful degrade.
        const lastAsst = [...this.chatHistory].reverse().find(m => m.role === "assistant");
        if (lastAsst?.tools) {
          const orphan = [...lastAsst.tools].reverse().find(
            t => t.name === "AskUserQuestion" && t.id && !t.answer
          );
          this.pendingToolUseId = orphan?.id ?? null;
        } else {
          this.pendingToolUseId = null;
        }
      } else {
        this.chatHistory = [];
        this.pendingToolUseId = null;
      }
    } catch {
      this.chatHistory = [];
      this.pendingToolUseId = null;
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
    if (this.pendingToolUseId) {
      // Orphan 처리: 카드 자체는 chatHistory에 남아있지만, 답을 받을 process가 사라짐.
      // 카드에 placeholder answer를 채워서 read-only highlighted로 변환.
      const orphanId = this.pendingToolUseId;
      this.pendingToolUseId = null;
      this.submitToolAnswer(orphanId, {
        answers: {},
        notes: { _orphan: "provider switched" },
      }).catch(err => console.warn(`[session:${this.id}] orphan submit failed:`, err));
    }
    this._provider = newProvider;
    this._process = createProcess(newProvider);
    this.bindProcessEvents(this._process);
  }

  // --- Accumulator helpers ---

  private addToolUse(toolName: string, input: unknown, id?: string): void {
    // Same tool_use id can be delivered twice: streamed content_block_start with
    // empty input, then the cumulative assistant message with the full input.
    // Refresh to the more complete input instead of skipping, so AskUserQuestion
    // keeps its `questions` and renders as a card rather than an empty tool block.
    if (id) {
      const existing = this.tools.find((t) => t.id === id);
      if (existing) {
        if (toolInputLen(input) > toolInputLen(existing.input)) existing.input = input;
        return;
      }
    }
    const key = toolUseKey(toolName, input, id);
    if (this.seenToolKeys.has(key)) return;
    this.seenToolKeys.add(key);

    this.tools.push({ id, name: toolName, input });
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
        const gpuManagerUrl = getGpuManagerUrl();
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
        const gpuManagerUrl = getGpuManagerUrl();

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
    // Antigravity idle-watch가 재진입한 자발적 wake-up turn(async 이미지/영상 완료로
    // 모델이 스스로 깨어난 turn). 사용자 입력에 대한 응답이 아니므로, 비거나 메타뿐이라도
    // silent-retry(응답 누락 보정 nudge)를 걸지 않는다. 본문이 있으면 일반 turn처럼 노출·기록.
    const isSpontaneous = msg.spontaneous === true;

    // 빈 응답 감지: Antigravity가 segments/tools 둘 다 비운 채 turn을 끝낸 경우
    // chat-history에 아무 entry도 추가되지 않으므로 사용자는 침묵을 받음.
    // state 리셋 전에 capture, retry는 모든 정리가 끝난 마지막에 schedule.
    const isAntigravityEmpty = !isSlash && !isOOC
      && this._provider === "antigravity"
      && !this.silentRetryDone
      && this.segments.length === 0
      && this.tools.length === 0;

    // Antigravity 메타 응답 감지: 모델이 sub-agent orchestration을 hallucinate해서
    // <dialog_response> 본문 없이 "I am ready to present...", "Let's submit it",
    // "stand by", SYSTEM_MESSAGE echo만 emit한 케이스. segments는 차 있지만
    // 사용자에게 실질 본문이 안 가므로 동일하게 silent retry 발동.
    const isAntigravityMetaOnly = !isSlash && !isOOC
      && this._provider === "antigravity"
      && !this.silentRetryDone
      && this.segments.length > 0
      && this.tools.length === 0
      && this.detectAntigravityMetaResponse(this.segments.join(""));

    // 누출된 툴콜 감지: Claude 계열(claude/kimi) 모델이 정식 tool_use 대신 함수호출
    // XML(<invoke .../>, <function_calls>)을 텍스트로 흘린 케이스. 에이전트형 턴에서는
    // 실제 tool_use가 성공한 뒤 마지막에 하나가 누출되기도 하므로 tools.length로 게이트하지
    // 않고 텍스트 패턴만으로 판정한다. assistantFullText는 sawTextDelta 여부와 무관하게
    // 전체 assistant 텍스트를 담으므로 segments와 합쳐 프로브한다.
    const leakProbeText = `${this.segments.join("")}\n${this.assistantFullText ?? ""}`;
    const isLeakedToolCall = !isSlash && !isOOC
      && (this._provider === "claude" || this._provider === "kimi")
      && this.detectLeakedToolCall(leakProbeText);

    // 누출 스트립 후의 본문(frontend 교체용). null=누출 아님, ""=스트립 후 본문 없음.
    let leakCleanedContent: string | null = null;

    if (isSlash) {
      const result = msg.result as Record<string, unknown> | string | undefined;
      const text =
        typeof result === "string" ? result
        : result && typeof result.text === "string" ? result.text
        : this.segments.join("") || null;
      this.broadcast("command:result", { text: text || "" });
    } else {
      // Antigravity \uba54\ud0c0 \uc751\ub2f5\uc740 chat-history\uc5d0 push\ud558\uc9c0 \uc54a\ub294\ub2e4 \u2014 silent retry\ub85c \ub300\uccb4 \uc751\ub2f5\uc744 \ubc1b\uc74c.
      // streaming\uc73c\ub85c frontend\uc5d0\ub294 \uc774\ubbf8 \ub178\ucd9c\ub410\uc744 \uc218 \uc788\uc73c\ub098, \uc601\uad6c \uae30\ub85d\uc740 \ucc28\ub2e8 (\ub2e4\uc74c reload\u00b7\ub2e4\uc74c turn \ucee8\ud14d\uc2a4\ud2b8\uc5d0 \uc548 \ub0a8\uc74c).
      if ((this.segments.length > 0 || this.tools.length > 0) && !isAntigravityMetaOnly) {
        let rawContent = this.segments.join("");
        if (this.assistantFullText && this.sawTextDelta) {
          if (rawContent.includes("\ufffd") || this.assistantFullText.includes("\ufffd")) {
            rawContent = mergeUtf8Texts(rawContent, this.assistantFullText);
          }
        }
        // \ub204\ucd9c\ub41c \ud234\ucf5c XML\uc740 \ubcf8\ubb38\uc5d0\uc11c \uc798\ub77c\ub0b8\ub2e4. \uc774\ubbf8 \uc131\uacf5\ud55c \uc2e4\uc81c tool_use(this.tools)\uc640
        // RP \ubcf8\ubb38\uc740 \uadf8\ub300\ub85c \uc720\uc9c0\ud558\uace0, \uc798\ub77c\ub0b8 \uacb0\uacfc(\ube48 \ubb38\uc790\uc5f4\uc77c \uc218 \uc788\uc74c)\ub294 frontend \uad50\uccb4\uc6a9\uc73c\ub85c \ubcf4\uad00.
        if (isLeakedToolCall) {
          rawContent = this.stripLeakedToolCalls(rawContent);
          leakCleanedContent = rawContent;
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

      // Run on-assistant hook with the just-finished assistant response.
      // Skip for OOC / slash to avoid noise. Use the last assistant message text.
      if (!isOOC) {
        const lastAsst = [...this.chatHistory].reverse().find(m => m.role === "assistant");
        if (lastAsst && typeof lastAsst.content === "string" && lastAsst.content) {
          this.runAssistantHooks(lastAsst.content);
          this.runStyleCheckHook();
        }
      }
    }

    this.isOOC = false;
    this.isSlashCommand = false;
    this.segments = [];
    this.assistantFullText = null;

    // Detect pending AskUserQuestion: 마지막 tool_use이고 answer 없으면 pending으로 잡음.
    // (한 turn에 여러 AskUserQuestion이 있으면 마지막 것만 pending — 앞선 것은 turn이 이미
    //  진행돼버린 상태라 회신 불가능하므로 무시. spec edge-case 참고.)
    const lastAsk = [...this.tools].reverse().find(
      t => t.name === "AskUserQuestion" && t.id && !t.answer
    );
    this.pendingToolUseId = lastAsk?.id ?? null;

    this.tools = [];

    this.seenToolKeys.clear();
    this.sawTextDelta = false;
    this.currentBlockType = "text";
    this.pushedTextsByMsgId.clear();
    this.isCompacting = false;

    if (!isSlash) {
      this.panels.reload();
    }

    // 이번 턴에 새 본문이 안 남은 경우(antigravity 메타 폐기 / 순수 누출 후 빈 본문)
    // lastMsg는 직전 턴 메시지를 가리키므로 TTS 재트리거를 막는다.
    const turnHadNoNewBody = isAntigravityMetaOnly
      || (isLeakedToolCall && (leakCleanedContent ?? "").trim().length === 0);
    if (!isSlash && !isOOC && !turnHadNoNewBody && this.chatHistory.length > 0) {
      const lastMsg = this.chatHistory[this.chatHistory.length - 1];
      if (lastMsg.role === "assistant" && lastMsg.content) {
        const dialogOnly = extractDialog(lastMsg.content);
        if (dialogOnly) this.triggerTts(dialogOnly);
      }
    }

    // Include messageId in the result broadcast so frontend can finish streaming
    // and assign the backend ID in a single state update (avoids flicker).
    // Antigravity 메타 응답이면 push 차단되어 lastSaved는 이전 turn 메시지를 가리킨다 —
    // 그걸로 streaming buffer를 finalize하면 직전 메시지가 메타 텍스트로 덮어쓰일 위험이 있다.
    // messageId를 명시적으로 비우고 `antigravityMetaSkipped` 플래그로 frontend에 discard 신호.
    const lastSaved = this.chatHistory[this.chatHistory.length - 1];
    // 결과 payload 분기:
    //  - antigravity 메타: 전체 폐기(turnDiscarded) — frontend가 live 메시지 제거.
    //  - 누출된 툴콜: 누출 XML을 제거한 cleanedContent로 표시 텍스트 교체(leakStripped).
    //    빈 문자열이면 frontend가 메시지를 제거(순수 누출). 그 외엔 lastSaved가 스트립된 메시지.
    //  - 정상: lastSaved.id 부여.
    let resultPayload: Record<string, unknown>;
    if (isAntigravityMetaOnly) {
      resultPayload = { ...(d as Record<string, unknown>), messageId: null, turnDiscarded: true, antigravityMetaSkipped: true };
    } else if (isLeakedToolCall) {
      const cleaned = leakCleanedContent ?? "";
      const hasBody = cleaned.trim().length > 0;
      resultPayload = { ...(d as Record<string, unknown>), messageId: hasBody && lastSaved ? lastSaved.id : null, leakStripped: true, cleanedContent: cleaned };
    } else {
      resultPayload = lastSaved
        ? { ...(d as Record<string, unknown>), messageId: lastSaved.id }
        : (d as Record<string, unknown>);
    }
    this.broadcast("claude:message", resultPayload);

    // Keep separate messageId broadcast for backwards compat (e.g. reconnected clients)
    if (lastSaved && !isAntigravityMetaOnly && !isLeakedToolCall) {
      this.broadcast("claude:messageId", { messageId: lastSaved.id });
    }

    // Flush idle waiters (scheduler sendMessage)
    this.flushIdleWaiters();

    // Antigravity 모델이 응답 없이 turn을 끝냈으면 silent system prompt로 한 번만 재시도.
    // 단, idle-watch가 재진입한 자발적 wake-up turn은 사용자 응답 누락이 아니므로 제외.
    // 누출/메타 모두 silentRetryDone으로 턴당 1회만 재시도(무한루프 방지). 누출 스트립
    // 자체는 silentRetryDone과 무관하게 매번 수행되지만, 재시도 nudge는 1회로 제한된다.
    if ((isAntigravityEmpty || isAntigravityMetaOnly || isLeakedToolCall) && !isSpontaneous && !this.silentRetryDone) {
      this.silentRetryDone = true;
      this.scheduleSilentRetry(
        isLeakedToolCall
          ? "[system] 직전 응답에서 도구 호출 일부가 실제로 실행되지 않고 텍스트(<invoke>/<function_calls>)로만 출력되었습니다. 실행되지 않은 그 도구를 정식 tool call로 다시 호출하세요. 호출 문법을 본문 텍스트로 쓰지 말고, 이미 성공한 호출은 반복하지 마세요."
          : "[system] 직전 응답이 누락되었습니다. 직전 사용자 요청에 대한 응답을 생성해 주세요.",
      );
    }
  }

  /** Antigravity 모델이 sub-agent orchestration 패턴을 hallucinate한 결과인지 판정.
   *  RP 본문(`<dialog_response>`)이 없고 메타 cue(영어 placeholder, 작업 보고,
   *  supervisor 호명, SYSTEM_MESSAGE echo)만 있으면 true.
   *  한국어 RP 페르소나에선 false positive 거의 없음. */
  private detectAntigravityMetaResponse(content: string): boolean {
    if (!content) return false;
    // dialog_response 태그가 본문이 있는 형태로 닫혀 있으면 정상 응답으로 간주
    const dialogMatch = content.match(/<dialog_response>([\s\S]*?)<\/dialog_response>/);
    if (dialogMatch && dialogMatch[1].trim().length > 0) return false;
    // 명백한 메타 cue. 한국어 RP 본문에서는 거의 발생하지 않는 영어 표현 위주.
    const metaCues = [
      // 다른 에이전트에게 제출/시연 인사말
      /I am (now )?ready to present/i,
      /Let'?s submit it/i,
      /\bOceania\b/,
      // 처리 중 placeholder
      /Please stand by/i,
      /I am (currently |now )?(processing|waiting|generating)/i,
      /I will (resume|continue|present|provide) (the|my|a|its)/i,
      /while the (image|task|generation|process) (is|are) (being|currently)/i,
      /once the (image|task|generation|process) (is|are) (ready|rendered|generated|complete|done|finished)/i,
      // 자기 작업 보고 ("I have triggered/initiated/started/completed/successfully ...")
      /I have (triggered|initiated|started|completed|successfully|just)/i,
      /I'?ve (triggered|initiated|started|completed|successfully|just)/i,
      // SYSTEM_MESSAGE / task notification echo
      /<SYSTEM_MESSAGE>/,
      /An event has occurred\. See the following message:/,
      /\[Message\] timestamp=.*sender=.*priority=MESSAGE_PRIORITY/,
    ];
    return metaCues.some(re => re.test(content));
  }

  /** Claude 함수호출 XML(<invoke .../>, <function_calls>)이 정식 tool_use 대신
   *  텍스트 채널로 누출됐는지 판정. 한국어 RP 본문엔 거의 없는 패턴이라 오탐 극소. */
  private detectLeakedToolCall(content: string): boolean {
    if (!content) return false;
    return /<invoke\s+name\s*=\s*["']/i.test(content)
      || /<function_calls\s*>/i.test(content);
  }

  /** 누출된 툴콜 XML 블록을 본문에서 제거. RP 본문은 보존한다. 선행 "call" 토큰,
   *  <function_calls> 래퍼, 단독 <invoke>, 닫히지 않은(truncated) 잔재까지 처리.
   *  (정규식은 scratchpad 단위테스트 15케이스로 검증됨) */
  private stripLeakedToolCalls(content: string): string {
    let out = content;
    out = out.replace(/\n*\s*call\s*\n?\s*<function_calls>[\s\S]*?<\/function_calls>/gi, "");
    out = out.replace(/\n*\s*call\s*\n?\s*<invoke\b[\s\S]*?<\/invoke>/gi, "");
    out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "");
    out = out.replace(/<invoke\b[\s\S]*?<\/invoke>/gi, "");
    // 닫히지 않은(truncated) 잔재 — 선행 call 포함 끝까지
    out = out.replace(/\n*\s*call\s*\n?\s*<(?:function_calls|invoke)\b[\s\S]*$/i, "");
    return out.trim();
  }

  /** 불량 턴(antigravity 빈/메타 응답, 누출된 툴콜) 감지 시 다음 tick에 교정용
   *  silent system prompt를 한 번만 보낸다. 새 user turn 시작(sendMessage 진입)에서
   *  silentRetryDone이 false로 리셋되므로 매 사용자 입력마다 최대 1회 재시도. */
  private scheduleSilentRetry(message: string): void {
    if (this.destroyed) return;
    setImmediate(() => {
      if (this.destroyed || !this.claude.isRunning()) return;
      console.warn(`[session:${this.id}] bad turn — issuing silent retry`);
      this.sendMessage(message, { _silentRetry: true }).catch(err => {
        console.warn(`[session:${this.id}] silent retry failed:`, err);
      });
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
        this.setStatus("compacting");
      }

      // Compact end markers: CLI sends one of
      //   {subtype:"status", status:null, compact_result:"success"}
      //   {subtype:"compact_boundary", ...}
      // either may arrive without a following stream_event (e.g. compact during
      // idle), so we must clear the compacting flag here — otherwise the UI
      // badge gets stuck on "Compacting..." indefinitely.
      if (
        msg.type === "system" &&
        ((msg.subtype === "status" && msg.status === null && typeof msg.compact_result !== "undefined") ||
          msg.subtype === "compact_boundary")
      ) {
        if (this.isCompacting) {
          this.isCompacting = false;
          this.setStatus("connected");
          // Fire-and-forget: persona hook re-anchors AI on critical state.
          this.runCompactionResumeHook().catch((err) =>
            console.error(`[session:${this.id}] runCompactionResumeHook failed:`, err)
          );
        }
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
          this.setStatus("streaming");
        }
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) return;
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          this.currentBlockType = (block?.type as string) || "text";
          if (block?.type === "tool_use") {
            this.addToolUse(block.name as string, block.input, block.id as string | undefined);
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
              this.addToolUse(b.name as string, b.input, b.id as string | undefined);
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
    p.on("status", (s) => this.setStatus(s as string));
    p.on("exit", () => {
      this.flushIdleWaiters();
      this.setStatus("disconnected");
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
          } else if (this._provider === "kimi") {
            this.sessions.saveKimiSessionId(this.id, sessionId);
          } else if (this._provider === "antigravity") {
            this.sessions.saveAntigravityCascadeId(this.id, sessionId);
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
    try { this.subAgents.destroyAll(); } catch (err) { console.error(`[session:${this.id}] subAgents.destroyAll failed:`, err); }
    this._process.kill();
    this._process.removeAllListeners();
    this.panels.stop();
  }
}
