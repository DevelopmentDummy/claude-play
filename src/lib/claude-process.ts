import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface ClaudeProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";

  /**
   * Spawn claude -p in the given directory.
   * If resumeId is provided, resumes that session with --resume.
   * CLAUDE.md in cwd is auto-loaded by Claude Code.
   */
  spawn(cwd: string, resumeId?: string): void {
    if (this.proc) {
      this.kill();
    }

    // Build clean env: remove CLAUDE_CODE vars to prevent nested session errors
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
        delete env[key];
      }
    }

    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    this.proc = spawn("claude", args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    this.emit("status", "connected");

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf-8"));
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        this.emit("error", text);
      }
    });

    this.proc.on("error", (err) => {
      this.emit("error", `Failed to start claude: ${err.message}`);
      this.emit("status", "disconnected");
    });

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.buffer = "";
      this.emit("exit", code);
      this.emit("status", "disconnected");
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
      try {
        const parsed = JSON.parse(trimmed);

        // Capture session_id from init message
        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.type === "system" &&
          parsed.subtype === "init" &&
          parsed.session_id
        ) {
          this.emit("sessionId", parsed.session_id);
        }

        this.emit("message", parsed);
      } catch {
        // Not valid JSON – ignore
      }
    }
  }

  send(text: string): void {
    if (!this.proc?.stdin?.writable) {
      this.emit("error", "Claude process not running");
      return;
    }

    const msg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: text,
      },
    });

    this.proc.stdin.write(msg + "\n");
    this.emit("status", "streaming");
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.buffer = "";
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
