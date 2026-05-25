import { execSync } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

export const AntigravityModels = {
  GEMINI_FLASH: 1018,
  GEMINI_PRO_LOW: 1164,
  GEMINI_PRO_HIGH: 1165,
} as const;
export type AntigravityModelId = typeof AntigravityModels[keyof typeof AntigravityModels];

export interface AntigravityProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

// Windows CreateProcess command-line limit is 32767 chars. We leave headroom
// for the agy.exe path + other args + arg-quoting overhead.
const MAX_PRIMER_CHARS = 28000;

export class AntigravityProcess extends EventEmitter<AntigravityProcessEvents> {
  private agyPid: number | null = null;
  private lsPort: number | null = null;
  private cascadeId: string | null = null;
  private spawnCwd = "";
  private spawnModelString: string | undefined;
  private modelId: AntigravityModelId = AntigravityModels.GEMINI_FLASH;
  private logStream: fs.WriteStream | null = null;
  private polling = false;
  private lastSeenMessageCount = 0;
  private lastSeenTailLength = 0;
  private initPromise: Promise<void> | null = null;

  spawn(
    cwd: string,
    resumeId?: string,
    model?: string,
    appendSystemPrompt?: string,
    _effort?: string,
    _skipPermissions?: boolean,
  ): void {
    if (this.agyPid) this.kill();

    this.spawnCwd = cwd;
    this.cascadeId = resumeId || null;
    this.spawnModelString = model;
    this.modelId = this.resolveModelId(model);
    this.lastSeenMessageCount = 0;
    this.lastSeenTailLength = 0;

    this.ensureAntigravityTrust(cwd);
    this.openLogStream(cwd);

    const escapePS = (s: string) => s.replace(/'/g, "''");
    const tempDir = path.join(os.tmpdir(), "agy-bridge");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    let tempPrimerPath: string | null = null;
    let psScript: string;

    if (resumeId) {
      // Resume: load existing cascade by ID — no primer needed (cascade already
      // has the primer in its first USER_INPUT step from initial spawn).
      psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `$p = Start-Process -FilePath '${escapePS(AGY_PATH)}' -ArgumentList @('--conversation', '${escapePS(resumeId)}', '--dangerously-skip-permissions') -WorkingDirectory '${escapePS(cwd)}' -WindowStyle Hidden -PassThru`,
        `Write-Output $p.Id`,
      ].join("\n");
      this.writeLog(`spawn(resume): cascadeId=${resumeId}`);
    } else {
      // New session: primer (runtimeSystemPrompt = primer YAML + session-shared
      // + panel actions) goes via --prompt-interactive. agy creates an auto-
      // cascade with this text as the first USER_INPUT step, which the LLM
      // treats as initial system context.
      //
      // The primer is written to a temp file (UTF-8) and read by PowerShell,
      // then escaped for CommandLineToArgvW (\" for inner quotes, with
      // backslash-pairs handled correctly) and wrapped in "..." so that
      // newlines/spaces/Korean/special chars all survive the round-trip.
      let primer = appendSystemPrompt && appendSystemPrompt.length > 0 ? appendSystemPrompt : "_BRIDGE_INIT_";
      if (primer.length > MAX_PRIMER_CHARS) {
        this.writeLog(`WARN: primer truncated ${primer.length} → ${MAX_PRIMER_CHARS}`);
        primer = primer.slice(0, MAX_PRIMER_CHARS);
      }
      tempPrimerPath = path.join(tempDir, `primer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(tempPrimerPath, primer, "utf-8");
      psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `$primer = [System.IO.File]::ReadAllText('${escapePS(tempPrimerPath)}', [System.Text.Encoding]::UTF8)`,
        // Escape per MSDN CommandLineToArgvW: 2n backslashes before " produce n
        // backslashes + delimiter, 2n+1 produce n backslashes + literal ". So
        // we double any backslash run preceding a " and then prefix the " with \.
        `$primerEscaped = $primer -replace '(\\\\*)"', '$1$1\\"'`,
        `$primerArg = '"' + $primerEscaped + '"'`,
        `$argsString = '--prompt-interactive ' + $primerArg + ' --dangerously-skip-permissions'`,
        `$p = Start-Process -FilePath '${escapePS(AGY_PATH)}' -ArgumentList $argsString -WorkingDirectory '${escapePS(cwd)}' -WindowStyle Hidden -PassThru`,
        `Write-Output $p.Id`,
      ].join("\n");
      this.writeLog(`spawn(new): primer=${primer.length}b temp=${tempPrimerPath}`);
    }

    const tempScriptPath = path.join(tempDir, `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    fs.writeFileSync(tempScriptPath, psScript, "utf-8");

    try {
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScriptPath}"`, { encoding: "utf-8" }).trim();
      const pid = Number(out);
      if (!pid || Number.isNaN(pid)) {
        this.emit("error", `Failed to spawn agy: parse pid failed (out=${out})`);
        return;
      }
      this.agyPid = pid;
      this.writeLog(`spawn pid=${pid} cwd=${cwd} model=${this.modelId}`);
    } finally {
      try { fs.unlinkSync(tempScriptPath); } catch { /* */ }
      if (tempPrimerPath) { try { fs.unlinkSync(tempPrimerPath); } catch { /* */ } }
    }

    this.emit("status", "connected");
    // Eager init in background — discover port + reuse auto-cascade + wait for
    // primer-response to reach IDLE. First send() awaits this.
    this.initPromise = this.initialize(resumeId).catch(err => {
      this.writeLog(`init failed: ${err}`);
      this.emit("error", `Antigravity init failed: ${err}`);
    });
  }

  private async initialize(resumeId?: string): Promise<void> {
    const port = this.discoverLsPort();
    if (!port) throw new Error("LS port discovery timeout");
    this.lsPort = port;

    if (resumeId) {
      this.cascadeId = resumeId;
      // Snapshot existing stepCount as baseline so we don't re-emit history
      try {
        const traj = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: resumeId });
        const steps = this.extractItems(traj) || [];
        this.lastSeenMessageCount = steps.length;
        this.writeLog(`init(resume): baseline stepCount=${steps.length}`);
      } catch (err) { this.writeLog(`init(resume): baseline snapshot failed: ${err}`); }
      this.emit("sessionId", resumeId);
      return;
    }

