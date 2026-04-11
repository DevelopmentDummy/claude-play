import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
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

  /**
   * Detect and repair mojibake (Latin-1 mis-decoded UTF-8).
   * If the text contains typical Korean mojibake patterns (e.g. ì, ë followed
   * by continuation-range chars), try reversing: treat the string as Latin-1
   * bytes and re-decode as UTF-8. Accept only if the result has more Hangul
   * and no new U+FFFD.
   */
  private static repairMojibake(text: string): string {
    if (!text) return text;
    // Quick check: Korean mojibake typically contains ì (U+00EC), ë (U+00EB),
    // í (U+00ED), ê (U+00EA) followed by chars in 0x80-0xBF range.
    // Also check for Â (U+00C2) which appears in mojibake of UTF-8 2-byte sequences.
    // Skip if text already contains Hangul (U+AC00-U+D7AF) — probably fine.
    const hasHangul = /[\uAC00-\uD7AF]/.test(text);
    const hasMojibake = /[\u00C2-\u00C3\u00E0-\u00EF][\u0080-\u00BF]/.test(text);
    if (hasHangul || !hasMojibake) return text;

    try {
      const fixed = Buffer.from(text, "latin1").toString("utf8");
      // Accept only if result has Hangul and no new FFFD
      const fixedHasHangul = /[\uAC00-\uD7AF]/.test(fixed);
      const fixedHasFffd = fixed.includes("\ufffd");
      const origHasFffd = text.includes("\ufffd");
      if (fixedHasHangul && (!fixedHasFffd || origHasFffd)) {
        return fixed;
      }
    } catch {
      // Reversal failed; return original.
    }
    return text;
  }

  /** Walk a parsed CLI message and repair mojibake in all text fields in-place. */
  private static healMessage(msg: Record<string, unknown>): void {
    const repair = ClaudeProcess.repairMojibake;

    // stream_event > event > delta > text
    if (msg.type === "stream_event") {
      const event = msg.event as Record<string, unknown> | undefined;
      if (event) {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.text === "string") {
          delta.text = repair(delta.text);
        }
      }
    }

    // assistant > message > content (string or array of blocks)
    if (msg.type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      if (message) {
        if (typeof message.content === "string") {
          message.content = repair(message.content);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              b.text = repair(b.text);
            }
          }
        }
      }
    }

    // result (string or { text: string })
    if (msg.type === "result") {
      if (typeof msg.result === "string") {
        msg.result = repair(msg.result);
      } else if (msg.result && typeof msg.result === "object") {
        const r = msg.result as Record<string, unknown>;
        if (typeof r.text === "string") {
          r.text = repair(r.text);
        }
      }
    }
  }

  private parseOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed);

      if (this.logStream) {
        if (parsed?.type === "system") {
          this.logStream.write(`[system] ${trimmed}\n`);
        } else if (parsed?.type === "stream_event" || parsed?.type === "assistant" || parsed?.type === "result") {
          // Log raw line for UTF-8 diagnostics (truncate to 2000 chars)
          this.logStream.write(`[${parsed.type}] ${trimmed.length > 2000 ? trimmed.slice(0, 2000) + "..." : trimmed}\n`);
        }
      }

      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.type === "system" &&
        parsed.subtype === "init" &&
        parsed.session_id
      ) {
        this.emit("sessionId", parsed.session_id);
      }

      // Repair mojibake in text fields before emitting
      if (parsed && typeof parsed === "object") {
        ClaudeProcess.healMessage(parsed as Record<string, unknown>);
      }

      this.emit("message", parsed);
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

  // Store spawn parameters for retry on resume failure
  private lastSpawnParams: { cwd: string; model?: string; appendSystemPrompt?: string; effort?: string; skipPermissions?: boolean } | null = null;

  /**
   * Spawn claude -p in the given directory.
   * If resumeId is provided, resumes that session with --resume.
   * CLAUDE.md in cwd is auto-loaded by Claude Code.
   */
  spawn(cwd: string, resumeId?: string, model?: string, appendSystemPrompt?: string, effort?: string, skipPermissions = true): void {
    // Save params for potential retry (without resumeId)
    this.lastSpawnParams = { cwd, model, appendSystemPrompt, effort, skipPermissions };
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
    // Force UTF-8 locale to mitigate CLI-side CJK buffer boundary corruption
    env.LANG = env.LANG || "en_US.UTF-8";
    env.LC_ALL = env.LC_ALL || "en_US.UTF-8";
    env.PYTHONIOENCODING = "utf-8";

    const args = [
      "-p",
      ...(skipPermissions ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]),
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
      if (tail) {
        this.emit("error", tail);
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
        // Suppress resume-failure errors — they trigger auto-retry via the close handler
        if (resumeId && /No conversation found|session.*not found/i.test(text)) {
          console.log("[claude-process] Resume error (will retry):", text);
          return;
        }
        this.emit("error", text);
      }
    });
    this.proc.stderr!.on("end", flushStderr);
    this.proc.stderr!.on("close", flushStderr);

    this.proc.on("error", (err) => {
      this.emit("error", `Failed to start claude: ${err.message}`);
      this.emit("status", "disconnected");
    });

    this.proc.on("close", (code) => {
      this.proc = null;
      this.buffer = "";

      // If resume failed (quick exit), retry without resume but keep other params
      if (resumeId && code !== 0) {
        console.log("[claude-process] Resume failed, retrying without --resume");
        const params = this.lastSpawnParams;
        this.spawn(
          params?.cwd || cwd,
          undefined,
          params?.model,
          params?.appendSystemPrompt,
          params?.effort,
          params?.skipPermissions,
        );
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
      this.parseOutputLine(line);
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
