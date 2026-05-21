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

export class AntigravityProcess extends EventEmitter<AntigravityProcessEvents> {
  private agyPid: number | null = null;
  private lsPort: number | null = null;
  private cascadeId: string | null = null;
  private spawnCwd = "";
  private modelId: AntigravityModelId = AntigravityModels.GEMINI_FLASH;
  private logStream: fs.WriteStream | null = null;
  private polling = false;
  private lastSeenMessageCount = 0;
  private lastSeenTailLength = 0;

  spawn(
    cwd: string,
    resumeId?: string,
    model?: string,
  ): void {
    if (this.agyPid) this.kill();

    this.spawnCwd = cwd;
    this.cascadeId = resumeId || null;
    this.modelId = this.resolveModelId(model);

    this.ensureAntigravityTrust(cwd);
    this.openLogStream(cwd);

    const argList = "'--prompt-interactive','spike-init','--dangerously-skip-permissions'";
    const cmd = `powershell -NoProfile -Command "$p = Start-Process -FilePath '${AGY_PATH}' -ArgumentList ${argList} -WorkingDirectory '${cwd.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru; $p.Id"`;
    const out = execSync(cmd, { encoding: "utf-8" }).trim();
    const pid = Number(out);
    if (!pid || Number.isNaN(pid)) {
      this.emit("error", `Failed to spawn agy: parse pid failed (out=${out})`);
      return;
    }
    this.agyPid = pid;
    this.writeLog(`spawn pid=${pid} cwd=${cwd} model=${this.modelId}`);
    this.emit("status", "connected");
  }

  send(text: string): void {
    void this._sendAsync(text).catch(err => {
      this.emit("error", String(err));
      this.emit("status", "connected");
    });
  }

  private async _sendAsync(text: string): Promise<void> {
    if (!this.lsPort) {
      const port = this.discoverLsPort();
      if (!port) {
        this.emit("error", "Failed to discover Antigravity LS port within 10s");
        return;
      }
      this.lsPort = port;
    }

    if (!this.cascadeId) {
      // source=1 (CORTEX_TRAJECTORY_SOURCE_USER) — agy 1.0.0은 0(UNSPECIFIED) 거부
      const startResp = await this.rpc<{ cascadeId?: string }>("StartCascade", { source: 1 });
      if (!startResp?.cascadeId) {
        this.emit("error", "StartCascade returned no cascadeId");
        return;
      }
      this.cascadeId = startResp.cascadeId;
      this.lastSeenMessageCount = 0;
      this.lastSeenTailLength = 0;
      this.emit("sessionId", this.cascadeId);
      this.writeLog(`cascade started: ${this.cascadeId}`);
    }

    this.emit("status", "streaming");

    // proto3 canonical JSON: oneof는 case/value 래퍼가 아니라 field name 직접 사용
    await this.rpc("SendUserCascadeMessage", {
      cascadeId: this.cascadeId,
      items: [{ chunk: { text: text } }],
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
    const POLL_INTERVAL_MS = 500;
    const MAX_TURN_DURATION_MS = 5 * 60 * 1000;
    const STABLE_AFTER_RESPONSE_TICKS = 6;
    const turnStart = Date.now();
    let stableTicks = 0;
    let sawResponse = false;

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
      this.writeLog(`[poll] step-count=${dbgSteps?.length ?? "null"} types=${dbgSteps?.map(s => s.type).join("|") ?? "n/a"}`);
      if (dbgSteps) {
        for (let di = 0; di < dbgSteps.length; di++) {
          const s = dbgSteps[di];
          if ((s.type as string)?.includes("PLANNER")) {
            const pr = s.plannerResponse as Record<string, unknown> | undefined;
            const r = pr?.response;
            this.writeLog(`[poll-pr] step[${di}] plannerResponse-keys=${pr ? Object.keys(pr).join(",") : "null"} response-len=${typeof r === "string" ? r.length : "non-string"} role-resolved=${this.extractRole(s)}`);
          }
        }
      }

      const turnComplete = this.detectTurnComplete(conv);
      const advanced = this.emitNewChunks(conv);
      if (advanced) {
        sawResponse = sawResponse || this.hasAssistantResponse(conv);
        stableTicks = 0;
      } else if (sawResponse) {
        stableTicks++;
        if (turnComplete || stableTicks >= STABLE_AFTER_RESPONSE_TICKS) break;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    this.polling = false;
    this.emit("message", { type: "result" });
    this.emit("status", "connected");
  }

  private detectTurnComplete(conv: Record<string, unknown>): boolean {
    const steps = this.extractItems(conv);
    if (!steps) return false;
    // CHECKPOINT step (turn 끝) 또는 PLANNER_RESPONSE with stopReason
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      const t = s.type as string | undefined;
      if (t === "CORTEX_STEP_TYPE_CHECKPOINT") return true;
      if (t === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
        const pr = s.plannerResponse as Record<string, unknown> | undefined;
        if (pr?.stopReason) return true;
      }
    }
    return false;
  }

  private hasAssistantResponse(conv: Record<string, unknown>): boolean {
    const steps = this.extractItems(conv);
    if (!steps) return false;
    return steps.some(s => {
      const t = s.type as string | undefined;
      return t === "CORTEX_STEP_TYPE_PLANNER_RESPONSE";
    });
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
    // agy 1.0.0 step content 위치 후보들
    const candidates: unknown[] = [
      (item.plannerResponse as Record<string, unknown> | undefined)?.response,
      (item.plannerResponse as Record<string, unknown> | undefined)?.modifiedResponse,
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

  kill(): void {
    if (!this.agyPid) return;
    try { execSync(`taskkill /T /F /PID ${this.agyPid}`, { stdio: "pipe" }); } catch { /* */ }
    this.writeLog(`killed pid=${this.agyPid}`);
    this.agyPid = null;
    this.lsPort = null;
    this.polling = false;
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
