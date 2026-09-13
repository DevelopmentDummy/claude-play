import { spawn, execFile, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { recordAgyPid, forgetAgyPid } from "./antigravity-pid-registry";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

// agy 1.2.x headless 상주 모드 — `claude -p` stream-json과 같은 구조.
// stdin: 한 줄 NDJSON = 한 턴 (`{"event":"user","message":{"content":[{type:"text",text}]}}`).
// stdout: `init`(conversation_id) → `step_update`(agent_response text_delta / tool / …) → `result`.
// 이전의 PowerShell Start-Process + in-process LS RPC 폴링 방식은 agy 1.2.2에서 LS가
// CSRF 토큰(`x-codeium-csrf-token`, 프로세스 내부 생성·외부 비노출)을 요구하면서 전 RPC가
// 401로 막혀 폐기했다. 파이프 모드는 TTY도 CSRF도 필요 없다.
// `--print-timeout`은 헤드리스 대기(백그라운드 task 포함) 상한이라 상주 프로세스에는 크게 준다.
const PRINT_TIMEOUT = "720h";

/** displayName("Gemini 3.8 Flash (High)")에서 세대 번호(3.8)를 뽑는다. 미검출 시 0. */
function generationOf(displayName: string): number {
  const m = /Gemini\s+(\d+(?:\.\d+)?)/i.exec(displayName);
  return m ? Number(m[1]) : 0;
}

interface AgyModel { slug: string; displayName: string }

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let modelCache: { at: number; models: AgyModel[] } | null = null;

/** `agy models` 출력(`slug\tDisplay Name`)을 파싱한다. 모델 목록은 버전·계정마다 달라서
 *  하드코딩하지 않고 spawn마다(10분 캐시) 조회한다. 실패 시 빈 배열. */
function listAgyModels(): Promise<AgyModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
    return Promise.resolve(modelCache.models);
  }
  return new Promise((resolve) => {
    const child = execFile(AGY_PATH, ["models"], { timeout: 30_000, windowsHide: true, encoding: "utf-8" }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const models = stdout
        .split(/\r?\n/)
        .map(line => line.split("\t"))
        .filter(parts => parts.length >= 2 && parts[0].trim() && parts[1].trim())
        .map(([slug, displayName]) => ({ slug: slug.trim(), displayName: displayName.trim() }));
      if (models.length > 0) modelCache = { at: Date.now(), models };
      resolve(models);
    });
    child.stdin?.end();
  });
}

export interface AntigravityProcessEvents {
  message: [data: unknown];
  error: [err: string];
  exit: [code: number | null];
  status: [status: "connected" | "streaming" | "disconnected"];
  sessionId: [id: string];
}

type TurnKind = "primer" | "user";

