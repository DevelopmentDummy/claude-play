import * as fs from "fs";
import * as path from "path";
import { AIProcess, createProcess } from "./ai-process-factory";
import { AIProvider } from "./ai-provider";
import { SubAgentDef } from "./subagent-manifest";
import { registerSubProc, unregisterSubProc } from "./subagent-registry";
import {
  newSubTextState, reduceSubMessage, appendTranscriptLine, readTranscriptTail,
  type SubTextState, type TranscriptEntry, type TranscriptDir, type TranscriptKind, type TranscriptOrigin,
} from "./subagent-transcript";

/** System-prompt preamble prepended to every sub-agent's instructions. Establishes
 *  the sub's contract: it actuates shared state, never talks to the end user, and
 *  reports a concise summary back to the main narrator via the report_to_main tool. */
function buildSubSystemPrompt(def: SubAgentDef, instructions: string): string {
  return [
    `You are "${def.name}", a specialized background sub-agent for a roleplay session.`,
    `Your role: ${def.role}`,
    "You are NOT the narrator and you do NOT talk to the end user. The main narrator handles all user-facing prose.",
    "Exception: a message beginning with [OPERATOR] is the human operator talking to you directly, out of character. In that turn, reply to the operator concisely and conversationally. You MAY still use your tools and call report_to_main when you actually change state.",
    "You operate on the SHARED session directory: read/write panel variables and data files using the MCP tools available to you (run_tool and the session's custom tools).",
    def.emitSummary
      ? `When you finish a task, call the MCP tool report_to_main with { from: "${def.name}", summary: "<one or two concise sentences of what changed>" } so the narrator learns what happened on its next turn. Do NOT write user-facing narrative.`
      : "Do not emit user-facing narrative.",
    "Keep your own text responses terse. The real work happens through tool calls.",
    "",
    "--- ROLE INSTRUCTIONS ---",
    instructions,
  ].join("\n");
}

/** Internal shape shared by ClaudeProcess / CodexProcess / GeminiProcess / KimiProcess.
 *  All four providers expose a `proc` field (ChildProcess | null) internally.
 *  There is no public pid getter, so we access it via a structural cast.
 *  AntigravityProcess tracks its pid as `agyPid` (not `proc`), so this cast yields undefined for it. */
type ProcCarrier = { proc?: { pid?: number } | null };

export class SubAgentInstance {
  readonly name: string;
  readonly def: SubAgentDef;
  readonly provider: AIProvider;
  readonly model?: string;
  readonly effort?: string;
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private _process: AIProcess;
  private resumeId: string | null = null;
  private destroyed = false;
  private pid: number | null = null;
  /** True once the role leading-message has been injected (or resumed, so already present). */
  private primed = false;
  /** True while a spawn's async handshake may still be in flight (codex/kimi JSON-RPC
   *  init). Guards start() against respawning over — and thereby killing — a live
   *  handshake. Cleared on process exit and once a dispatch observes readiness. */
  private spawnInFlight = false;
  /** Per-turn text accumulator for capturing the sub's final response text. */
  private textState: SubTextState = newSubTextState();
  /** Origin of the most recent dispatch — tags the response it produces so the UI can decide unread relevance. */
  private lastDispatchOrigin: TranscriptOrigin = "delegate";

  constructor(
    def: SubAgentDef,
    sessionDir: string,
    sessionId: string,
    provider: AIProvider,
    model?: string,
    effort?: string,
    private readonly onTranscript?: (entry: TranscriptEntry) => void,
  ) {
    this.def = def;
    this.name = def.name;
    this.sessionDir = sessionDir;
    this.sessionId = sessionId;
    this.provider = provider;
    this.model = model;
    this.effort = effort;
    this._process = createProcess(provider);
    // Prevent unhandledRejection crashes if initialize/emit fires after destroy.
    this._process.on("error", (e: unknown) => {
      console.error(`[subagent:${sessionId}/${this.name}] process error:`, e);
      // An error before the first conversation id was established means the role
      // leading-message may not have been delivered (e.g. antigravity "not initialized",
      // gemini spawn-on-send failure) — re-prime on the next dispatch. Conservative:
      // a spurious pre-sessionId error just causes a harmless duplicate role injection.
      if (!this.resumeId) this.primed = false;
    });
    this._process.on("sessionId", (id: string) => {
      // Kimi's id discovery is a cwd+mtime heuristic that can pick up the MAIN
      // narrator's conversation in the shared cwd. Never capture/persist it for a
      // kimi sub — the sub starts a fresh conversation each session open and
      // re-primes its role (primed = !!resumeId stays false), same tradeoff as a
      // provider switch.
      if (this.provider === "kimi") return;
      this.resumeId = id;
      try { fs.writeFileSync(this.resumePath(), id, "utf-8"); } catch { /* ignore */ }
    });
    // Provider processes emit "exit" on process close.
    // destroy() also unregisters explicitly, so a missed "exit" is harmless (idempotent).
    this._process.on("exit", () => {
      this.spawnInFlight = false;
      if (this.pid) unregisterSubProc(this.pid);
    });
    // Capture the sub's final response text per turn (turn-complete, not streamed).
    this._process.on("message", (d) => {
      const { state, final } = reduceSubMessage(this.textState, d as Record<string, unknown>);
      this.textState = state;
      if (final) this.appendTranscript({ dir: "out", kind: "response", origin: this.lastDispatchOrigin, text: final });
    });
  }

