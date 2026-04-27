import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

  // Track whether any delta events were received in the current turn
  private seenDeltaInTurn = false;
  // Gemini 3 streams thinking text as regular message deltas, terminated by "[Thought: true]".
  // We buffer until the marker flushes (keeping only post-marker content) or a tool_use arrives.
  private thinkingBuffer = "";
  private thinkingDone = false;

  /**
   * Ensure a directory is registered as trusted in ~/.gemini/trustedFolders.json.
   * Gemini CLI ignores .gemini/settings.json (including MCP servers) for untrusted dirs.
   */
  private ensureGeminiTrust(dir: string): void {
    const trustFile = path.join(os.homedir(), ".gemini", "trustedFolders.json");
    let trusted: Record<string, string> = {};
    if (fs.existsSync(trustFile)) {
      try { trusted = JSON.parse(fs.readFileSync(trustFile, "utf-8")); } catch { /* ignore */ }
    }
    const normalizedDir = dir.replace(/\//g, "\\");
    // Check if already trusted (exact match or parent directory is trusted)
    for (const [folder, level] of Object.entries(trusted)) {
      if (level !== "TRUST_FOLDER") continue;
      const normalizedFolder = folder.replace(/\//g, "\\");
      if (normalizedDir === normalizedFolder || normalizedDir.startsWith(normalizedFolder + "\\")) return;
    }
    trusted[normalizedDir] = "TRUST_FOLDER";
    fs.mkdirSync(path.dirname(trustFile), { recursive: true });
    fs.writeFileSync(trustFile, JSON.stringify(trusted, null, 2), "utf-8");
  }

  private parseOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (this.logStream) {
      this.logStream.write(`[recv] ${trimmed}\n`);
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      this.handleGeminiEvent(parsed);
    } catch {
      // Not valid JSON; ignore.
    }
  }

  private flushStdoutBuffer(): void {
    if (!this.buffer) return;
    const trailing = this.buffer;
    this.buffer = "";
    this.parseOutputLine(trailing);
  }

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
    this.savedSessionId = resumeId || null;
    this.pendingFirstMessage = true;
    this.seenDeltaInTurn = false;
    this.thinkingBuffer = "";
    this.thinkingDone = false;

    // Ensure cwd is trusted so Gemini loads .gemini/settings.json (MCP config)
    this.ensureGeminiTrust(cwd);

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

    // Always pipe prompt via stdin to avoid Windows shell quoting issues with -p.
    // --output-format stream-json implies non-interactive (headless) mode.
    const args: string[] = [];
    args.push("--output-format", "stream-json", "--yolo");

    if (this.spawnModel) {
      // "gemini-auto" → pass "auto" to let Gemini CLI pick the best model
      const model = this.spawnModel === "gemini-auto" ? "auto" : this.spawnModel;
      args.push("--model", model);
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
    // Force UTF-8 locale to mitigate CLI-side CJK buffer boundary corruption
    env.LANG = env.LANG || "en_US.UTF-8";
    env.LC_ALL = env.LC_ALL || "en_US.UTF-8";
    env.PYTHONIOENCODING = "utf-8";

    if (this.logStream) {
      this.logStream.write(
        `[spawn] ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}${resumeId ? ` (stdin: ${prompt.substring(0, 80)})` : ""}\n`,
      );
    }

    this.buffer = "";
    this.seenDeltaInTurn = false;
    this.thinkingBuffer = "";
    this.thinkingDone = false;

    this.proc = spawn(cmd, args, {
      env,
      cwd: this.spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    // Always pipe prompt via stdin to avoid Windows shell quoting issues
    if (this.proc.stdin) {
      this.proc.stdin.write(prompt);
      this.proc.stdin.end();
    }

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    let stdoutFlushed = false;
    let stderrFlushed = false;
    const flushStdout = () => {
      if (stdoutFlushed) return;
      stdoutFlushed = true;
      const tail = stdoutDecoder.end();
      if (tail) {
        this.handleStdout(tail);
      }
      this.flushStdoutBuffer();
    };
    const flushStderr = () => {
      if (stderrFlushed) return;
      stderrFlushed = true;
      const tail = stderrDecoder.end().trim();
      if (tail && this.logStream) {
        this.logStream.write(`[stderr] ${tail}\n`);
      }
    };
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdout(stdoutDecoder.write(chunk));
    });
    this.proc.stdout!.on("end", flushStdout);
    this.proc.stdout!.on("close", flushStdout);

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk).trim();
      if (text) {
        if (this.logStream) this.logStream.write(`[stderr] ${text}\n`);
        // Gemini may log progress info to stderr — only surface real errors
      }
    });
    this.proc.stderr!.on("end", flushStderr);
    this.proc.stderr!.on("close", flushStderr);

    this.proc.on("error", (err) => {
      this.emit("error", `Failed to start gemini: ${err.message}`);
      this.emit("status", "disconnected");
    });

    this.proc.on("close", (code) => {
      if (this.logStream) this.logStream.write(`[exit] code=${code}\n`);
      this.proc = null;
      this.buffer = "";

      if (resumeId && code !== 0) {
        const msg = `Gemini resume failed (exit ${code}) for session ${resumeId}. Refusing to start a new session — prior history would be lost.`;
        console.error(`[gemini-process] ${msg}`);
        this.emit("error", msg);
        this.emit("status", "disconnected");
        this.emit("exit", code);
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
   * Gemini 3 CLI emits thinking as regular assistant message deltas, closing each
   * thinking block with a literal "[Thought: true]" marker. Multiple thinking
   * blocks can chain within a single turn (e.g. "...done.\n[Thought: true]**Next
   * Step**..."). Buffer across deltas so a marker split by chunk boundary still
   * resolves, and only return text that lies after the final marker.
   */
  private extractNonThinking(content: string): string {
    if (this.thinkingDone) return content;
    this.thinkingBuffer += content;
    const marker = "[Thought: true]";
    const lastIdx = this.thinkingBuffer.lastIndexOf(marker);
    if (lastIdx === -1) {
      // Keep tail that might contain a partial marker split across chunks.
      // Anything older than marker.length - 1 chars from the end is safe to discard.
      if (this.thinkingBuffer.length > marker.length) {
        this.thinkingBuffer = this.thinkingBuffer.slice(-(marker.length - 1));
      }
      return "";
    }
    const afterMarker = this.thinkingBuffer.slice(lastIdx + marker.length);
    this.thinkingBuffer = "";
    this.thinkingDone = true;
    return afterMarker.replace(/^\s+/, "");
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
          const emitText = this.extractNonThinking(content);
          if (!emitText) break;
          this.seenDeltaInTurn = true;
          this.emit("message", {
            type: "assistant",
            subtype: "text_delta",
            message: {
              role: "assistant",
              content: emitText,
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
        // A tool_use implies any pre-tool buffered text was internal reasoning —
        // drop it and treat post-tool output as the actual response.
        this.thinkingBuffer = "";
        this.thinkingDone = true;
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
        this.thinkingBuffer = "";
        this.thinkingDone = false;
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

  /** Respawn with the last used parameters (for recovery after cancel). */
  respawn(): void {
    if (!this.spawnCwd) return;
    this.spawn(this.spawnCwd, undefined, this.spawnModel);
  }

  get running(): boolean {
    return this.proc !== null || this.pendingFirstMessage;
  }

  /** Get the saved Gemini session ID for resume */
  getSessionId(): string | null {
    return this.savedSessionId;
  }
}