    // New session: poll until agy creates the auto-cascade from --prompt-interactive
    let foundId: string | null = null;
    for (let i = 0; i < 30; i++) {
      try {
        const all = await this.rpc<{ trajectorySummaries?: Record<string, { createdTime?: string }> }>("GetAllCascadeTrajectories", {});
        const summaries = all?.trajectorySummaries || {};
        const ids = Object.keys(summaries);
        if (ids.length > 0) {
          // Pick most recently created
          ids.sort((a, b) => (summaries[b].createdTime || "").localeCompare(summaries[a].createdTime || ""));
          foundId = ids[0];
          break;
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!foundId) throw new Error("agy did not auto-create cascade within 15s");
    this.cascadeId = foundId;
    this.emit("sessionId", foundId);
    this.writeLog(`init(new): reusing auto-cascade ${foundId}`);

    // Wait for LLM's primer-response to finish, then snapshot stepCount as
    // baseline so the user only sees responses to their own messages.
    await this.waitForIdle(foundId);
    try {
      const traj = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: foundId });
      const steps = this.extractItems(traj) || [];
      this.lastSeenMessageCount = steps.length;
      this.lastSeenTailLength = 0;
      this.writeLog(`init(new): baseline after primer-response stepCount=${steps.length}`);
    } catch (err) { this.writeLog(`init(new): baseline snapshot failed: ${err}`); }
  }

  private async waitForIdle(cascadeId: string, timeoutMs = 5 * 60 * 1000): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let consecutiveIdle = 0;
    let everSawRunning = false;
    while (Date.now() < deadline) {
      try {
        const all = await this.rpc<{ trajectorySummaries?: Record<string, { status?: string }> }>("GetAllCascadeTrajectories", {});
        const status = all?.trajectorySummaries?.[cascadeId]?.status;
        if (status === "CASCADE_RUN_STATUS_RUNNING") {
          everSawRunning = true;
          consecutiveIdle = 0;
        } else if (status) {
          consecutiveIdle++;
          // Require 3 consecutive non-RUNNING polls AND have seen RUNNING at
          // least once (to avoid bailing out before primer-response starts).
          if (everSawRunning && consecutiveIdle >= 3) {
            this.writeLog(`waitForIdle: cascade IDLE after ${((Date.now() - startedAt) / 1000).toFixed(1)}s status=${status}`);
            return;
          }
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    this.writeLog(`waitForIdle: timeout after ${timeoutMs / 1000}s, proceeding anyway`);
  }

  send(text: string): void {
    void (async () => {
      if (this.initPromise) await this.initPromise;
      return this._sendAsync(text);
    })().catch(err => {
      this.emit("error", String(err));
      this.emit("status", "connected");
    });
  }

  sendToolResult(_toolUseId: string, _content: string): void {
    this.writeLog("sendToolResult not implemented — AskUserQuestion is Claude-only for now");
  }

  private async _sendAsync(text: string): Promise<void> {
    if (!this.lsPort || !this.cascadeId) {
      this.emit("error", "AntigravityProcess not initialized — call spawn() first and wait for init");
      return;
    }

    this.emit("status", "streaming");

    // No prepend — primer is already the first USER_INPUT step of the cascade
    // via --prompt-interactive at spawn time. User messages are sent as-is.
    // proto3 canonical JSON: oneof는 case/value 래퍼가 아니라 field name 직접 사용
    await this.rpc("SendUserCascadeMessage", {
      cascadeId: this.cascadeId,
      items: [{ chunk: { text } }],
      cascadeConfig: {
        plannerConfig: {
          plannerTypeConfig: { conversational: {} },
          requestedModel: { model: this.modelId },
        },
      },
    });

    this.polling = true;
    this.pollLoop().catch(err => {
      this.emit("error", `Polling failed: ${err}`);
      this.polling = false;
      this.emit("status", "connected");
    });
  }

  private async pollLoop(): Promise<void> {
    const POLL_INTERVAL_MS = 700;
    const MAX_TURN_DURATION_MS = 15 * 60 * 1000; // 전체 max 15분 (긴 sub-agent chain 대응)
    const STATUS_CHECK_EVERY = 2;
    const IDLE_GRACE_TICKS = 5;
    const TRAJECTORY_STABLE_TICKS = 5;
    const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // trajectory 변화 없이 5분 stuck이면 강제 종료
    const turnStart = Date.now();
    let iter = 0;
    let lastTrajKey = "";
    let consecutiveStable = 0;
    let consecutiveIdle = 0;
    let everSawRunning = false;

    while (this.polling && this.cascadeId) {
      if (Date.now() - turnStart > MAX_TURN_DURATION_MS) {
        this.writeLog(`poll: turn timeout after ${MAX_TURN_DURATION_MS / 1000}s`);
        break;
      }

      let conv: Record<string, unknown>;
      try {
        conv = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: this.cascadeId });
      } catch (err) {
        this.writeLog(`poll error: ${err}`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      const dbgSteps = this.extractItems(conv);
      // trajectory의 step 카운트 + 마지막 step body size를 같이 추적
      // — sub-agent chain 마지막 PLANNER_RESPONSE의 response가 batch로 채워질 때
      // step.length는 안 변해도 마지막 step body가 커지는 패턴을 잡기 위함
      const lastStep = dbgSteps && dbgSteps.length > 0 ? dbgSteps[dbgSteps.length - 1] : null;
      const lastStepSize = lastStep ? JSON.stringify(lastStep).length : 0;
      const trajKey = `${dbgSteps?.length ?? 0}:${dbgSteps?.map(s => s.type).join(",") ?? ""}|tail=${lastStepSize}`;
      if (trajKey !== lastTrajKey) {
        this.writeLog(`[poll #${iter}] steps=${dbgSteps?.length ?? 0} tail=${lastStepSize}b lastType=${lastStep?.type ?? "n/a"}`);
        lastTrajKey = trajKey;
        consecutiveStable = 0;
      } else {
        consecutiveStable++;
      }

      this.emitNewChunks(conv);

      iter++;
      if (iter % STATUS_CHECK_EVERY === 0) {
        try {
          const all = await this.rpc<{ trajectorySummaries?: Record<string, { status?: string; stepCount?: number }> }>("GetAllCascadeTrajectories", {});
          const status = all.trajectorySummaries?.[this.cascadeId]?.status;
          const isFinishedStatus =
            status === "CASCADE_RUN_STATUS_SUCCESS" ||
            status === "CASCADE_RUN_STATUS_FAILED" ||
            status === "CASCADE_RUN_STATUS_CANCELLED";

          if (status === "CASCADE_RUN_STATUS_RUNNING") {
            everSawRunning = true;
            consecutiveIdle = 0;
          } else if (status) {
            consecutiveIdle++;
            this.writeLog(`[poll #${iter}] status=${status} idle=${consecutiveIdle}/${IDLE_GRACE_TICKS} traj-stable=${consecutiveStable}/${TRAJECTORY_STABLE_TICKS}`);
            // IDLE + trajectory도 안정 두 조건 동시 충족 시에만 진짜 종료.
            // sub-agent chain 응답 채워지는 동안엔 trajectory size가 변하므로 stable 안 됨.
            if ((everSawRunning || isFinishedStatus) && consecutiveIdle >= IDLE_GRACE_TICKS && consecutiveStable >= TRAJECTORY_STABLE_TICKS) {
              this.writeLog(`[poll #${iter}] cascade idle+stable — turn complete`);
              try {
                const finalConv = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: this.cascadeId });
                this.emitNewChunks(finalConv);
              } catch { /* */ }
              break;
            }
          }
        } catch (err) {
          this.writeLog(`status check error: ${err}`);
        }
      }

      // Safety: trajectory 변화 없이 STUCK_TIMEOUT_MS 경과하면 강제 종료
      if (consecutiveStable * POLL_INTERVAL_MS > STUCK_TIMEOUT_MS) {
        this.writeLog(`[poll #${iter}] no trajectory change for ${STUCK_TIMEOUT_MS / 1000}s, forcing turn end`);
        break;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    this.polling = false;
    this.emit("message", { type: "result" });
    this.emit("status", "connected");
  }

  private emitNewChunks(conv: Record<string, unknown>): boolean {
    const items = this.extractItems(conv);
    if (!items) return false;

    if (items.length > this.lastSeenMessageCount) {
      for (let i = this.lastSeenMessageCount; i < items.length; i++) {
        const it = items[i];
        const role = this.extractRole(it);
        if (role !== "assistant") continue;
        const content = this.extractText(it);
        if (content) {
          this.emit("message", {
            type: "assistant",
            subtype: "text_delta",
            message: { role: "assistant", content },
          });
        }
      }
      this.lastSeenMessageCount = items.length;
      this.lastSeenTailLength = this.extractText(items[items.length - 1])?.length ?? 0;
      return true;
    }

    if (items.length > 0 && items.length === this.lastSeenMessageCount) {
      const last = items[items.length - 1];
      if (this.extractRole(last) === "assistant") {
        const fullText = this.extractText(last) ?? "";
        if (fullText.length > this.lastSeenTailLength) {
          const delta = fullText.slice(this.lastSeenTailLength);
          this.emit("message", {
            type: "assistant",
            subtype: "text_delta",
            message: { role: "assistant", content: delta },
          });
          this.lastSeenTailLength = fullText.length;
          return true;
        }
      }
    }
    return false;
  }

  private extractItems(conv: Record<string, unknown>): Record<string, unknown>[] | null {
    // agy 1.0.0 GetCascadeTrajectory 응답: { trajectory: { steps: [...] } }
    const traj = conv.trajectory as Record<string, unknown> | undefined;
    if (traj && Array.isArray(traj.steps)) return traj.steps as Record<string, unknown>[];
    // 다른 LS 버전 fallback
    if (Array.isArray(conv.items)) return conv.items as Record<string, unknown>[];
    if (Array.isArray(conv.messages)) return conv.messages as Record<string, unknown>[];
    return null;
  }

  private extractRole(item: Record<string, unknown>): string | undefined {
    // agy 1.0.0 step.type 으로 user/assistant 구분
    const type = item.type as string | undefined;
    if (type === "CORTEX_STEP_TYPE_USER_INPUT") return "user";
    if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" || type === "CORTEX_STEP_TYPE_ASSISTANT_RESPONSE" || type === "CORTEX_STEP_TYPE_MODEL_OUTPUT") return "assistant";
    if (type === "CORTEX_STEP_TYPE_ERROR_MESSAGE") return "error";
    // legacy
    const r1 = item.role as string | undefined;
    const r2 = (item.message as Record<string, unknown> | undefined)?.role as string | undefined;
    return r1 || r2;
  }

  private extractText(item: Record<string, unknown>): string | undefined {
    const pr = item.plannerResponse as Record<string, unknown> | undefined;
    if (pr) {
      // 1) 정상 텍스트 응답
      if (typeof pr.response === "string" && pr.response.length > 0) return pr.response;
      if (typeof pr.modifiedResponse === "string" && pr.modifiedResponse.length > 0) return pr.modifiedResponse;
      // 2) tool-only turn: thinking + tool summary로 placeholder
      const parts: string[] = [];
      if (typeof pr.thinking === "string" && pr.thinking.length > 0) parts.push(pr.thinking);
      if (Array.isArray(pr.toolCalls) && pr.toolCalls.length > 0) {
        const names = (pr.toolCalls as Record<string, unknown>[])
          .map(tc => (tc.name || tc.tool || tc.functionName || tc.toolName) as string | undefined)
          .filter((n): n is string => !!n);
        if (names.length) parts.push(`[Tools: ${names.join(", ")}]`);
      }
      if (parts.length > 0) return parts.join("\n\n");
    }
    // legacy / fallback candidates
    const candidates: unknown[] = [
      (item.assistantResponse as Record<string, unknown> | undefined)?.text,
      (item.modelOutput as Record<string, unknown> | undefined)?.text,
      (item.response as Record<string, unknown> | undefined)?.text,
      (item.errorMessage as Record<string, unknown> | undefined)?.error
        && ((item.errorMessage as Record<string, unknown>).error as Record<string, unknown>).userErrorMessage,
      item.content,
      (item.message as Record<string, unknown> | undefined)?.content,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
      if (Array.isArray(c)) {
        const texts = c
          .map(x => (typeof x === "object" && x !== null && "text" in x ? (x as { text: unknown }).text : null))
          .filter((t): t is string => typeof t === "string");
        if (texts.length) return texts.join("");
      }
    }
    return undefined;
  }

  respawn(): void {
    const cid = this.cascadeId;
    this.spawn(this.spawnCwd, cid || undefined, this.spawnModelString);
  }

  isRunning(): boolean {
    return this.agyPid !== null;
  }

  get running(): boolean {
    return this.agyPid !== null;
  }

  async waitForReady(timeoutMs = 60000): Promise<boolean> {
    if (!this.initPromise) return this.isRunning();
    try {
      await Promise.race([
        this.initPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waitForReady timeout")), timeoutMs)),
      ]);
      return this.isRunning() && !!this.cascadeId;
    } catch {
      return false;
    }
  }

  kill(): void {
    if (!this.agyPid) return;
    try { execSync(`taskkill /T /F /PID ${this.agyPid}`, { stdio: "pipe" }); } catch { /* */ }
    this.writeLog(`killed pid=${this.agyPid}`);
    this.agyPid = null;
    this.lsPort = null;
    this.polling = false;
    this.initPromise = null;
    this.emit("status", "disconnected");
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } this.logStream = null; }
  }

  private resolveModelId(model?: string): AntigravityModelId {
    if (!model) return AntigravityModels.GEMINI_FLASH;
    const lower = model.toLowerCase();
    if (lower.includes("pro-low")) return AntigravityModels.GEMINI_PRO_LOW;
    if (lower.includes("pro")) return AntigravityModels.GEMINI_PRO_HIGH;
    return AntigravityModels.GEMINI_FLASH;
  }

  private ensureAntigravityTrust(dir: string): void {
    const settingsPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
    if (!fs.existsSync(settingsPath)) return;
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { return; }
    const trusted = (settings.trustedWorkspaces as string[] | undefined) ?? [];
    const normalized = dir.replace(/\//g, "\\");
    if (trusted.some(t => t.replace(/\//g, "\\") === normalized)) return;
    trusted.push(normalized);
    settings.trustedWorkspaces = trusted;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  private discoverLsPort(): number | null {
    if (!this.agyPid) return null;
    for (let i = 0; i < 15; i++) {
      try {
        const out = execSync(
          `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${this.agyPid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress"`,
          { encoding: "utf-8" },
        ).trim();
        if (out) {
          const parsed = JSON.parse(out) as { LocalPort: number } | { LocalPort: number }[];
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          const ports = arr.map(r => r.LocalPort).sort((a, b) => a - b);
          if (ports.length >= 1) {
            // PoC 확정: 두 포트 중 작은 게 HTTPS 메인 (gRPC), 큰 게 extension_server HTTP.
            this.writeLog(`ls ports discovered: ${ports.join(",")} (using https=${ports[0]})`);
            return ports[0];
          }
        }
      } catch { /* */ }
      execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds 700"`, { stdio: "pipe" });
    }
    return null;
  }

  private async rpc<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.lsPort) throw new Error("LS port not discovered");
    const https = await import("https");
    const body = JSON.stringify(payload);
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: this.lsPort!,
          path: `/exa.language_server_pb.LanguageServerService/${method}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          rejectUnauthorized: false,
          timeout: 30000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            this.writeLog(`rpc ${method} → ${res.statusCode} (${text.length}b)`);
            if (res.statusCode === 200) {
              try { resolve(JSON.parse(text) as T); }
              catch { reject(new Error(`${method}: invalid JSON response`)); }
            } else {
              reject(new Error(`${method}: HTTP ${res.statusCode} -- ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.write(body);
      req.end();
    });
  }

  private openLogStream(cwd: string): void {
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, "antigravity-stream.log");
    try {
      const stream = fs.createWriteStream(logPath, { flags: "a" });
      stream.on("error", () => {
        this.logStream = null;
        try { stream.destroy(); } catch { /* */ }
      });
      this.logStream = stream;
      this.writeLog(`--- spawn ${new Date().toISOString()} ---`);
    } catch {
      this.logStream = null;
    }
  }

  private writeLog(s: string): void {
    if (this.logStream) this.logStream.write(s.endsWith("\n") ? s : s + "\n");
  }
}
