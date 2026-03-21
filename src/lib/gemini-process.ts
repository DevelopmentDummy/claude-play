import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

export interface GeminiProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

/**
 * GeminiProcess wraps the `gemini` CLI for per-turn spawning.
 *
 * Unlike Claude (persistent stdin) and Codex (JSON-RPC app-server), Gemini CLI
 * does not support streaming input. Each user message requires a fresh spawn,
 * resuming the previous session via `--resume <session_id>`.
 *
 * Execution model:
 * - spawn() stores parameters and emits "connected" but does NOT start a process.
 * - send() spawns the actual gemini process with -p "text".
 * - Subsequent send() calls kill the current process and respawn with --resume.
 */
export class GeminiProcess extends EventEmitter<GeminiProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private logStream: fs.WriteStream | null = null;

  // Stored spawn parameters
  private spawnCwd = "";
  private spawnModel: string | undefined;

  // Session state
  private savedSessionId: string | null = null;
  private pendingFirstMessage = false;
  private initialResumeId: string | undefined;

  // Track whether any delta events were received in the current turn
  private seenDeltaInTurn = false;

  /**
   * Prepare for a session. Does NOT spawn a process immediately.
   * If resumeId is provided, the next send() will use --resume.
   * GEMINI.md in cwd is auto-loaded by Gemini CLI.
   */
  spawn(
    cwd: string,
    resumeId?: string,
    model?: string,
    _appendSystemPrompt?: string,
    _effort?: string,
    _skipPermissions?: boolean,
  ): void {
    // Kill any existing process
    if (this.proc) {
      this.kill();
    }

    this.spawnCwd = cwd;
    this.spawnModel = model;
    this.initialResumeId = resumeId;
    this.savedSessionId = resumeId || null;
    this.pendingFirstMessage = true;
    this.seenDeltaInTurn = false;

    // Start log stream
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, "gemini-stream.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream.write(
      `\n--- spawn ${new Date().toISOString()} model: ${model || "default"} resumeId: ${resumeId || "new"} ---\n`,
    );

    // Signal ready without starting a process yet
    this.emit("status", "connected");
  }

  /**
   * Send a user message. On first call (no resume), spawns gemini with -p "text".
   * On subsequent calls, kills the current process and respawns with --resume.
   */
  send(text: string): void {
    if (!this.pendingFirstMessage && !this.proc && !this.savedSessionId) {
      this.emit("error", "Gemini process not ready");
      return;
    }

    if (this.pendingFirstMessage && !this.savedSessionId) {
      // Very first message — spawn fresh
      this.pendingFirstMessage = false;
      this.spawnProcess(text, undefined);
    } else {
      // Subsequent message — kill current process if running, then resume
      if (this.proc) {
        this.killCurrentProc();
      }
      this.pendingFirstMessage = false;
      this.spawnProcess(text, this.savedSessionId || undefined);
    }

    this.emit("status", "streaming");
  }

  /**
   * Spawn the gemini CLI process for one turn.
   */
  private spawnProcess(prompt: string, resumeId: string | undefined): void {
    const cmd = process.platform === "win32" ? "gemini.cmd" : "gemini";

    // Resume mode: -p and --resume cannot be combined.
    // Use stdin to send the prompt when resuming.
    const args: string[] = [];
    if (!resumeId) {
      args.push("-p", prompt);
    }
    args.push("--output-format", "stream-json", "--yolo");

    if (this.spawnModel) {
      args.push("--model", this.spawnModel);
    }

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    // Build clean env: remove CLAUDECODE/CLAUDE_CODE vars
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
        delete (env as Record<string, string | undefined>)[key];
      }
    }

    if (this.logStream) {
      this.logStream.write(
        `[spawn] ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}${resumeId ? ` (stdin: ${prompt.substring(0, 80)})` : ""}\n`,
      );
    }

    this.buffer = "";
    this.seenDeltaInTurn = false;

    // When resuming, stdin must be "pipe" to send the prompt
    const stdinMode = resumeId ? "pipe" as const : "ignore" as const;

    this.proc = spawn(cmd, args, {
      env,
      cwd: this.spawnCwd,
      stdio: [stdinMode, "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    // For resume mode, pipe the prompt via stdin then close
    if (resumeId && this.proc.stdin) {
      this.proc.stdin.write(prompt);
      this.proc.stdin.end();
    }

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf-8"));
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        if (this.logStream) this.logStream.write(`[stderr] ${text}\n`);
        // Gemini may log progress info to stderr — only surface real errors
      }
    });

    this.proc.on("error", (err) => {
      this.emit("error", `Failed to start gemini: ${err.message}`);
      this.emit("status", "disconnected");
    });

    this.proc.on("exit", (code) => {
      if (this.logStream) this.logStream.write(`[exit] code=${code}\n`);
      this.proc = null;
      this.buffer = "";

      // If resume failed (non-zero exit with a resumeId), retry without --resume
      if (resumeId && code !== 0) {
        console.log("[gemini-process] Resume failed, retrying without --resume");
        this.savedSessionId = null;
        this.spawnProcess(prompt, undefined);
        return;
      }

      this.emit("exit", code);
      this.emit("status", "connected");
    });
  }

  /** NDJSON line-buffered parser */
  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (this.logStream) {
        this.logStream.write(`[recv] ${trimmed}\n`);
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleGeminiEvent(parsed);
      } catch {
        // Not valid JSON — ignore
      }
    }
  }

  /**
   * Normalize Gemini stream events to the shared EventEmitter interface.
   */
  private handleGeminiEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    switch (type) {
      case "init": {
        const sessionId = event.session_id as string | undefined;
        if (sessionId) {
          this.savedSessionId = sessionId;
          this.emit("sessionId", sessionId);
        }
        break;
      }

      case "message": {
        if (event.role !== "assistant") break;
        const content = event.content as string | undefined;
        if (!content) break;

        if (event.delta === true) {
          // Streaming delta
          this.seenDeltaInTurn = true;
          this.emit("message", {
            type: "assistant",
            subtype: "text_delta",
            message: {
              role: "assistant",
              content,
            },
          });
        } else {
          // Full message (no delta flag) — only emit if no deltas were seen
          if (!this.seenDeltaInTurn) {
            this.emit("message", {
              type: "assistant",
              subtype: "text_delta",
              message: {
                role: "assistant",
                content,
              },
            });
          }
        }
        break;
      }

      case "tool_use": {
        const toolName = event.tool_name as string | undefined;
        const parameters = (event.parameters ?? {}) as unknown;
        this.emit("message", {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: toolName || "unknown",
                input: parameters,
              },
            ],
          },
        });
        break;
      }

      case "result": {
        this.seenDeltaInTurn = false;
        this.emit("message", { type: "result" });
        break;
      }

      case "error": {
        const message = event.message as string | undefined;
        this.emit("error", message || "Gemini error");
        break;
      }

      case "tool_result":
        // Intermediate tool result — ignore
        break;

      default:
        // Unknown event type — ignore
        break;
    }
  }

  isRunning(): boolean {
    // Ready if process is running OR we're waiting for the first message
    return !!(this.proc) || this.pendingFirstMessage;
  }

  private killCurrentProc(): void {
    if (!this.proc) return;
    this.proc.stdout?.removeAllListeners();
    this.proc.stderr?.removeAllListeners();
    this.proc.removeAllListeners();

    const pid = this.proc.pid;
    if (pid && process.platform === "win32") {
      try {
        execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
      } catch { /* already exited */ }
    } else {
      this.proc.kill();
    }
    this.proc = null;
    this.buffer = "";
  }

  kill(): void {
    this.killCurrentProc();
    this.pendingFirstMessage = false;
    if (this.logStream) {
      try { this.logStream.end(); } catch { /* */ }
      this.logStream = null;
    }
  }

  get running(): boolean {
    return this.proc !== null || this.pendingFirstMessage;
  }

  /** Get the saved Gemini session ID for resume */
  getSessionId(): string | null {
    return this.savedSessionId;
  }
}
