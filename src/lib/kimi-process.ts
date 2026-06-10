import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface KimiProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

function normalizeForSearch(value: string): string {
  return path.normalize(value).replace(/\\/g, "/").toLowerCase();
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readHead(filePath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const st = fs.statSync(filePath);
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * KimiProcess wraps `kimi --wire` as a persistent JSON-RPC 2.0 process.
 *
 * Wire is Kimi Code CLI's app-server-like protocol: one long-lived process,
 * stdin/stdout JSON-RPC, prompt requests, streaming ContentPart notifications,
 * cancellation, and tool approval requests.
 */
export class KimiProcess extends EventEmitter<KimiProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private logStream: fs.WriteStream | null = null;
  private logName = "kimi-stream.log";

  private cwd = "";
  private model: string | undefined;
  private effort: string | undefined;
  private appendSystemPrompt = "";
  private spawnStartedAt = 0;
  private initialized = false;
  /** Session id resolved for the CURRENT spawn. findKimiSessionId() is a cwd+mtime
   *  heuristic, and multiple KimiProcess instances (main narrator + sub-agents) can
   *  share the same cwd — a later scan may pick up the OTHER process's conversation.
   *  Once resolved (or seeded from a resumeId), we stick to it until the next spawn(). */
  private resolvedSessionId: string | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    super();
    // Permanent no-op "error" listener. EventEmitter throws (crashing the dev
    // server) when "error" is emitted with zero listeners — which can happen if
    // a late async error fires after the consumer removed its listeners on
    // destroy(). Real errors still reach the session-instance "error" listener
    // when attached; this only guarantees there is always ≥1 listener. Mirrors
    // AntigravityProcess.
    this.on("error", () => { /* swallowed — real handling via session-instance listener */ });
  }

  spawn(
    cwd: string,
    resumeId?: string,
    model?: string,
    _appendSystemPrompt?: string,
    _effort?: string,
    _skipPermissions?: boolean,
    logName?: string,
  ): void {
    if (this.proc) {
      this.kill();
    }

    this.cwd = cwd;
    this.model = model === "kimi-auto" ? undefined : model;
    this.effort = _effort;
    this.appendSystemPrompt = (_appendSystemPrompt || "").trim();
    this.spawnStartedAt = Date.now() - 1000;
    // Reset stickiness per spawn: a fresh spawn legitimately creates a new conversation.
    // When resuming, the resumeId IS the conversation id — treat it as resolved up front.
    this.resolvedSessionId = resumeId || null;
    this.initialized = false;
    this.requestId = 0;
    this.pendingRequests.clear();

    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    if (logName) this.logName = logName;
    const logPath = path.join(cwd, this.logName);
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logStream.on("error", () => { this.logStream = null; });
    this.logStream.write(
      `\n--- wire init ${new Date().toISOString()} model: ${model || "default"} resumeId: ${resumeId || "same cwd"} ---\n`,
    );

    const cmd = process.platform === "win32" ? "kimi.exe" : "kimi";
    const args = ["--wire", "--yolo"];
    if (this.model) {
      args.push("--model", this.model);
    }
    if (_effort === "thinking") {
      args.push("--thinking");
    } else if (_effort === "no-thinking") {
      args.push("--no-thinking");
    }
    if (resumeId) {
      args.push("--resume", resumeId);
    }

    const mcpConfigPath = path.join(cwd, ".mcp.json");
    if (fs.existsSync(mcpConfigPath)) {
      args.push("--mcp-config-file", mcpConfigPath);
    }

    const agentFilePath = this.writeRuntimeAgentFiles(cwd, this.appendSystemPrompt);
    if (agentFilePath) {
      args.push("--agent-file", agentFilePath);
    }

    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
        delete (env as Record<string, string | undefined>)[key];
      }
    }
    env.LANG = env.LANG || "en_US.UTF-8";
    env.LC_ALL = env.LC_ALL || "en_US.UTF-8";
    env.PYTHONIOENCODING = "utf-8";
    env.PYTHONUTF8 = "1";

    if (this.logStream) {
      this.logStream.write(`[start] ${cmd} ${args.join(" ")}\n`);
    }

    this.proc = spawn(cmd, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    let stdoutFlushed = false;
    let stderrFlushed = false;

    const flushStdout = () => {
      if (stdoutFlushed) return;
      stdoutFlushed = true;
      const tail = stdoutDecoder.end();
      if (tail) this.handleStdout(tail);
      this.flushBuffer();
    };

    const flushStderr = () => {
      if (stderrFlushed) return;
      stderrFlushed = true;
      const tail = stderrDecoder.end().trim();
      if (tail && this.logStream) this.logStream.write(`[stderr] ${tail}\n`);
    };

    this.proc.stdout?.on("data", (chunk: Buffer) => this.handleStdout(stdoutDecoder.write(chunk)));
    this.proc.stdout?.on("end", flushStdout);
    this.proc.stdout?.on("close", flushStdout);

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text && this.logStream) this.logStream.write(`[stderr] ${text}`);
    });
    this.proc.stderr?.on("end", flushStderr);
    this.proc.stderr?.on("close", flushStderr);

    this.proc.on("error", (err) => {
      this.emit("error", `Failed to start kimi wire server: ${err.message}`);
      this.emit("status", "disconnected");
    });

    this.proc.on("close", (code) => {
      if (this.logStream) this.logStream.write(`[exit] code=${code}\n`);
      this.proc = null;
      this.initialized = false;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("Process exited"));
      }
      this.pendingRequests.clear();
      this.emit("exit", code);
      this.emit("status", "disconnected");
    });

    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await this.sendRequest("initialize", {
        protocol_version: "1.9",
        client: { name: "claude-play", version: "1.0.0" },
        capabilities: { supports_question: false, supports_plan_mode: false },
      });
      this.initialized = true;
      if (this.logStream) this.logStream.write("[init] handshake complete\n");
      this.emitKimiSessionId();
      this.emit("status", "connected");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.logStream) this.logStream.write(`[init] handshake failed: ${msg}\n`);
      this.emit("error", `Kimi wire handshake failed: ${msg}`);
      this.emit("status", "disconnected");
    }
  }

  send(text: string): void {
    if (!this.proc || !this.initialized) {
      this.emit("error", "Kimi wire server not initialized");
      return;
    }

    this.emit("status", "streaming");
    this.sendRequestNoWait("prompt", { user_input: text });
  }

  sendToolResult(_toolUseId: string, _content: string): void {
    console.warn(`[${this.constructor.name}] sendToolResult not implemented — AskUserQuestion is Claude-only for now`);
  }

  isRunning(): boolean {
    return !!this.proc && this.initialized;
  }

  async waitForReady(timeoutMs = 20_000): Promise<boolean> {
    if (this.isRunning()) return true;
    if (!this.proc) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("status", onStatus);
        this.off("error", onError);
        this.off("exit", onExit);
        resolve(ok);
      };
      const onStatus = (s: string) => { if (s === "connected") finish(true); };
      const onError = () => finish(false);
      const onExit = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.on("status", onStatus);
      this.on("error", onError);
      this.on("exit", onExit);
      if (this.isRunning()) finish(true);
    });
  }

  respawn(): void {
    if (!this.cwd) return;
    this.spawn(this.cwd, undefined, this.model, this.appendSystemPrompt, this.effort);
  }

  private writeRuntimeAgentFiles(cwd: string, appendSystemPrompt: string): string | null {
    if (!appendSystemPrompt) return null;

    const kimiDir = path.join(cwd, ".kimi");
    fs.mkdirSync(kimiDir, { recursive: true });

    const systemPromptPath = path.join(kimiDir, "claude-play-system.md");
    const agentFilePath = path.join(kimiDir, "claude-play-agent.yaml");

    const systemPrompt = [
      "# Claude Play Runtime",
      "",
      "You are running inside Claude Play, an interactive roleplay bridge.",
      "Follow the project/session instructions from AGENTS.md and the runtime service guide below.",
      "",
      "## Current Runtime",
      "",
      "- Current time: ${KIMI_NOW}",
      "- Working directory: ${KIMI_WORK_DIR}",
      "",
      "## Session Instructions",
      "",
      "${KIMI_AGENTS_MD}",
      "",
      "## Available Skills",
      "",
      "${KIMI_SKILLS}",
      "",
      "## Claude Play Service Guide",
      "",
      appendSystemPrompt,
      "",
    ].join("\n");

    const agentYaml = [
      "version: 1",
      "agent:",
      "  name: claude-play",
      "  extend: default",
      "  system_prompt_path: ./claude-play-system.md",
      "",
    ].join("\n");

    fs.writeFileSync(systemPromptPath, systemPrompt, "utf-8");
    fs.writeFileSync(agentFilePath, agentYaml, "utf-8");
    return agentFilePath;
  }

  kill(): void {
    this.killCurrentProc();
    this.initialized = false;
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

  private sendRequest(method: string, params: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(++this.requestId);
      this.pendingRequests.set(id, { method, resolve, reject });
      this.writeMessage({ jsonrpc: "2.0", method, id, params });

      const timer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return;
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
    });
  }

  private sendRequestNoWait(method: string, params: Record<string, unknown>): void {
    const id = String(++this.requestId);
    this.pendingRequests.set(id, {
      method,
      resolve: () => undefined,
      reject: (err) => this.emit("error", err.message),
    });
    this.writeMessage({ jsonrpc: "2.0", method, id, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return;
    const line = JSON.stringify(message) + "\n";
    if (this.logStream) this.logStream.write(`[send] ${line}`);
    this.proc.stdin.write(line);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      this.parseLine(line);
    }
  }

  private flushBuffer(): void {
    if (!this.buffer.trim()) return;
    const line = this.buffer;
    this.buffer = "";
    this.parseLine(line);
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.logStream) this.logStream.write(`[recv] ${trimmed}\n`);

    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      this.handleJsonRpc(msg);
    } catch {
      // Ignore non-JSON output.
    }
  }

  private handleJsonRpc(msg: Record<string, unknown>): void {
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const id = String(msg.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if ("error" in msg) {
          const err = msg.error as Record<string, unknown>;
          const message = (err?.message as string) || JSON.stringify(err);
          pending.reject(new Error(message));
          if (pending.method === "prompt") this.emit("status", "connected");
        } else {
          pending.resolve(msg.result);
          if (pending.method === "prompt") {
            this.emit("message", { type: "result" });
            this.emitKimiSessionId();
            this.emit("status", "connected");
          }
        }
      }
      return;
    }

    const method = msg.method as string;
    if (method === "event") {
      this.handleWireEvent((msg.params || {}) as Record<string, unknown>);
    } else if (method === "request") {
      this.handleWireRequest(msg);
    }
  }

  private handleWireEvent(params: Record<string, unknown>): void {
    const type = params.type as string;
    const payload = (params.payload || {}) as Record<string, unknown>;

    if (type === "ContentPart") {
      if (payload.type === "text" && typeof payload.text === "string") {
        this.emit("message", {
          type: "assistant",
          subtype: "text_delta",
          message: {
            role: "assistant",
            content: payload.text,
          },
        });
      }
      return;
    }

    if (type === "ToolCall") {
      const name = (payload.name as string) || (payload.sender as string) || "unknown";
      this.emit("message", {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            name,
            input: payload,
          }],
        },
      });
      return;
    }

    if (type === "TurnEnd") {
      // The prompt response follows TurnEnd and emits the shared result event.
      return;
    }

    if (type === "StatusUpdate" && typeof payload.status === "string") {
      this.emit("status", payload.status === "idle" ? "connected" : "streaming");
    }
  }

  private handleWireRequest(msg: Record<string, unknown>): void {
    const id = String(msg.id);
    const params = (msg.params || {}) as Record<string, unknown>;
    const type = params.type as string;
    const payload = (params.payload || {}) as Record<string, unknown>;

    if (type === "ApprovalRequest") {
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          request_id: payload.id,
          response: "approve",
        },
      });
      return;
    }

    if (type === "QuestionRequest") {
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          request_id: payload.id,
          answers: {},
        },
      });
      return;
    }

    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported Kimi wire request: ${type}` },
    });
  }

  private emitKimiSessionId(): void {
    const sessionId = this.findKimiSessionId();
    if (!sessionId) return;
    // Sticky per spawn: once an id is resolved for this spawn, ignore a DIFFERENT id
    // from a later heuristic scan — it may belong to another KimiProcess sharing this
    // cwd (main narrator vs sub-agent in the same session dir).
    if (this.resolvedSessionId && sessionId !== this.resolvedSessionId) {
      if (this.logStream) {
        this.logStream.write(`[session] ignored heuristic id ${sessionId} (sticky: ${this.resolvedSessionId})\n`);
      }
      return;
    }
    this.resolvedSessionId = sessionId;
    if (this.logStream) this.logStream.write(`[session] ${sessionId}\n`);
    this.emit("sessionId", sessionId);
  }

  private findKimiSessionId(): string | null {
    const sessionsRoot = path.join(os.homedir(), ".kimi", "sessions");
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    const cwdNeedle = normalizeForSearch(path.resolve(this.cwd));
    const candidates: Array<{ id: string; dir: string; mtimeMs: number }> = [];
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(sessionsRoot, project.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(projectDir, entry.name);
        const st = safeStat(path.join(dir, "context.jsonl")) || safeStat(path.join(dir, "wire.jsonl")) || safeStat(path.join(dir, "state.json"));
        if (!st) continue;
        candidates.push({ id: entry.name, dir, mtimeMs: st.mtimeMs });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates.slice(0, 100)) {
      const contextPath = path.join(candidate.dir, "context.jsonl");
      const head = readHead(contextPath, 256 * 1024);
      if (head && normalizeForSearch(head).includes(cwdNeedle)) {
        return candidate.id;
      }
    }

    // Fallback for very new sessions before context.jsonl is fully flushed.
    const fresh = candidates.find((candidate) => candidate.mtimeMs >= this.spawnStartedAt);
    return fresh?.id || null;
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
}