export class AntigravityProcess extends EventEmitter<AntigravityProcessEvents> {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private logStream: fs.WriteStream | null = null;
  private logName = "antigravity-stream.log";
  private spawnCwd = "";
  private spawnModelString: string | undefined;
  private conversationId: string | null = null;
  /** 모델 slug 해소(`agy models`) 중 — proc은 아직 없지만 send는 버퍼링해 받는다. */
  private starting = false;
  /** spawn/kill마다 증가. 비동기 launch가 그 사이 kill/재spawn됐으면 버린다. */
  private generation = 0;
  /** primer 턴이 끝났거나(신규) primer가 필요 없을 때(resume/primer 없음) true. */
  private ready = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];
  /** stdin에 넣은 턴들의 순서. agy는 턴 진행 중 들어온 메시지를 큐잉해 다음 턴으로 실행하므로
   *  `result` 1개가 큐 head 1개에 대응한다. */
  private turnQueue: TurnKind[] = [];
  /** proc 기동 전에 들어온 stdin 라인 (primer / 조기 send). */
  private pendingLines: string[] = [];
  /** 큐가 빈 상태에서 step_update가 오면 async 도구 완료 wake-up으로 모델이 스스로 연 턴. */
  private spontaneousTurn = false;
  /** step_index별 agent_response 누적 원문과 이미 emit한 (echo strip 후) 길이. */
  private stepText = new Map<number, { raw: string; emitted: number }>();

  constructor() {
    super();
    // Default no-op "error" listener. EventEmitter는 'error' event에 listener 없으면
    // throw하여 process를 죽인다. session-instance가 bindProcessEvents에서 broadcast
    // listener를 부착하지만 destroy()에서 removeAllListeners()로 제거 — destroy 후
    // 늦은 비동기 에러가 emit되는 race가 dev server를 crash시킴.
    this.on("error", () => { /* swallowed — antigravity-stream.log 참조 */ });
  }

  spawn(
    cwd: string,
    resumeId?: string,
    model?: string,
    appendSystemPrompt?: string,
    _effort?: string,
    _skipPermissions?: boolean,
    logName?: string,
  ): void {
    if (this.proc || this.starting) this.kill();

    this.spawnCwd = cwd;
    this.spawnModelString = model;
    this.conversationId = resumeId || null;
    this.ready = false;
    this.turnQueue = [];
    this.pendingLines = [];
    this.spontaneousTurn = false;
    this.stepText.clear();
    this.buffer = "";

    this.cleanupLegacyGlobalSettings();
    this.ensureAntigravitySettings(cwd);
    if (logName) this.logName = logName;
    this.openLogStream(cwd);

    if (!fs.existsSync(AGY_PATH)) {
      this.writeLog(`agy not found at ${AGY_PATH}`);
      this.emit("error", `Antigravity CLI not found: ${AGY_PATH}`);
      this.emit("status", "disconnected");
      return;
    }

    // 신규 대화: 지시문을 첫 턴(primer)으로 넣고 그 응답은 사용자에게 노출하지 않는다.
    // resume: primer가 이미 대화 히스토리에 있으므로 다시 넣지 않는다.
    // stdin 전달이라 커맨드라인 32767자 한계에 따른 primer 절단이 더 이상 없다.
    const primer = !resumeId && appendSystemPrompt && appendSystemPrompt.trim() ? appendSystemPrompt : null;
    if (primer) {
      this.turnQueue.push("primer");
      this.writeUserLine(primer);
      this.writeLog(`primer queued (${primer.length} chars)`);
    }

    const gen = ++this.generation;
    this.starting = true;
    void (async () => {
      const slug = await this.resolveModelSlug(model);
      if (gen !== this.generation) return;
      this.launch(cwd, resumeId, slug);
      if (!primer) this.markReady();
    })();
  }

  private launch(cwd: string, resumeId: string | undefined, slug: string | null): void {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", PRINT_TIMEOUT,
    ];
    if (slug) args.push("--model", slug);
    if (resumeId) args.push("--conversation", resumeId);
    // stream-json 입력 모드는 명령줄 프롬프트를 거부하지만 `-p`는 인자를 요구한다 → 빈 문자열.
    args.push("-p", "");

    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
        delete (env as Record<string, string | undefined>)[key];
      }
    }

    this.writeLog(`[start] agy ${args.map(a => (a === "" ? '""' : a)).join(" ")} cwd=${cwd}`);
    const proc = spawn(AGY_PATH, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    this.starting = false;
    if (proc.pid) recordAgyPid(proc.pid, cwd, this.conversationId);

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    proc.stdout?.on("data", (chunk: Buffer) => this.handleStdout(stdoutDecoder.write(chunk)));
    proc.stdout?.on("end", () => {
      this.handleStdout(stdoutDecoder.end());
      if (this.buffer.trim()) { const line = this.buffer; this.buffer = ""; this.parseLine(line); }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text) this.writeLog(`[stderr] ${text.trimEnd()}`);
    });
    proc.stdin?.on("error", (err) => this.writeLog(`[stdin error] ${err.message}`));

    proc.on("error", (err) => {
      this.writeLog(`[spawn error] ${err.message}`);
      this.emit("error", `Failed to start agy: ${err.message}`);
      this.emit("status", "disconnected");
    });

    proc.on("close", (code) => {
      if (this.proc !== proc) return; // kill() 후 재spawn된 이전 proc
      this.writeLog(`[exit] code=${code}`);
      forgetAgyPid(proc.pid ?? null);
      this.proc = null;
      this.ready = false;
      this.turnQueue = [];
      this.resolveReadyWaiters(false);
      this.emit("exit", code);
      this.emit("status", "disconnected");
    });

    for (const line of this.pendingLines.splice(0)) this.writeRaw(line);
    this.emit("status", this.turnQueue.length > 0 && this.turnQueue[0] !== "primer" ? "streaming" : "connected");
  }

  send(text: string): void {
    if (!this.proc && !this.starting) {
      this.emit("error", "AntigravityProcess not running — spawn() first");
      return;
    }
    this.turnQueue.push("user");
    this.spontaneousTurn = false;
    this.emit("status", "streaming");
    this.writeUserLine(text);
  }

  /** 턴 중 개입 — agy는 턴 진행 중 stdin으로 들어온 메시지를 큐잉해 현재 턴 직후 다음 턴으로
   *  실행한다(2026-09-14 라이브 확인). handleResult가 큐에 user 턴이 남아 있으면 `result`를
   *  내보내지 않으므로, 소비자에게는 개입 메시지까지 한 턴으로 보인다. */
  steer(text: string): void {
    this.send(text);
  }

  sendToolResult(_toolUseId: string, _content: string): void {
    this.writeLog("sendToolResult not implemented — AskUserQuestion is Claude-only for now");
  }

  respawn(): void {
    if (!this.spawnCwd) return;
    this.spawn(this.spawnCwd, this.conversationId || undefined, this.spawnModelString);
  }

  isRunning(): boolean {
    return this.starting || this.proc !== null;
  }

  get running(): boolean {
    return this.isRunning();
  }

  /** primer 턴 완료(또는 primer 없는 기동 완료)까지 대기. primer 응답은 20초를 넘길 수 있으나
   *  send()는 기동 전·primer 진행 중에도 stdin에 큐잉되므로 false여도 전송은 안전하다. */
  async waitForReady(timeoutMs = 60_000): Promise<boolean> {
    if (this.ready && this.proc) return true;
    if (!this.isRunning()) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.readyWaiters.push(finish);
    });
  }

  kill(): void {
    this.generation++;
    this.starting = false;
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.turnQueue = [];
    this.pendingLines = [];
    this.spontaneousTurn = false;
    this.resolveReadyWaiters(false);
    if (proc) {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      if (proc.pid) {
        try { execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: "pipe" }); } catch { /* already exited */ }
        forgetAgyPid(proc.pid);
      }
      this.writeLog(`killed pid=${proc.pid}`);
      this.emit("status", "disconnected");
    }
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } this.logStream = null; }
  }

  // --- stdin ---

  private writeUserLine(text: string): void {
    const line = JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } });
    if (this.proc) this.writeRaw(line);
    else this.pendingLines.push(line);
  }

  private writeRaw(line: string): void {
    if (!this.proc?.stdin?.writable) {
      this.writeLog(`[send dropped — stdin not writable] ${line.slice(0, 200)}`);
      return;
    }
    this.writeLog(`[send] ${line.length > 500 ? `${line.slice(0, 500)}… (${line.length} chars)` : line}`);
    this.proc.stdin.write(line + "\n");
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.resolveReadyWaiters(true);
    if (this.turnQueue.length === 0) this.emit("status", "connected");
  }

  private resolveReadyWaiters(ok: boolean): void {
    for (const w of this.readyWaiters.splice(0)) w(ok);
  }

  // --- stdout ---

  private handleStdout(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) this.parseLine(line);
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.writeLog(`[recv] ${trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed}`);
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { return; }

    switch (msg.event) {
      case "init": this.handleInit(msg.init as Record<string, unknown> | undefined, msg.conversation_id); break;
      case "step_update": this.handleStepUpdate((msg.step_update || {}) as Record<string, unknown>); break;
      case "result": this.handleResult((msg.result || {}) as Record<string, unknown>); break;
      default: break;
    }
  }

  private handleInit(_init: Record<string, unknown> | undefined, conversationId: unknown): void {
    if (typeof conversationId !== "string" || !conversationId) return;
    this.conversationId = conversationId;
    if (this.proc?.pid) recordAgyPid(this.proc.pid, this.spawnCwd, conversationId);
    this.emit("sessionId", conversationId);
  }

  private handleStepUpdate(su: Record<string, unknown>): void {
    // 서브에이전트 등 다른 대화의 step은 무시한다.
    if (typeof su.conversation_id === "string" && this.conversationId && su.conversation_id !== this.conversationId) return;

    const current = this.turnQueue[0];
    if (current === "primer") return;
    if (current === undefined && !this.spontaneousTurn) {
      // 턴이 끝난 뒤 async 도구 완료로 모델이 스스로 깨어난 턴 — 라이브로 노출한다.
      this.spontaneousTurn = true;
      this.writeLog("spontaneous turn started (async wake-up)");
      this.emit("status", "streaming");
    }

    if (su.step_type !== "agent_response" || typeof su.text_delta !== "string" || !su.text_delta) return;
    const index = typeof su.step_index === "number" ? su.step_index : -1;
    const entry = this.stepText.get(index) ?? { raw: "", emitted: 0 };
    entry.raw += su.text_delta;
    const visible = this.stripSystemMessageEcho(entry.raw);
    if (visible.length > entry.emitted) {
      const delta = visible.slice(entry.emitted);
      entry.emitted = visible.length;
      this.emit("message", { type: "assistant", subtype: "text_delta", message: { role: "assistant", content: delta } });
    }
    this.stepText.set(index, entry);
  }

  private handleResult(result: Record<string, unknown>): void {
    this.stepText.clear();
    const kind = this.turnQueue.shift();
    const failed = result.status === "ERROR";
    const errText = typeof result.error === "string" ? result.error : "";

    if (kind === "primer") {
      this.writeLog(`primer turn done status=${result.status}${errText ? ` error=${errText}` : ""}`);
      this.markReady();
      return;
    }

    if (failed && errText) {
      // 모델/cascade 에러를 침묵 대신 본문으로 노출 (디버깅·모델 전환 판단용).
      this.emit("message", {
        type: "assistant",
        subtype: "text_delta",
        message: { role: "assistant", content: `\n\n[Antigravity 모델 에러]\n${errText}\n` },
      });
    }

    if (kind === undefined) {
      this.spontaneousTurn = false;
      this.emit("message", { type: "result", spontaneous: true });
      this.emit("status", "connected");
      return;
    }

    // 개입(steer)으로 큐잉된 user 턴이 남아 있으면 논리적으로 같은 턴이다 — 마지막에 한 번만 result.
    if (this.turnQueue.length > 0) return;
    this.emit("message", { type: "result" });
    this.emit("status", "connected");
  }

  /** Flash 등이 SYSTEM_MESSAGE 본문(`An event has occurred. See the following message: ...`)을
   *  자기 응답 본문에 그대로 echo한 경우, 그 prefix를 strip해서 사용자에게는 안 보이게 한다.
   *  뒤에 붙은 실제 narrative(`<dialog_response>...`)는 그대로 살린다. */
  private stripSystemMessageEcho(content: string): string {
    if (!content) return content;
    // Pattern: agy의 task 완료 SYSTEM_MESSAGE 본문이 응답 안에 그대로 등장하는 형태.
    // "An event has occurred." 문장으로 시작해서 task log 경로까지 이어지는 블록 전체 제거.
    // 뒤에 <dialog_response> 또는 <choice>가 오기 전까지의 연속된 메타 본문을 strip.
    const ECHO_PATTERN = /An event has occurred\. See the following message:[\s\S]*?(?=<dialog_response>|<choice>|$)/g;
    // SYSTEM_MESSAGE 태그 블록도 같은 패턴으로 emit 가능.
    const TAG_PATTERN = /<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g;
    // Sub-agent 메타 인사말 (real narrative 뒤에 trailing으로 붙는 경우)
    const TRAILING_META = /\s*(Oceania,?\s*)?I am (now\s+)?ready to present[\s\S]*?(Let'?s submit it\.?)?\s*$/i;
    // 비동기 comfyui_generate 완료 system event를 모델이 본문에 echo한 메타 텍스트.
    // 사용자 입력 turn 중간에 task 완료 event가 도착해 같은 응답에 prefix/suffix로 박힌 경우
    // — 그리고 모델이 paraphrase로 출력한 경우 — 까지 잡는 안전망.
    // 두 종결구가 보통 함께 등장(`...로드될 것입니다. 사용자의 다음 선택 또는 입력을
    // 기다립니다.`)하지만 짧은 형태(`로드될 것입니다.` 단독)로도 끝난다. lazy match가
    // alternation의 첫 hit에서 멈추기 때문에 긴 형태를 먼저 strip해야 trailing이 남지
    // 않는다. 영문 패턴도 동일(`task completes` vs `narrative scene`).
    const IMAGE_COMPLETION_KO_LONG = /\[이미지 생성 완료\][\s\S]*?입력을 기다립니다\.?\s*/g;
    const IMAGE_COMPLETION_KO_SHORT = /\[이미지 생성 완료\][\s\S]*?로드될 것입니다\.?\s*/g;
    const IMAGE_QUEUED_EN_LONG = /An image has been queued for generation in the background\.[\s\S]*?narrative scene\.?\s*/g;
    const IMAGE_QUEUED_EN_SHORT = /An image has been queued for generation in the background\.[\s\S]*?task completes\.?\s*/g;
    return content
      .replace(ECHO_PATTERN, "")
      .replace(TAG_PATTERN, "")
      .replace(IMAGE_COMPLETION_KO_LONG, "")
      .replace(IMAGE_COMPLETION_KO_SHORT, "")
      .replace(IMAGE_QUEUED_EN_LONG, "")
      .replace(IMAGE_QUEUED_EN_SHORT, "")
      .replace(TRAILING_META, "")
      .trim();
  }

  // --- model ---

  /** 모델 선택 문자열(antigravity-flash[-medium|-low]/-pro[-low])을 agy displayName 패턴으로 매핑.
   *  버전이 올라도 안 깨지게 세대 숫자("3.5") 대신 등급("Flash (High)"/"Pro (High)")으로 매칭. */
  private modelPattern(model?: string): string {
    if (!model) return "Flash (High)";
    const lower = model.toLowerCase();
    if (lower.includes("pro-low")) return "Pro (Low)";
    if (lower.includes("pro")) return "Pro (High)";
    if (lower.includes("flash-low")) return "Flash (Low)";
    if (lower.includes("flash-medium")) return "Flash (Medium)";
    return "Flash (High)";
  }

  /** `agy models`에서 등급이 일치하는 항목 중 최신 세대의 slug(`gemini-3.8-flash-high`)를 고른다.
   *  agy는 같은 등급의 구세대를 목록에 계속 남긴다(2026-09-14 실측: Flash 3.6~3.8 공존).
   *  실패 시 null → `--model` 생략(agy 기본 모델). */
  private async resolveModelSlug(model?: string): Promise<string | null> {
    const pattern = this.modelPattern(model);
    const models = await listAgyModels();
    const match = models
      .filter(m => m.displayName.includes(pattern))
      .reduce<AgyModel | null>((best, m) => (best === null || generationOf(m.displayName) > generationOf(best.displayName) ? m : best), null);
    if (match) {
      this.writeLog(`model resolved: "${pattern}" → ${match.slug} (${match.displayName})`);
      return match.slug;
    }
    this.writeLog(`model "${pattern}" not found among ${models.length} models — agy default`);
    return null;
  }

  // --- settings ---

  private ensureAntigravitySettings(dir: string): void {
    // 글로벌 `~/.gemini/antigravity-cli/settings.json` ensure:
    //  1) trustedWorkspaces — spawn cwd가 신뢰 목록에 있어야 untrusted workspace 경고 없이 시작
    //  2) memory subsystem off — cascade마다 implicit/*.pb 누적 + UpdateCascadeMemory 자율
    //     호출로 cross-session 기억 간섭 발생. agy proto의 `MemoryConfig`+`MemoryToolConfig`+
    //     UserSettings 3개 카테고리를 다 disable해서 새 cascade가 옛 RP 흔적을 안 끌어옴.
    // 격리/permissions deny 시도(2026-06-03)는 cascade 호환성 깨서 revert됨 —
    // `cleanupLegacyGlobalSettings`가 그 잔재를 청소함.
    const settingsPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
    if (!fs.existsSync(settingsPath)) return;
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { return; }

    let dirty = false;

    // 1) trustedWorkspaces
    const trusted = (settings.trustedWorkspaces as string[] | undefined) ?? [];
    const normalized = dir.replace(/\//g, "\\");
    if (!trusted.some(t => t.replace(/\//g, "\\") === normalized)) {
      trusted.push(normalized);
      settings.trustedWorkspaces = trusted;
      dirty = true;
    }

    // 2) memory disable — 3-layer
    const ensureField = <T>(obj: Record<string, unknown>, key: string, value: T): boolean => {
      if (obj[key] === value) return false;
      obj[key] = value;
      return true;
    };
    const memoryConfig = (settings.memoryConfig as Record<string, unknown> | undefined) ?? {};
    if (ensureField(memoryConfig, "enabled", false)) dirty = true;
    if (ensureField(memoryConfig, "addUserMemoriesToSystemPrompt", false)) dirty = true;
    if (ensureField(memoryConfig, "maxGlobalCascadeMemories", 0)) dirty = true;
    if (settings.memoryConfig !== memoryConfig) { settings.memoryConfig = memoryConfig; dirty = true; }

    const memoryToolConfig = (settings.memoryToolConfig as Record<string, unknown> | undefined) ?? {};
    if (ensureField(memoryToolConfig, "disableAutoGenerateMemories", true)) dirty = true;
    if (ensureField(memoryToolConfig, "forceDisable", true)) dirty = true;
    if (settings.memoryToolConfig !== memoryToolConfig) { settings.memoryToolConfig = memoryToolConfig; dirty = true; }

    if (ensureField(settings, "disableAutoGenerateMemories", true)) dirty = true;

    if (dirty) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        this.writeLog(`ensureSettings: patched (memory off + trust=${normalized})`);
      } catch (err) {
        this.writeLog(`ensureSettings: write failed: ${err}`);
      }
    }
  }

  /** Remove the permissions entries we previously wrote to the GLOBAL settings.json
   *  (back when this wrapper patched the user's `~/.gemini/antigravity-cli/settings.json`
   *  directly — superseded 2026-06-03 by the isolated profile approach). Idempotent.
   *  trustedWorkspaces entries we added are intentionally left alone. */
  private cleanupLegacyGlobalSettings(): void {
    const globalPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
    if (!fs.existsSync(globalPath)) return;
    let settings: Record<string, unknown>;
    try { settings = JSON.parse(fs.readFileSync(globalPath, "utf-8")); }
    catch { return; }
    const perms = settings.permissions as Record<string, unknown> | undefined;
    if (!perms) return;
    let dirty = false;
    const stripRule = (key: "deny" | "allow", rule: string) => {
      const list = perms[key];
      if (!Array.isArray(list)) return;
      const idx = list.indexOf(rule);
      if (idx >= 0) { list.splice(idx, 1); dirty = true; }
    };
    stripRule("deny", "command(*)");
    stripRule("allow", "mcp(*)");
    const allEmpty = (["deny", "allow", "ask"] as const).every(k => {
      const v = perms[k];
      return !Array.isArray(v) || v.length === 0;
    });
    if (allEmpty) { delete settings.permissions; dirty = true; }
    if (dirty) {
      try {
        fs.writeFileSync(globalPath, JSON.stringify(settings, null, 2), "utf-8");
        this.writeLog(`cleanupLegacyGlobalSettings: stripped bridge entries from ${globalPath}`);
      } catch { /* best-effort */ }
    }
  }

  // --- log ---

  private openLogStream(cwd: string): void {
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    const logPath = path.join(cwd, this.logName);
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
