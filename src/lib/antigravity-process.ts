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

  private openLogStream(cwd: string): void {
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, "antigravity-stream.log");
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.writeLog(`--- spawn ${new Date().toISOString()} ---`);
  }

  private writeLog(s: string): void {
    if (this.logStream) this.logStream.write(s.endsWith("\n") ? s : s + "\n");
  }
}
