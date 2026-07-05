import * as fs from "fs";
import * as path from "path";
import { getSessionManager, getSessionInstance } from "./session-registry";
import { wsBroadcast } from "./ws-server";
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";
import { AIProcess, createProcess } from "./ai-process-factory";
import { newSubTextState, reduceSubMessage, type SubTextState } from "./subagent-transcript";

// ── Interfaces ──────────────────────────────────────────────

/** Exit-time actions for a background spawn.
 *  `broadcast` fires a static WS message to the caller's clients (UI spinners, badges, delayed
 *  reveal, etc.). `script` requires a JS module inside the session dir and lets it return
 *  *dynamic* broadcasts/queueEvents based on exit code or log tail. */
export interface FireAIOnExit {
  /** Static WS broadcast to the caller session's clients. */
  broadcast?: { event: string; data?: unknown };
  /** Path (relative to sessionDir) to a Node module exporting a function.
   *  Receives `{ pid, exitCode, sessionDir, logTail }`, may return
   *  `{ broadcast?: { event, data }, queueEvent?: string }`. */
  script?: string;
}

export interface FireAIOptions {
  sessionDir: string;
  prompt: string;
  /** Model id; provider is derived via providerFromModel(). Empty/undefined → Claude (opus). */
  model?: string;
  effort?: string;
  notify?: boolean;
  callerSessionId?: string;
  /** When true, inject the full persona system prompt (CLAUDE.md, persona.md, worldview).
   *  When false (default), use a minimal task-execution prompt — the spawn focuses on
   *  *acting on the user prompt* (calling tools, writing files) rather than roleplaying. */
  useSessionContext?: boolean;
  /** Exit-time hook beyond `notify`. WS broadcast and/or callback script. */
  onExit?: FireAIOnExit;
}

/** Minimal system prompt for task-execution spawns.
 *  Optimised for tool use — explicitly tells the model to use Write/Read/etc. tools
 *  rather than producing in-character narrative responses. */
const TASK_EXECUTION_SYSTEM_PROMPT = [
  "You are a focused background agent executing a single task in a session directory.",
  "You are NOT roleplaying any character. You are NOT producing narrative dialogue.",
  "When the user prompt asks you to write a file, ALWAYS call the Write tool — do not respond with text describing what you would write.",
  "When the user prompt asks you to read or analyse files, ALWAYS use the Read/Glob/Grep tools — do not fabricate contents.",
  "Your final text response should be brief (one short sentence) confirming the action you took. The actual work happens through tool calls.",
  "If a tool fails, report the failure verbatim. Do not invent success.",
].join("\n");

export interface FireAIResult {
  pid: number;
  status: "fired";
}

// ── Active process tracking ─────────────────────────────────

/** Live background provider processes. Killed en masse on server shutdown. */
const activeProcesses = new Set<AIProcess>();

/** Structural accessor for a provider process's underlying child pid.
 *  Pipe-based providers (claude/codex/gemini/kimi) expose `proc?.pid`; AntigravityProcess
 *  tracks `agyPid` instead, so this yields undefined for it — agy is reaped via its own
 *  PID registry (data/.runtime/agy-procs.json), not via this pid. */
type ProcCarrier = { proc?: { pid?: number } | null };

/** Safety timeout for a background turn. A persistent provider process (unlike the old
 *  one-shot `claude -p`) does not self-exit, so a hung turn must be killed. */
const DEFAULT_FIRE_AI_TIMEOUT_MS = 600_000; // 10 min

// ── Helpers ─────────────────────────────────────────────────

/** Read session.json and build the full persona system prompt for the given provider. */
function buildSystemPromptForSession(sessionDir: string, provider: AIProvider): string {
  const sm = getSessionManager();
  const metaPath = path.join(sessionDir, "session.json");
  let personaName: string | undefined;
  let userName: string | undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    personaName = meta.persona;
    if (meta.profileSlug) {
      const profile = sm.getProfile(meta.profileSlug);
      userName = profile?.name;
    }
  } catch { /* ignore — will build prompt without persona */ }
  const resolvedOptions = sm.resolveOptions(sessionDir);
  return sm.buildServiceSystemPrompt(personaName, provider, resolvedOptions, userName);
}

