import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { getSessionManager } from "./session-registry";
import { getSessionInstance } from "./session-registry";

// ── Interfaces ──────────────────────────────────────────────

export interface FireAIOptions {
  sessionDir: string;
  prompt: string;
  model?: string;
  effort?: string;
  notify?: boolean;
  callerSessionId?: string;
}

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

  // Read persona name from session.json
  const metaPath = path.join(sessionDir, "session.json");
  let personaName: string | undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    personaName = meta.persona;
  } catch { /* ignore — will build prompt without persona */ }

  // Resolve options (schema defaults → persona overrides → session overrides)
  const resolvedOptions = sm.resolveOptions(sessionDir);

  // Build the same system prompt pipeline as normal sessions
  return sm.buildServiceSystemPrompt(personaName, "claude", resolvedOptions);
}

/** Push a completion event to the caller session's pending-events.json */
function pushCompletionEvent(callerSessionId: string, pid: number, exitCode: number | null): void {
  try {
    const instance = getSessionInstance(callerSessionId);
    if (instance) {
      instance.queueEvent(`[BACKGROUND_SESSION_COMPLETE] pid=${pid} exit_code=${exitCode ?? "null"}`);
    }
  } catch (err) {
    console.error("[background-session] Failed to push completion event:", err);
  }
}

// ── Core function ───────────────────────────────────────────

/**
 * Spawn an independent one-shot `claude -p "prompt"` process in the given session directory.
 * Returns immediately with the PID — does not wait for completion.
 */
export function spawnBackgroundClaude(opts: FireAIOptions): FireAIResult {
  const { sessionDir, prompt, model, effort, notify, callerSessionId } = opts;

  // Build system prompt using the same pipeline as normal sessions
  const systemPrompt = buildSystemPromptForSession(sessionDir);

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

  if (effort) {
    args.push("--effort", effort);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  // MCP config from session directory
  const mcpConfigPath = path.join(sessionDir, ".mcp.json");
  if (fs.existsSync(mcpConfigPath)) {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }

  // Build clean env
  const env = buildCleanEnv();

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

    // Push completion event to caller session if requested
    if (notify && callerSessionId) {
      pushCompletionEvent(callerSessionId, pid, code);
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
