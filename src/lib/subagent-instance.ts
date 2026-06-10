import * as fs from "fs";
import * as path from "path";
import { AIProcess, createProcess } from "./ai-process-factory";
import { SubAgentDef } from "./subagent-manifest";
import { registerSubProc, unregisterSubProc } from "./subagent-registry";

/** System-prompt preamble prepended to every sub-agent's instructions. Establishes
 *  the sub's contract: it actuates shared state, never talks to the end user, and
 *  reports a concise summary back to the main narrator via the report_to_main tool. */
function buildSubSystemPrompt(def: SubAgentDef, instructions: string): string {
  return [
    `You are "${def.name}", a specialized background sub-agent for a roleplay session.`,
    `Your role: ${def.role}`,
    "You are NOT the narrator and you do NOT talk to the end user. The main narrator handles all user-facing prose.",
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
 *  AntigravityProcess is excluded from sub-agents entirely (see subagent-manifest.ts). */
type ProcCarrier = { proc?: { pid?: number } | null };

export class SubAgentInstance {
  readonly name: string;
  readonly def: SubAgentDef;
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private _process: AIProcess;
  private resumeId: string | null = null;
  private destroyed = false;
  private pid: number | null = null;
  /** True once the role leading-message has been injected (or resumed, so already present). */
  private primed = false;

  constructor(def: SubAgentDef, sessionDir: string, sessionId: string) {
    this.def = def;
    this.name = def.name;
    this.sessionDir = sessionDir;
    this.sessionId = sessionId;
    this._process = createProcess(def.provider);
    // Prevent unhandledRejection crashes if initialize/emit fires after destroy.
    this._process.on("error", (e: unknown) => {
      console.error(`[subagent:${sessionId}/${this.name}] process error:`, e);
    });
    this._process.on("sessionId", (id: string) => {
      this.resumeId = id;
      try { fs.writeFileSync(this.resumePath(), id, "utf-8"); } catch { /* ignore */ }
    });
    // ClaudeProcess emits "exit" on process close (v1 restricts subs to Claude).
    // destroy() also unregisters explicitly, so a missed "exit" is harmless (idempotent).
    this._process.on("exit", () => {
      if (this.pid) unregisterSubProc(this.pid);
    });
  }

  private subDir(): string { return path.join(this.sessionDir, "subagents", this.name); }
  private resumePath(): string { return path.join(this.subDir(), ".resume"); }

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

  /** Spawn the sub's provider process in the shared session dir. Idempotent: no-op if running. */
  start(): void {
    if (this.destroyed || this._process.isRunning()) return;
    fs.mkdirSync(this.subDir(), { recursive: true });
    // Resume previous provider session id when available (intra-session continuity across restart).
    try {
      if (!this.resumeId && fs.existsSync(this.resumePath())) {
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
    this._process.spawn(
      this.sessionDir,
      this.resumeId ?? undefined,
      this.def.model,
      undefined,
      this.def.effort,
      true,
      path.join("subagents", this.name, "sub.log"),
    );
    // `proc` is private on all four supported provider classes; no public pid getter exists.
    // Accessing via structural cast is safe here: all four classes expose `proc?.pid` at
    // runtime immediately after spawn(). AntigravityProcess (which uses `agyPid` instead)
    // is excluded from PROVIDERS in subagent-manifest.ts.
    this.pid = (this._process as unknown as ProcCarrier).proc?.pid ?? null;
    if (this.pid) registerSubProc(this.pid, this.sessionId, this.name, this.sessionDir);
    console.log(`[subagent:${this.sessionId}/${this.name}] started pid=${this.pid} provider=${this.def.provider}`);
  }

  /** Dispatch a task to the sub. Spawns lazily if not yet running. Async-safe fire-and-forget.
   *  On the first dispatch of a fresh conversation, the role contract is prepended as a
   *  leading message (provider-uniform role delivery). */
  dispatch(task: string): void {
    if (this.destroyed) return;
    if (!this._process.isRunning()) this.start();
    if (!this._process.isRunning()) {
      console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch skipped — not running`);
      return;
    }
    let payload = task;
    if (!this.primed) {
      const role = buildSubSystemPrompt(this.def, this.readInstructions());
      // "--- TASK ---" is a visual separator between the role preamble and the per-turn task.
      payload = `${role}\n\n--- TASK ---\n${task}`;
      this.primed = true;
    }
    this._process.send(payload);
  }

  destroy(): void {
    this.destroyed = true;
    try { this._process.kill(); } catch { /* ignore */ }
    try { this._process.removeAllListeners(); } catch { /* ignore */ }
    if (this.pid) unregisterSubProc(this.pid);
  }
}
