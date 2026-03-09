import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

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
  private logStream: fs.WriteStream | null = null;
 
  private normalizeMcpConfig(mcpConfigPath: string): void {
    try {
      const raw = fs.readFileSync(mcpConfigPath, "utf-8");
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("mcpServers" in parsed)) {
        const normalized = { mcpServers: parsed };
        fs.writeFileSync(mcpConfigPath, JSON.stringify(normalized, null, 2), "utf-8");
      }
    } catch {
      // Keep original file untouched; Claude will report detailed config errors.
    }
  }

  /**
   * Spawn claude -p in the given directory.
   * If resumeId is provided, resumes that session with --resume.
   * CLAUDE.md in cwd is auto-loaded by Claude Code.
   */
  spawn(cwd: string, resumeId?: string, model?: string, appendSystemPrompt?: string, effort?: string): void {
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

    if (model) {
      args.push("--model", model);
    }

    if (effort) {
      args.push("--effort", effort);
    }

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    const runtimeSystemPrompt = (appendSystemPrompt || "").trim();
    if (runtimeSystemPrompt) {
      args.push("--system-prompt", runtimeSystemPrompt);
    }

    const mcpConfigPath = path.join(cwd, ".mcp.json");
    if (fs.existsSync(mcpConfigPath)) {
      this.normalizeMcpConfig(mcpConfigPath);
      args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
    }

    // Start stream log for debugging
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, "claude-stream.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream.write(`\n--- spawn ${new Date().toISOString()} args: ${args.join(" ")} ---\n`);

    this.proc = spawn("claude", args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
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

      // If resume failed (quick exit), retry without resume
      if (resumeId && code !== 0) {
        console.log("[claude-process] Resume failed, retrying without --resume");
        this.spawn(cwd);
        return;
      }

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

        // Log system/init messages for debugging compaction behavior
        if (this.logStream && parsed?.type === "system") {
          this.logStream.write(`[system] ${trimmed}\n`);
        }

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

  isRunning(): boolean {
    return !!(this.proc?.stdin?.writable);
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
      // Remove all listeners from the old process streams to prevent stale events
      this.proc.stdout?.removeAllListeners();
      this.proc.stderr?.removeAllListeners();
      this.proc.removeAllListeners();

      const pid = this.proc.pid;
      if (pid && process.platform === "win32") {
        // On Windows, shell: true creates cmd.exe wrapper;
        // proc.kill() only kills the shell, not the child process tree
        try {
          execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
        } catch { /* already exited */ }
      } else {
        this.proc.kill();
      }
      this.proc = null;
      this.buffer = "";
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
