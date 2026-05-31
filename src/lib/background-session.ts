import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { getSessionManager } from "./session-registry";
import { getSessionInstance } from "./session-registry";
import { wsBroadcast } from "./ws-server";
import { resolveClaudeEffort } from "./ai-provider";

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

const activeProcesses = new Map<number, ChildProcess>();

// ── Helpers ─────────────────────────────────────────────────

/** Build a clean env without CLAUDECODE/CLAUDE_CODE vars (prevents nested session errors) */
function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
      delete env[key];
    }
  }
  return env;
}

/** Read session.json from the session directory and build the system prompt */
function buildSystemPromptForSession(sessionDir: string): string {
  const sm = getSessionManager();

  // Read persona name and profile from session.json
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

  // Resolve options (schema defaults → persona overrides → session overrides)
  const resolvedOptions = sm.resolveOptions(sessionDir);

  // Build the same system prompt pipeline as normal sessions
  return sm.buildServiceSystemPrompt(personaName, "claude", resolvedOptions, userName);
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
 *  broadcast/queueEvent. The `notify` completion event is handled separately by the caller. */
function runOnExit(
  onExit: FireAIOnExit,
  sessionDir: string,
  callerSessionId: string | undefined,
  pid: number,
  exitCode: number | null
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
        const logPath = path.join(sessionDir, "background-session.log");
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
 * Spawn an independent one-shot `claude -p "prompt"` process in the given session directory.
 * Returns immediately with the PID — does not wait for completion.
 */
export function spawnBackgroundClaude(opts: FireAIOptions): FireAIResult {
  const { sessionDir, prompt, model, effort, notify, callerSessionId, useSessionContext, onExit } = opts;

  // Default: minimal task-execution prompt (spawns *do* tasks, they don't roleplay).
  // Opt-in: full persona system prompt for cases where character context is genuinely needed.
  const systemPrompt = useSessionContext
    ? buildSystemPromptForSession(sessionDir)
    : TASK_EXECUTION_SYSTEM_PROMPT;

  // Build args: one-shot mode (no --input-format / --output-format)
  const args: string[] = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--verbose",
  ];

  if (model) {
    args.push("--model", model);
  }

  // "ultracode" pseudo-effort → real --effort (xhigh) + Workflow tool (env, set below).
  const { effortFlag, enableWorkflows, systemAppend } = resolveClaudeEffort(effort);
  if (effortFlag) {
    args.push("--effort", effortFlag);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  if (systemAppend) {
    args.push("--append-system-prompt", systemAppend);
  }

  // MCP config from session directory
  const mcpConfigPath = path.join(sessionDir, ".mcp.json");
  if (fs.existsSync(mcpConfigPath)) {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }

  // Build clean env
  const env = buildCleanEnv();
  if (enableWorkflows) {
    env.CLAUDE_CODE_WORKFLOWS = "1";
  }

  // Prepare log file
  const logPath = path.join(sessionDir, "background-session.log");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n--- background spawn ${new Date().toISOString()} ---\n`);
  logStream.write(`prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}\n`);
  logStream.write(`model: ${model || "(default)"} | effort: ${effort || "(default)"} | notify: ${notify || false}\n`);

  // Spawn the process
  const proc = spawn("claude", args, {
    env,
    cwd: sessionDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (!proc.pid) {
    logStream.write(`--- spawn failed: no pid ---\n`);
    logStream.end();
    throw new Error("Failed to spawn background claude process");
  }

  const pid = proc.pid;
  activeProcesses.set(pid, proc);

  console.log(`[background-session] Spawned pid=${pid} in ${sessionDir}`);

  // Pipe stdout/stderr to log file
  const stderrDecoder = new StringDecoder("utf-8");
  let stderrFlushed = false;
  const flushStderr = () => {
    if (stderrFlushed) return;
    stderrFlushed = true;
    const tail = stderrDecoder.end();
    if (tail) {
      logStream.write(`[stderr] ${tail}`);
    }
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    logStream.write(chunk);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    if (text) {
      logStream.write(`[stderr] ${text}`);
    }
  });
  proc.stderr?.on("end", flushStderr);
  proc.stderr?.on("close", flushStderr);

  // On exit: cleanup, log, optionally notify
  proc.on("exit", (code) => {
    activeProcesses.delete(pid);
    logStream.write(`\n--- exit code=${code} at ${new Date().toISOString()} ---\n`);
    logStream.end();

    console.log(`[background-session] pid=${pid} exited with code=${code}`);

    // onExit (broadcast / script) runs first so UI updates and side-effects land
    // before any silent system event would advance the next turn.
    if (onExit && (onExit.broadcast || onExit.script)) {
      runOnExit(onExit, sessionDir, callerSessionId, pid, code);
    }

    // Push completion event to caller session if requested
    if (notify && callerSessionId) {
      pushCompletionEvent(sessionDir, callerSessionId, pid, code);
    }
  });

  proc.on("error", (err) => {
    activeProcesses.delete(pid);
    logStream.write(`\n--- error: ${err.message} at ${new Date().toISOString()} ---\n`);
    logStream.end();

    console.error(`[background-session] pid=${pid} error:`, err.message);
  });

  return { pid, status: "fired" };
}

// ── Cleanup ─────────────────────────────────────────────────

/** Destroy all active background processes (called on server shutdown) */
export function destroyAllBackgroundProcesses(): void {
  for (const [pid, proc] of Array.from(activeProcesses.entries())) {
    console.log(`[background-session] Killing pid=${pid}`);
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
      } else {
        proc.kill();
      }
    } catch { /* already exited */ }
  }
  activeProcesses.clear();
}