/** Push a completion event to the caller session's pending-events.json.
 *  Tries the live SessionInstance first (so the WS broadcast fires); falls back to
 *  direct disk write when the instance has been cleaned up (10-min grace expired,
 *  page closed, etc.) — otherwise the notification is lost forever. */
function pushCompletionEvent(sessionDir: string, callerSessionId: string, pid: number, exitCode: number | null): void {
  const header = `[BACKGROUND_SESSION_COMPLETE] pid=${pid} exit_code=${exitCode ?? "null"}`;
  try {
    const instance = getSessionInstance(callerSessionId);
    if (instance) {
      instance.queueEvent(header);
      return;
    }
  } catch (err) {
    console.error("[background-session] queueEvent via instance failed, falling back to disk:", err);
  }
  // Fallback: write directly to pending-events.json so the next session open picks it up.
  try {
    const fp = path.join(sessionDir, "pending-events.json");
    let headers: string[] = [];
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) headers = parsed;
    }
    headers = headers.filter(h => h !== header);
    headers.push(header);
    fs.writeFileSync(fp, JSON.stringify(headers), "utf-8");
  } catch (err) {
    console.error("[background-session] Failed to persist completion event to disk:", err);
  }
}

/** Read the tail of a file safely (returns "" on any error). Used to give onExit scripts
 *  a small slice of the spawn log so they can detect specific failure strings. */