  private subDir(): string { return path.join(this.sessionDir, "subagents", this.name); }
  /** Resume file is provider-namespaced: a conversation id is only meaningful to the
   *  provider that issued it. On a session provider switch the old file is simply
   *  ignored — the sub starts a fresh conversation and re-primes its role. */
  private resumePath(): string { return path.join(this.subDir(), `.resume-${this.provider}`); }

  private readInstructions(): string {
    const fp = path.join(this.subDir(), this.def.instructions);
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      console.warn(`[subagent:${this.sessionId}/${this.name}] instructions not found at ${fp} — sub will run with an empty role body`);
      return "";
    }
  }

  isRunning(): boolean { return this._process.isRunning(); }

  /** Spawn the sub's provider process in the shared session dir. Idempotent: no-op if
   *  already running OR while a spawned handshake is still in flight (respawning would
   *  kill the handshaking process). After a crash, the "exit" listener clears
   *  spawnInFlight so a later dispatch can restart. */
  start(): void {
    if (this.destroyed || this.spawnInFlight || this._process.isRunning()) return;
    fs.mkdirSync(this.subDir(), { recursive: true });
    // Resume previous provider session id when available (intra-session continuity across
    // restart). Kimi is excluded: its id is never captured (see "sessionId" listener), and
    // a stale .resume-kimi from before that fix could point at the MAIN narrator's conversation.
    try {
      if (this.provider !== "kimi" && !this.resumeId && fs.existsSync(this.resumePath())) {
        this.resumeId = fs.readFileSync(this.resumePath(), "utf-8").trim() || null;
      }
    } catch { /* ignore */ }
    // Derive primed from actual resume state on every (re)start: a resumed conversation already
    // contains the role leading-message from its first turn (don't re-inject), while a fresh
    // conversation must re-prime on its first dispatch (see dispatch()) — even if a previous
    // incarnation primed and then died before persisting a resume id.
    this.primed = !!this.resumeId;
    // Role is delivered as a leading message on first dispatch — NOT as the appendSystemPrompt
    // spawn arg (only ClaudeProcess applied that; leading-message is provider-uniform).
    // spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions, logName)
    this.spawnInFlight = true;
    this._process.spawn(
      this.sessionDir,
      this.resumeId ?? undefined,
      this.model,
      undefined,
      this.effort,
      true,
      path.join("subagents", this.name, "sub.log"),
    );
    // `proc` is private on the pipe-based provider classes; no public pid getter exists.
    // Accessing via structural cast is safe: those classes expose `proc?.pid` at runtime
    // immediately after spawn(). AntigravityProcess uses `agyPid` instead, so this yields
    // null for antigravity subs — they are reaped via the agy-procs.json registry instead.
    this.pid = (this._process as unknown as ProcCarrier).proc?.pid ?? null;
    if (this.pid) registerSubProc(this.pid, this.sessionId, this.name, this.sessionDir);
    console.log(`[subagent:${this.sessionId}/${this.name}] started pid=${this.pid} provider=${this.provider}`);
  }

  /** Dispatch a task to the sub. Spawns lazily if not yet running, then gates the send
   *  on provider readiness (waitForReady) instead of dropping the task — codex/kimi have
   *  an async JSON-RPC handshake during which isRunning() is still false. Fire-and-forget:
   *  rapid dispatches may interleave (waitForReady resolves immediately when already
   *  ready, so steady-state ordering is preserved in practice). On the first dispatch of
   *  a fresh conversation, the role contract is prepended as a leading message
   *  (provider-uniform role delivery). */
  dispatch(task: string, origin: TranscriptOrigin = "delegate"): void {
    if (this.destroyed) return;
    this.appendTranscript({ dir: "in", kind: "dispatch", origin, text: task });
    this.lastDispatchOrigin = origin;
    // Operator OOC messages get a marker so the sub replies conversationally (see preamble).
    const taskText = origin === "operator" ? `[OPERATOR]\n${task}` : task;
    this.start(); // no-op when already running or a handshake is in flight
    void this._process.waitForReady(20_000)
      .then((ready) => {
        if (this.destroyed) return;
        this.spawnInFlight = false;
        if (!ready || !this._process.isRunning()) {
          console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch skipped — provider not ready`);
          return;
        }
        let payload = taskText;
        if (!this.primed) {
          const role = buildSubSystemPrompt(this.def, this.readInstructions());
          payload = `${role}\n\n--- TASK ---\n${taskText}`;
          this.primed = true;
        }
        this._process.send(payload);
      })
      .catch((err) => console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch failed:`, err));
  }

  /** Append a transcript entry (best-effort file write) and push it over WS. */
  private appendTranscript(e: { dir: TranscriptDir; kind: TranscriptKind; origin?: TranscriptOrigin; text: string }): void {
    const entry: TranscriptEntry = { ts: new Date().toISOString(), ...e };
    try { appendTranscriptLine(this.sessionDir, this.name, entry); } catch { /* best-effort */ }
    try { this.onTranscript?.(entry); } catch { /* ignore */ }
  }

  /** Record a sub→main report summary into this sub's transcript. */
  recordReport(summary: string): void {
    this.appendTranscript({ dir: "out", kind: "report", text: summary });
  }

  /** Read the last `n` transcript entries for display. */
  readTranscript(n: number): TranscriptEntry[] {
    return readTranscriptTail(this.sessionDir, this.name, n);
  }

  destroy(): void {
    this.destroyed = true;
    this.spawnInFlight = false;
    try { this._process.kill(); } catch { /* ignore */ }
    try { this._process.removeAllListeners(); } catch { /* ignore */ }
    if (this.pid) unregisterSubProc(this.pid);
  }
}
