import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
export interface CodexProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

/**
 * CodexProcess wraps `codex app-server` as a persistent JSON-RPC 2.0 process.
 *
 * Unlike the old `codex exec` approach (per-turn spawn), app-server stays alive
 * and communicates via JSON-RPC over stdin/stdout. Threads are created/resumed
 * via RPC calls, and turns stream notifications back.
 */
export class CodexProcess extends EventEmitter<CodexProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private logStream: fs.WriteStream | null = null;

  private cwd = "";
  private threadId: string | null = null;
  private model: string | undefined;
  private effort: string | undefined;

  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();

  private initialized = false;
  private threadCreated = false;

  /**
   * Ensure a directory is registered as a trusted project in ~/.codex/config.toml.
   * Codex ignores project-level config.toml (MCP servers, instructions) for untrusted dirs.
   */
  private ensureCodexTrust(dir: string): void {
    const globalConfig = path.join(os.homedir(), ".codex", "config.toml");
    // Codex uses \\?\ prefix on Windows for trust keys
    const trustKey = process.platform === "win32"
      ? `'\\\\?\\${dir.replace(/\//g, "\\")}'`
      : `'${dir}'`;
    const sectionHeader = `[projects.${trustKey}]`;

    let content = "";
    if (fs.existsSync(globalConfig)) {
      content = fs.readFileSync(globalConfig, "utf-8");
      // Already trusted — skip
      if (content.includes(sectionHeader)) return;
    }

    // Append trust entry
    const entry = `\n${sectionHeader}\ntrust_level = "trusted"\n`;
    fs.appendFileSync(globalConfig, entry, "utf-8");
  }

  private parseOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (this.logStream) {
      this.logStream.write(`[recv] ${trimmed}\n`);
    }

    try {
      const parsed = JSON.parse(trimmed);
      this.handleJsonRpcMessage(parsed);
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
   * Start the codex app-server process and perform the initialize handshake.
   */
  spawn(cwd: string, resumeId?: string, model?: string, _appendSystemPrompt?: string, effort?: string): void {
    if (this.proc) {
      this.kill();
    }

    this.cwd = cwd;
    this.threadId = resumeId || null;
    this.model = model;
    this.effort = effort;
    this.initialized = false;
    this.threadCreated = false;
    this.requestId = 0;
    this.pendingRequests.clear();

    // Start log stream
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, "codex-stream.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream.write(`\n--- app-server init ${new Date().toISOString()} model: ${model || "default"} threadId: ${resumeId || "new"} ---\n`);

    // Build clean env
    const env = { ...process.env, BROWSER: "" } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
        delete (env as Record<string, string | undefined>)[key];
      }
    }
    // Force UTF-8 locale to mitigate CLI-side CJK buffer boundary corruption
    env.LANG = env.LANG || "en_US.UTF-8";
    env.LC_ALL = env.LC_ALL || "en_US.UTF-8";
    env.PYTHONIOENCODING = "utf-8";

    // Build app-server startup args
    const args: string[] = ["app-server"];

    // Sandbox: full access
    args.push("-c", 'sandbox="danger-full-access"');
    const reasoningEffort = this.effort || "medium";
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);

    // Ensure cwd is registered as a trusted project in global ~/.codex/config.toml.
    // Codex ignores project .codex/config.toml (including MCP settings) unless the
    // directory is explicitly trusted. We add it automatically before each spawn.
    this.ensureCodexTrust(cwd);

    if (this.logStream) {
      this.logStream.write(`[start] args: codex ${args.join(" ")}\n`);
    }

    // Spawn persistent app-server process
    const cmd = process.platform === "win32" ? "codex.cmd" : "codex";
    this.proc = spawn(cmd, args, {
      env,
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const proc = this.proc;

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
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdout(stdoutDecoder.write(chunk));
    });
    proc.stdout!.on("end", flushStdout);
    proc.stdout!.on("close", flushStdout);

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk).trim();
      if (text) {
        if (this.logStream) this.logStream.write(`[stderr] ${text}\n`);
        // Don't emit all stderr as errors — app-server logs info to stderr
      }
    });
    proc.stderr!.on("end", flushStderr);
    proc.stderr!.on("close", flushStderr);

    proc.on("error", (err) => {
      this.emit("error", `Failed to start codex app-server: ${err.message}`);
      this.emit("status", "disconnected");
    });

    proc.on("close", (code) => {
      if (this.logStream) this.logStream.write(`[exit] code=${code}\n`);
      this.proc = null;
      this.initialized = false;
      this.threadCreated = false;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("Process exited"));
      }
      this.pendingRequests.clear();
      this.emit("status", "disconnected");
    });

    // Perform initialize handshake
    this.performInitialize();
  }

  /**
   * Send initialize handshake, then emit "connected".
   */
  private async performInitialize(): Promise<void> {
    try {
      await this.sendRequest("initialize", {
        clientInfo: { name: "claude-play", version: "1.0.0" },
      });

      // Send initialized notification (no id, no response expected)
      this.sendNotification("initialized", {});
      this.initialized = true;

      if (this.logStream) this.logStream.write(`[init] handshake complete\n`);
      this.emit("status", "connected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.logStream) this.logStream.write(`[init] handshake failed: ${msg}\n`);
      this.emit("error", `App server handshake failed: ${msg}`);
      this.emit("status", "disconnected");
    }
  }

  isRunning(): boolean {
    return !!(this.proc && this.initialized);
  }

  /**
   * Send a user message. Creates/resumes thread if needed, then starts a turn.
   */
  async send(text: string): Promise<void> {
    if (!this.proc || !this.initialized) {
      this.emit("error", "Codex app-server not initialized");
      return;
    }

    try {
      // Ensure we have a thread
      if (!this.threadCreated) {
        await this.ensureThread();
      }

      if (!this.threadId) {
        this.emit("error", "Failed to create thread");
        return;
      }

      this.emit("status", "streaming");

      if (this.logStream) {
        this.logStream.write(`[turn] thread=${this.threadId} prompt: ${text.substring(0, 100)}\n`);
      }

      // Start turn (fire-and-forget, notifications stream back)
      // System prompt is delivered via .codex/model-instructions.md (file-based),
      // so baseInstructions is not needed here.
      const params: Record<string, unknown> = {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      };
      if (this.model) {
        params.model = this.model;
      }

      this.sendRequestNoWait("turn/start", params);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("error", msg);
      this.emit("status", "connected");
    }
  }

  /**
   * Create or resume a thread.
   */
  private async ensureThread(): Promise<void> {
    // System prompt is delivered via .codex/model-instructions.md (file-based),
    // so baseInstructions is not needed for thread creation.
    const params: Record<string, unknown> = {};

    if (this.cwd) params.cwd = this.cwd;
    if (this.model) params.model = this.model;
    params.sandbox = "danger-full-access";
    params.approvalPolicy = "never";

    if (this.threadId) {
      // Try to resume
      if (this.logStream) this.logStream.write(`[thread] resuming ${this.threadId}\n`);
      try {
        const result = await this.sendRequest("thread/resume", { threadId: this.threadId, cwd: this.cwd }) as Record<string, unknown>;
        const threadData = result.thread as Record<string, unknown> | undefined;
        const resumedId = threadData?.id as string || result.threadId as string;
        if (resumedId) {
          this.threadCreated = true;
          if (this.logStream) this.logStream.write(`[thread] resumed ${resumedId}\n`);
          return;
        }
      } catch {
        if (this.logStream) this.logStream.write(`[thread] resume failed, creating new\n`);
      }
      // Resume failed — create new
      this.threadId = null;
    }

    // Create new thread
    if (this.logStream) this.logStream.write(`[thread] creating new\n`);
    const result = await this.sendRequest("thread/start", params) as Record<string, unknown>;
    const threadData = result.thread as Record<string, unknown> | undefined;
    const newId = threadData?.id as string || result.threadId as string;
    if (!newId) {
      throw new Error(`thread/start did not return thread.id: ${JSON.stringify(result)}`);
    }
    this.threadId = newId;
    this.threadCreated = true;
    this.emit("sessionId", newId);
    if (this.logStream) this.logStream.write(`[thread] created ${newId}\n`);
  }

  // ─── JSON-RPC helpers ────────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown>, timeout = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.requestId++;
      const id = this.requestId;

      const message = { method, params, id };
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(message);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  private sendRequestNoWait(method: string, params: Record<string, unknown>): void {
    this.requestId++;
    const message = { method, params, id: this.requestId };
    this.writeMessage(message);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    // Notifications have no id
    const message = { method, params };
    this.writeMessage(message);
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    const line = JSON.stringify(message) + "\n";
    if (this.logStream) this.logStream.write(`[send] ${line}`);
    try {
      this.proc.stdin.write(line);
    } catch {
      // stdin closed
    }
  }

  // ─── Stdout parsing ──────────────────────────────────────────────

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
        const parsed = JSON.parse(trimmed);
        this.handleJsonRpcMessage(parsed);
      } catch {
        // Not valid JSON — ignore
      }
    }
  }

  /**
   * Handle incoming JSON-RPC messages: responses and notifications.
   */
  private handleJsonRpcMessage(msg: Record<string, unknown>): void {
    // Response (has 'id' + 'result' or 'error')
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const id = msg.id as number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if ("error" in msg) {
          pending.reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification — route by method
    const method = msg.method as string;
    const params = (msg.params || {}) as Record<string, unknown>;

    switch (method) {
      case "turn/started":
        this.emit("status", "streaming");
        break;

      case "item/agentMessage/delta": {
        const delta = params.delta as string;
        if (delta) {
          this.emit("message", {
            type: "assistant",
            subtype: "text_delta",
            message: {
              role: "assistant",
              content: delta,
            },
          });
        }
        break;
      }

      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;

        if (itemType === "agentMessage" || itemType === "agent_message") {
          // Full message on completion (may be redundant with deltas)
          // Don't emit — deltas already streamed the content
        }

        if (itemType === "mcpToolCall" || itemType === "mcp_tool_call") {
          const name = item.name as string || "unknown";
          let input: unknown = {};
          try {
            const args = item.arguments;
            input = typeof args === "string" ? JSON.parse(args) : args;
          } catch {
            input = { raw: item.arguments };
          }
          this.emit("message", {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                name,
                input,
              }],
            },
          });
        }

        if (itemType === "functionCall" || itemType === "function_call") {
          const name = (item.name as string) || (item.callId as string) || "unknown";
          let input: unknown = {};
          try {
            const args = item.arguments;
            input = typeof args === "string" ? JSON.parse(args) : args;
          } catch {
            input = { raw: item.arguments };
          }
          this.emit("message", {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                name,
                input,
              }],
            },
          });
        }
        break;
      }

      case "item/execError": {
        const errorMsg = (params.message as string) || (params.error as string) || "Execution error";
        this.emit("error", errorMsg);
        break;
      }

      case "turn/completed": {
        const status = params.status as string;
        if (status === "failed") {
          const errorInfo = params.codexErrorInfo as Record<string, unknown> | undefined;
          const errorMsg = (errorInfo?.message as string) || "Turn failed";
          this.emit("error", errorMsg);
        }

        this.emit("message", { type: "result" });
        this.emit("status", "connected");
        break;
      }

      case "item/reasoning/textDelta": {
        // Reasoning/thinking delta — can emit for UI display if desired
        break;
      }

      default:
        // Unknown notification — log but don't emit
        break;
    }
  }

  // ─── MCP config parsing ──────────────────────────────────────────

  // ─── Process lifecycle ───────────────────────────────────────────

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
    this.initialized = false;
    this.threadCreated = false;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Killed"));
    }
    this.pendingRequests.clear();
    if (this.logStream) {
      try { this.logStream.end(); } catch { /* */ }
      this.logStream = null;
    }
  }

  get running(): boolean {
    return !!this.proc && this.initialized;
  }

  /** Get the current thread ID for resume */
  getThreadId(): string | null {
    return this.threadId;
  }

  /** Query account rate limits via JSON-RPC */
  async getRateLimits(): Promise<unknown> {
    if (!this.isRunning()) return null;
    try {
      return await this.sendRequest("account/rateLimits/read", {}, 10000);
    } catch {
      return null;
    }
  }
}