function tailFile(fp: string, maxBytes = 4096): string {
  try {
    const stat = fs.statSync(fp);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(fp, "r");
    try {
      const len = stat.size - start;
      if (len <= 0) return "";
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Resolve and validate an onExit.script path. Refuses paths that escape sessionDir
 *  (path traversal). Returns the absolute path, or null if rejected/missing. */
function resolveScriptPath(sessionDir: string, scriptRel: string): string | null {
  const sessionRoot = path.resolve(sessionDir);
  const abs = path.resolve(sessionRoot, scriptRel);
  if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
    console.error(`[background-session] onExit.script rejected (outside sessionDir): ${scriptRel}`);
    return null;
  }
  if (!fs.existsSync(abs)) {
    console.error(`[background-session] onExit.script not found: ${abs}`);
    return null;
  }
  return abs;
}

/** Run the onExit hook. Order: static broadcast → script callback → script-returned
 *  broadcast/queueEvent. The `notify` completion event is handled separately by the caller.
 *  `logName` selects which per-provider log file the script's logTail reads from. */
function runOnExit(
  onExit: FireAIOnExit,
  sessionDir: string,
  callerSessionId: string | undefined,
  pid: number,
  exitCode: number | null,
  logName: string,
): void {
  // 1) Static broadcast — caller-session-scoped only.
  if (onExit.broadcast && typeof onExit.broadcast.event === "string") {
    if (callerSessionId) {
      try {
        wsBroadcast(onExit.broadcast.event, onExit.broadcast.data ?? {}, { sessionId: callerSessionId });
      } catch (err) {
        console.error("[background-session] onExit.broadcast failed:", err);
      }
    } else {
      console.warn("[background-session] onExit.broadcast skipped — no callerSessionId");
    }
  }

  // 2) Script callback — sessionDir-scoped JS module.
  if (typeof onExit.script === "string" && onExit.script.trim()) {
    const scriptPath = resolveScriptPath(sessionDir, onExit.script);
    if (scriptPath) {
      try {
        const logPath = path.join(sessionDir, logName);
        const logTail = tailFile(logPath, 4096);

        // eslint-disable-next-line no-eval
        const nativeRequire = eval("require") as NodeRequire;
        delete nativeRequire.cache[scriptPath];
        const mod = nativeRequire(scriptPath);
        const fn = typeof mod === "function" ? mod : mod.default;
        if (typeof fn !== "function") {
          console.error(`[background-session] onExit.script has no callable export: ${scriptPath}`);
        } else {
          const result = fn({ pid, exitCode, sessionDir, logTail });
          if (result && typeof result === "object") {
            const r = result as { broadcast?: { event: string; data?: unknown }; queueEvent?: string };

            if (r.broadcast && typeof r.broadcast.event === "string" && callerSessionId) {
              try {
                wsBroadcast(r.broadcast.event, r.broadcast.data ?? {}, { sessionId: callerSessionId });
              } catch (err) {
                console.error("[background-session] onExit.script broadcast failed:", err);
              }
            }

            if (typeof r.queueEvent === "string" && r.queueEvent.trim() && callerSessionId) {
              try {
                const instance = getSessionInstance(callerSessionId);
                if (instance) {
                  instance.queueEvent(r.queueEvent);
                } else {
                  // Same disk fallback as pushCompletionEvent.
                  const fp = path.join(sessionDir, "pending-events.json");
                  let headers: string[] = [];
                  if (fs.existsSync(fp)) {
                    try {
                      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
                      if (Array.isArray(parsed)) headers = parsed;
                    } catch { /* ignore corrupt file */ }
                  }
                  headers = headers.filter(h => h !== r.queueEvent);
                  headers.push(r.queueEvent);
                  fs.writeFileSync(fp, JSON.stringify(headers), "utf-8");
                }
              } catch (err) {
                console.error("[background-session] onExit.script queueEvent failed:", err);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[background-session] onExit.script error (${scriptPath}):`, err);
      }
    }
  }
}

// ── Core function ───────────────────────────────────────────

/**
 * Spawn an independent one-shot background AI turn in the given session directory,
 * on the provider derived from `model` (default Claude). Reuses the session/subagent
 * provider-process engine: spawn → send prompt → on turn-ending `{type:"result"}` →
 * kill + fire onExit/notify. Returns immediately with the child pid (0 for antigravity,
 * whose pid is not exposed on the process object) — does not wait for completion.
 */
export function spawnBackgroundAI(opts: FireAIOptions): FireAIResult {
  const { sessionDir, prompt, model, effort, notify, callerSessionId, useSessionContext, onExit } = opts;

  // Parse model (may carry an embedded effort suffix, e.g. "opus:ultracode"); explicit
  // `effort` wins over the embedded one. Provider is derived from the model (default claude).
  const { model: parsedModel, effort: embeddedEffort } = parseModelEffort(model || "");
  const effectiveModel = parsedModel || undefined;
  const effectiveEffort = effort || embeddedEffort || undefined;

  let provider: AIProvider;
  try {
    provider = effectiveModel ? providerFromModel(effectiveModel) : "claude";
  } catch (err) {
    // providerFromModel throws e.g. when Gemini is disabled. Surface to the caller
    // (route/hook already wrap in try/catch, so the session turn is unaffected).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[background-session] provider routing failed for model="${model}": ${msg}`);
    throw new Error(`fire_ai: ${msg}`);
  }

  // System prompt: minimal task prompt (default) or full persona context.
  const systemPrompt = useSessionContext
    ? buildSystemPromptForSession(sessionDir, provider)
    : TASK_EXECUTION_SYSTEM_PROMPT;

  // Claude applies the spawn's appendSystemPrompt arg as a real `--system-prompt` (full
  // replacement). Other provider classes ignore that arg, so for them the system prompt is
  // delivered as a leading message block instead (provider-uniform, mirrors subagent role
  // delivery). Note: non-Claude providers also load the session config's own baseInstructions
  // (persona), so the minimal prompt layers on top rather than fully replacing it.
  const claudeSystemPrompt = provider === "claude" ? systemPrompt : undefined;
  const payload = provider === "claude"
    ? prompt
    : `${systemPrompt}\n\n--- TASK ---\n${prompt}`;

  const logName = `background-${provider}.log`;
  const logPath = path.join(sessionDir, logName);

  const proc = createProcess(provider);
  activeProcesses.add(proc);

  // Per-turn text accumulator — final text harvested to the log for debugging.
  let textState: SubTextState = newSubTextState();
  let finalText = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pidOf = (): number => (proc as unknown as ProcCarrier).proc?.pid ?? -1;

  const settle = (code: number | null): void => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    activeProcesses.delete(proc);
    const pid = pidOf();
    try { proc.kill(); } catch { /* already dead */ }

    // Append a settle marker (+ harvested final text) so onExit scripts / debugging have it.
    try {
      const stream = fs.createWriteStream(logPath, { flags: "a" });
      stream.write(`\n--- fire_ai settle provider=${provider} code=${code} at ${new Date().toISOString()} ---\n`);
      if (finalText) {
        stream.write(`[final] ${finalText.slice(0, 500)}${finalText.length > 500 ? "..." : ""}\n`);
      }
      stream.end();
    } catch { /* best-effort */ }

    if (onExit && (onExit.broadcast || onExit.script)) {
      runOnExit(onExit, sessionDir, callerSessionId, pid, code, logName);
    }
    if (notify && callerSessionId) {
      pushCompletionEvent(sessionDir, callerSessionId, pid, code);
    }
    console.log(`[background-session] settled provider=${provider} pid=${pid} code=${code}`);
  };

  proc.on("message", (d: unknown) => {
    const msg = d as Record<string, unknown>;
    const { state, final } = reduceSubMessage(textState, msg);
    textState = state;
    if (final) finalText = final;
    // Turn-ending result → normal completion.
    if (msg.type === "result") settle(0);
  });
  proc.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[background-session] provider=${provider} error: ${msg}`);
    settle(1);
  });
  proc.on("exit", () => {
    // Persistent process exited without a prior `result` → crash/abnormal. If a result
    // already settled us, this is the kill()-triggered exit and is a no-op (idempotent).
    settle(1);
  });

  // Fresh conversation (no resumeId). Log to background-<provider>.log.
  proc.spawn(sessionDir, undefined, effectiveModel, claudeSystemPrompt, effectiveEffort, true, logName);

  const spawnedPid = pidOf();
  console.log(`[background-session] spawned provider=${provider} pid=${spawnedPid} model=${effectiveModel || "(default)"} effort=${effectiveEffort || "(default)"} notify=${notify || false}`);

  // Safety timeout — kill + treat as error if the turn never completes.
  const timeoutMs = Number(process.env.FIRE_AI_TIMEOUT_MS) || DEFAULT_FIRE_AI_TIMEOUT_MS;
  timer = setTimeout(() => {
    console.warn(`[background-session] provider=${provider} timed out after ${timeoutMs}ms — killing`);
    settle(1);
  }, timeoutMs);

  // Gate the send on provider readiness (codex/kimi have an async JSON-RPC handshake during
  // which isRunning() is briefly false; claude/gemini resolve immediately).
  void proc.waitForReady(20_000)
    .then((ready) => {
      if (settled) return;
      if (!ready || !proc.isRunning()) {
        console.warn(`[background-session] provider=${provider} not ready — aborting`);
        settle(1);
        return;
      }
      proc.send(payload);
    })
    .catch((err) => {
      if (settled) return;
      console.warn(`[background-session] provider=${provider} waitForReady failed:`, err);
      settle(1);
    });

  return { pid: spawnedPid >= 0 ? spawnedPid : 0, status: "fired" };
}

// ── Cleanup ─────────────────────────────────────────────────

/** Destroy all active background provider processes (called on server shutdown).
 *  Each provider's kill() handles its own process-tree teardown (Windows taskkill /T, etc.). */
export function destroyAllBackgroundProcesses(): void {
  for (const proc of Array.from(activeProcesses)) {
    try { proc.kill(); } catch { /* already exited */ }
  }
  activeProcesses.clear();
}
