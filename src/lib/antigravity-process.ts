import { execSync } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { recordAgyPid, forgetAgyPid } from "./antigravity-pid-registry";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");


// 모델 ID는 agy 버전마다 바뀌는 동적 인덱스(MODEL_PLACEHOLDER_M{N})다.
// 하드코딩 금지 — initialize()에서 GetAvailableModels로 displayName을 매칭해 조회한다.
// (1.0.2: Pro High=165 → 1.0.5: 37로 바뀌어 "unknown model key M165: model not found"로
//  cascade가 죽은 이력. 그래서 숫자를 박지 않고 매 spawn마다 LS에서 현재 인덱스를 받는다.)

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
  /** agy가 cascade에 넣을 모델 키 — GetAvailableModels의 `model` 필드 전체 문자열
   *  (예: "MODEL_PLACEHOLDER_M37"). agy는 이 값을 그대로 lookup 키로 쓰므로 숫자만
   *  뽑아 보내면 "unknown model key 37"로 실패한다. 미해소 시 null → requestedModel 생략. */
  private modelKey: string | null = null;
  private logStream: fs.WriteStream | null = null;
  private logName = "antigravity-stream.log";
  private polling = false;
  private lastSeenMessageCount = 0;
  private lastSeenTailLength = 0;
  private initPromise: Promise<void> | null = null;

  constructor() {
    super();
    // Default no-op "error" listener. EventEmitter는 'error' event에 listener 없으면
    // throw하여 process를 죽인다. session-instance가 bindProcessEvents에서 broadcast
    // listener를 부착하지만 destroy()에서 removeAllListeners()로 제거 — destroy 후
    // initialize().catch가 emit("error") 호출하는 race가 있어 dev server를 crash시킴.
    // 항상 1개 default listener 보장 (실제 처리는 antigravity-stream.log에서 추적).
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
    if (this.agyPid) this.kill();

    this.spawnCwd = cwd;
    this.cascadeId = resumeId || null;
    this.spawnModelString = model;
    // modelKey는 initialize()에서 LS 연결 후 GetAvailableModels로 동적 해소한다.
    this.lastSeenMessageCount = 0;
    this.lastSeenTailLength = 0;

    this.cleanupLegacyGlobalSettings();
    this.ensureAntigravitySettings(cwd);
    if (logName) this.logName = logName;
    this.openLogStream(cwd);

    // agy.exe는 bubbletea TUI 라이브러리 기반 — CONIN$/CONOUT$ console handle 필수.
    // Node child_process.spawn은 detached/windowsHide 어떤 조합으로도 Windows console
    // 할당이 안 되어 agy가 즉시 "bubbletea: could not open TTY: open CONIN$" 에러로
    // exit code 0. PowerShell Start-Process -WindowStyle Hidden은 hidden console이지만
    // CONIN$/CONOUT$이 실제로 allocated되어 정상 동작. 다른 provider(Claude/Codex 등)는
    // stdin/stdout pipe로만 통신하는 CLI라 console 불필요했지만 agy만 다름.
    //
    // 한글 cwd 처리:
    //   - ps1 파일에 UTF-8 BOM prepend (`﻿`) → PS 5.1이 시스템 ANSI(CP949) 대신
    //     UTF-8로 정확히 디코드
    //   - -WorkingDirectory 대신 Set-Location -LiteralPath 사용 → wildcard 해석 우회
    const escapePS = (s: string) => s.replace(/'/g, "''");
    const tempDir = path.join(os.tmpdir(), "agy-bridge");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    let tempPrimerPath: string | null = null;
    let psScript: string;

    if (resumeId) {
      psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `Set-Location -LiteralPath '${escapePS(cwd)}'`,
        `$p = Start-Process -FilePath '${escapePS(AGY_PATH)}' -ArgumentList @('--conversation', '${escapePS(resumeId)}', '--dangerously-skip-permissions') -WindowStyle Hidden -PassThru`,
        `Write-Output $p.Id`,
      ].join("\n");
      this.writeLog(`spawn(resume): cascadeId=${resumeId}`);
    } else {
      // primer는 큰 텍스트(수만자)라 임시 파일로 저장 후 PowerShell에서 읽어 escape.
      // CommandLineToArgvW spec: 2n backslashes before " → n backslashes + delimiter;
      // 2n+1 → n backslashes + literal ". 따라서 " 앞의 backslash run을 doubling.
      let primer = appendSystemPrompt && appendSystemPrompt.length > 0 ? appendSystemPrompt : "_BRIDGE_INIT_";
      if (primer.length > MAX_PRIMER_CHARS) {
        this.writeLog(`WARN: primer truncated ${primer.length} → ${MAX_PRIMER_CHARS}`);
        primer = primer.slice(0, MAX_PRIMER_CHARS);
      }
      tempPrimerPath = path.join(tempDir, `primer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(tempPrimerPath, primer, "utf-8");
      psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `Set-Location -LiteralPath '${escapePS(cwd)}'`,
        `$primer = [System.IO.File]::ReadAllText('${escapePS(tempPrimerPath)}', [System.Text.Encoding]::UTF8)`,
        `$primerEscaped = $primer -replace '(\\\\*)"', '$1$1\\"'`,
        `$primerArg = '"' + $primerEscaped + '"'`,
        `$argsString = '--prompt-interactive ' + $primerArg + ' --dangerously-skip-permissions'`,
        `$p = Start-Process -FilePath '${escapePS(AGY_PATH)}' -ArgumentList $argsString -WindowStyle Hidden -PassThru`,
        `Write-Output $p.Id`,
      ].join("\n");
      this.writeLog(`spawn(new): primer=${primer.length}b cwd=${cwd}`);
    }

    const tempScriptPath = path.join(tempDir, `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    // UTF-8 BOM prepend — Windows PowerShell 5.1은 BOM 없으면 시스템 ANSI(CP949)로
    // 해석하여 한글 cwd가 mojibake되고 Start-Process가 wildcard 해석 fail함.
    fs.writeFileSync(tempScriptPath, "﻿" + psScript, "utf-8");

    try {
      let out: string;
      try {
        out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScriptPath}"`, {
          encoding: "utf-8",
        }).trim();
      } catch (err) {
        const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
        const stderr = (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf-8")) ?? "";
        const stdout = (typeof e.stdout === "string" ? e.stdout : e.stdout?.toString("utf-8")) ?? "";
        this.writeLog(`spawn powershell failed: stdout="${stdout.slice(0, 300)}" stderr="${stderr.slice(0, 300)}"`);
        this.emit("error", `Failed to spawn agy: powershell exit. stderr=${stderr.slice(0, 200)}`);
        return;
      }
      const pid = Number(out);
      if (!pid || Number.isNaN(pid)) {
        this.emit("error", `Failed to spawn agy: parse pid failed (out="${out}")`);
        return;
      }
      this.agyPid = pid;
      // Persist the PID keyed by cwd so the detached process can be reaped even
      // after this in-memory owner is lost (dev-server restart orphans it and
      // its cwd handle blocks session-dir deletion with EBUSY).
      recordAgyPid(pid, cwd, this.cascadeId);
      this.writeLog(`spawn pid=${pid} model=${this.spawnModelString ?? "default"}`);
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
    const port = await this.discoverLsPort();
    if (!port) throw new Error("LS port discovery timeout");
    this.lsPort = port;

    // 모델 ID 동적 해소 (agy 버전마다 인덱스가 바뀌므로 하드코딩 불가).
    this.modelKey = await this.resolveModelKeyDynamic(this.spawnModelString);

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
    // Primary: agy의 명시적 `WaitForConversationFullyIdle`. Fallback: 휴리스틱.
    // pollLoop와 같은 race 모델 (parent 메서드 주석 참조).
    const startedAt = Date.now();
    let fullyIdleSettled = false;
    let fullyIdleResolved = false;
    this.rpc<unknown>(
      "WaitForConversationFullyIdle",
      { conversationId: cascadeId },
      timeoutMs,
    ).then(() => {
      fullyIdleSettled = true;
      fullyIdleResolved = true;
      this.writeLog(`waitForIdle(primer): FullyIdle resolved after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }).catch((err) => {
      fullyIdleSettled = true;
      this.writeLog(`waitForIdle(primer): FullyIdle failed (heuristic fallback): ${err}`);
    });

    const deadline = startedAt + timeoutMs;
    let consecutiveIdle = 0;
    let everSawRunning = false;
    while (Date.now() < deadline) {
      if (fullyIdleResolved) return;
      try {
        const all = await this.rpc<{ trajectorySummaries?: Record<string, { status?: string }> }>("GetAllCascadeTrajectories", {});
        const status = all?.trajectorySummaries?.[cascadeId]?.status;
        if (status === "CASCADE_RUN_STATUS_RUNNING") {
          everSawRunning = true;
          consecutiveIdle = 0;
        } else if (status) {
          consecutiveIdle++;
          if (fullyIdleSettled && everSawRunning && consecutiveIdle >= 3) {
            this.writeLog(`waitForIdle(primer): cascade IDLE (heuristic fallback) after ${((Date.now() - startedAt) / 1000).toFixed(1)}s status=${status}`);
            return;
          }
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    this.writeLog(`waitForIdle(primer): timeout after ${timeoutMs / 1000}s, proceeding anyway`);
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

    // Wake-up turn skip: 이전 turn 종료 후 idle 중에 agy 내부가 async 도구 task 완료
    // (예: comfyui_generate async 이미지 생성 완료) event를 cascade에 자동 inject하면,
    // 빈 USER_INPUT step으로 모델이 깨어나 자동 PLANNER_RESPONSE를 만든다(`[이미지 생성
    // 완료] ...` 같은 메타 acknowledge). 그 step들은 사용자가 의도한 turn이 아니므로
    // 노출하지 않는다. send 직전 trajectory snapshot → 그 사이 추가된 step 개수만큼
    // baseline을 끌어올려 emitNewChunks가 skip하도록 한다.
    try {
      const traj = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: this.cascadeId });
      const steps = this.extractItems(traj) || [];
      if (steps.length > this.lastSeenMessageCount) {
        this.writeLog(`pre-send: dropping ${steps.length - this.lastSeenMessageCount} wake-up step(s) from baseline (was ${this.lastSeenMessageCount}, now ${steps.length})`);
        this.lastSeenMessageCount = steps.length;
        this.lastSeenTailLength = 0;
      }
    } catch (err) {
      this.writeLog(`pre-send snapshot failed: ${err}`);
    }

    // No prepend — primer is already the first USER_INPUT step of the cascade
    // via --prompt-interactive at spawn time. User messages are sent as-is.
    // Chunk.text는 nested Text message — `{ content: string }`로 wrap해야 한다.
    // 이전엔 raw string으로 보냈는데 agy가 schema mismatch로 deserialize 실패 →
    // 모델 context에 user text가 안 들어가서 모델이 user 의도 모른 채 자율 진행 →
    // RP 페르소나는 자연스러워 보이지만 일반 페르소나는 환각 응답. binary strings의
    // `Chunk_Text` 패턴(protoc-gen-go nested type naming)이 단서. agy CLI native input과
    // 비교 검증 완료 (2026-05-27).
    const plannerConfig: Record<string, unknown> = {
      plannerTypeConfig: { conversational: {} },
    };
    // modelKey가 해소됐을 때만 명시 — 실패(null) 시 생략하면 agy default 모델로 동작.
    // model은 GetAvailableModels의 키 문자열 전체("MODEL_PLACEHOLDER_M37")를 그대로 전달.
    if (this.modelKey != null) {
      plannerConfig.requestedModel = { model: this.modelKey };
    }
    // SendUserCascadeMessageRequest.items 는 TextOrScopeItem[] (agy proto codeium_common_pb).
    // user text는 TextOrScopeItem.text(string) oneof 필드에 담는다. 이전엔
    // items[].chunk.text.content 로 보냈는데 chunk 는 TextOrScopeItem 의 다른 oneof 멤버라
    // agy 가 무시 → items 가 비어 USER_REQUEST 빈 채로 turn 진행 → 모델이 입력을 못 받음.
    // (agy 1.0.5에서 확인. GetText/SetText/GetChunk/GetItem 메서드 + proto rawDesc로 검증.)
    await this.rpc("SendUserCascadeMessage", {
      cascadeId: this.cascadeId,
      items: [{ text }],
      cascadeConfig: { plannerConfig },
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
    const ERROR_EXIT_STABLE_TICKS = 3; // ERROR로 끝나면 더 빨리 종료
    const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // trajectory 변화 없이 5분 stuck이면 강제 종료
    const turnStart = Date.now();
    let iter = 0;
    let lastTrajKey = "";
    let consecutiveStable = 0;
    let consecutiveIdle = 0;
    let everSawRunning = false;
    let lastEndedOnError = false;

    // Primary turn-complete signal: agy의 명시적 `WaitForConversationFullyIdle` RPC.
    // 휴리스틱(idle+stable)은 background task pending 시점(예: comfyui_generate async
    // 호출 후 cascade가 잠깐 IDLE 갔다가 task 완료 후 PLANNER_RESPONSE 추가 출력하는
    // 패턴)에 turn complete로 오판해서 delayed RP 응답을 놓쳤음. FullyIdle은 agy 내부
    // 로직이 sub-agent/background까지 다 끝났는지 판단해 응답 → 휴리스틱보다 정확.
    // FullyIdle이 fail하거나 schema 안 맞으면 휴리스틱이 fallback (둘 다 turn 종료 트리거).
    // ConversationKey는 binary proto schema. cascadeId 단일 string이 아니라 메시지 wrap.
    let fullyIdleSettled = false;
    let fullyIdleResolved = false;
    this.rpc<unknown>(
      "WaitForConversationFullyIdle",
      { conversationId: this.cascadeId },
      MAX_TURN_DURATION_MS,
    ).then(() => {
      fullyIdleSettled = true;
      fullyIdleResolved = true;
      this.writeLog(`WaitForConversationFullyIdle: resolved`);
    }).catch((err) => {
      fullyIdleSettled = true;
      this.writeLog(`WaitForConversationFullyIdle: failed (falling back to heuristic): ${err}`);
    });

    while (this.polling && this.cascadeId) {
      if (Date.now() - turnStart > MAX_TURN_DURATION_MS) {
        this.writeLog(`poll: turn timeout after ${MAX_TURN_DURATION_MS / 1000}s`);
        break;
      }

      // Explicit fully-idle 신호가 먼저 도착하면 즉시 종료 (휴리스틱 race 무시).
      if (fullyIdleResolved) {
        this.writeLog(`[poll #${iter}] turn complete via WaitForConversationFullyIdle`);
        try {
          const finalConv = await this.rpc<Record<string, unknown>>("GetCascadeTrajectory", { cascadeId: this.cascadeId });
          this.emitNewChunks(finalConv);
        } catch { /* */ }
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
      lastEndedOnError = lastStep?.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE";
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
            this.writeLog(`[poll #${iter}] status=${status} idle=${consecutiveIdle}/${IDLE_GRACE_TICKS} traj-stable=${consecutiveStable}/${TRAJECTORY_STABLE_TICKS} lastErr=${lastEndedOnError}`);
            // 정상 흐름: RUNNING 거친 적 있거나 명시적 종료 상태일 때 idle+stable 충족
            const normalExit =
              (everSawRunning || isFinishedStatus) &&
              consecutiveIdle >= IDLE_GRACE_TICKS &&
              consecutiveStable >= TRAJECTORY_STABLE_TICKS;
            // 에러 종료: cascade가 RUNNING 없이 ERROR_MESSAGE로 즉사한 케이스
            // (Pro Low가 도구 호출 invalid_args로 죽거나 모델이 초기 reject한 경우)
            // → 5분 STUCK_TIMEOUT 대기하지 않고 빠르게 종료
            const errorExit =
              lastEndedOnError &&
              consecutiveIdle >= IDLE_GRACE_TICKS &&
              consecutiveStable >= ERROR_EXIT_STABLE_TICKS;
            // 휴리스틱은 fully-idle RPC가 fail로 settle된 후에만 활성화. fully-idle이
            // 아직 pending이면(= 정상 동작 중) 휴리스틱 무시하고 polling 계속 — 그래야
            // background task로 잠깐 IDLE 갔다가 PLANNER_RESPONSE 추가하는 패턴을 안 놓침.
            if (fullyIdleSettled && (normalExit || errorExit)) {
              this.writeLog(`[poll #${iter}] cascade ${errorExit ? "error-exit" : "idle+stable"} (heuristic fallback) — turn complete`);
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
        if (role === "assistant") {
          const raw = this.extractText(it);
          const content = raw ? this.stripSystemMessageEcho(raw) : undefined;
          if (content) {
            this.emit("message", {
              type: "assistant",
              subtype: "text_delta",
              message: { role: "assistant", content },
            });
          }
        } else if (role === "error") {
          // Pro Low 등 모델이 도구 호출 invalid_args로 cascade를 죽인 경우,
          // 침묵 대신 에러 본문을 사용자에게 노출한다 (디버깅·모델 전환 판단용).
          const errText = this.extractText(it);
          if (errText) {
            this.emit("message", {
              type: "assistant",
              subtype: "text_delta",
              message: { role: "assistant", content: `\n\n[Antigravity 모델 에러]\n${errText}\n` },
            });
          }
        }
      }
      this.lastSeenMessageCount = items.length;
      const lastRaw = this.extractText(items[items.length - 1]) ?? "";
      this.lastSeenTailLength = this.stripSystemMessageEcho(lastRaw).length;
      return true;
    }

    if (items.length > 0 && items.length === this.lastSeenMessageCount) {
      const last = items[items.length - 1];
      if (this.extractRole(last) === "assistant") {
        const fullRaw = this.extractText(last) ?? "";
        const fullText = this.stripSystemMessageEcho(fullRaw);
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
    // wake-up turn 자체는 _sendAsync의 pre-send snapshot이 baseline으로 끌어올려서
    // 차단하지만(primary defense), 사용자 입력 turn 중간에 task 완료 event가 도착해
    // 같은 PLANNER_RESPONSE에 prefix/suffix로 박힌 경우 — 그리고 모델이 paraphrase로
    // 출력한 경우 — 까지 잡는 안전망.
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
      // PLANNER_RESPONSE는 final assistant text(response/modifiedResponse)만 사용자에게 emit한다.
      // Flash 등 일부 모델은 thinking 필드에 영어 ReAct 사고 trace를 길게 출력하는데,
      // 이걸 placeholder로 emit하면 사용자 채팅에 thinking + 도구 호출 마커가 누적되어
      // (a) <dialog_response> 형식이 깨지고 (b) 인증 토큰 등 민감 정보가 노출된다.
      // 다른 provider(Claude/Codex/Gemini/Kimi)와 동일하게 final 텍스트만 노출한다.
      if (typeof pr.response === "string" && pr.response.length > 0) return pr.response;
      if (typeof pr.modifiedResponse === "string" && pr.modifiedResponse.length > 0) return pr.modifiedResponse;
      return undefined;
    }
    // legacy / fallback candidates
    const candidates: unknown[] = [
      (item.assistantResponse as Record<string, unknown> | undefined)?.text,
      (item.modelOutput as Record<string, unknown> | undefined)?.text,
      (item.response as Record<string, unknown> | undefined)?.text,
      // agy 1.0.x ERROR_MESSAGE step: step.error (string) — 모델이 cascade를 죽인 직접 사유
      typeof item.error === "string" ? item.error : undefined,
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
    forgetAgyPid(this.agyPid);
    this.agyPid = null;
    this.lsPort = null;
    this.polling = false;
    this.initPromise = null;
    this.emit("status", "disconnected");
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } this.logStream = null; }
  }

  /** 모델 선택 문자열(antigravity-flash/-pro/-pro-low)을 agy displayName 패턴으로 매핑.
   *  버전이 올라도 안 깨지게 세대 숫자("3.5") 대신 등급("Flash (High)"/"Pro (High)")으로 매칭. */
  private modelPattern(model?: string): string {
    if (!model) return "Flash (High)";
    const lower = model.toLowerCase();
    if (lower.includes("pro-low")) return "Pro (Low)";
    if (lower.includes("pro")) return "Pro (High)";
    return "Flash (High)";
  }

  /** agy 1.0.5+는 모델 키가 동적 인덱스(MODEL_PLACEHOLDER_M{N})라 버전마다 바뀐다.
   *  GetAvailableModels(로컬 LS)로 displayName을 매칭해 현재 모델 키 문자열을 조회한다.
   *  agy는 cascade의 requestedModel.model을 lookup 키로 그대로 쓰므로(숫자만 보내면
   *  "unknown model key 37" 실패) `model` 필드 전체 문자열을 반환한다.
   *  실패 시 null → requestedModel 생략(agy default 모델). */
  private async resolveModelKeyDynamic(model?: string): Promise<string | null> {
    const pattern = this.modelPattern(model);
    try {
      const resp = await this.rpc<Record<string, unknown>>("GetAvailableModels", {});
      const models = this.collectModels(resp);
      const match = models.find(m => m.displayName.includes(pattern));
      if (match) {
        this.writeLog(`model resolved: "${pattern}" → "${match.displayName}" = "${match.model}"`);
        return match.model;
      }
      const avail = models.map(m => `${m.displayName}=${m.model}`).join(", ");
      this.writeLog(`model "${pattern}" not found among ${models.length} [${avail.slice(0, 400)}] — agy default`);
    } catch (err) {
      this.writeLog(`GetAvailableModels failed: ${err} — agy default`);
    }
    return null;
  }

  /** GetAvailableModels 응답을 재귀 walk해 {displayName, model} 쌍을 수집(중복 제거). */
  private collectModels(obj: unknown): Array<{ displayName: string; model: string }> {
    const out: Array<{ displayName: string; model: string }> = [];
    const seen = new Set<string>();
    const walk = (o: unknown): void => {
      if (!o || typeof o !== "object") return;
      const rec = o as Record<string, unknown>;
      if (typeof rec.displayName === "string" && typeof rec.model === "string") {
        const key = `${rec.model}|${rec.displayName}`;
        if (!seen.has(key)) { seen.add(key); out.push({ displayName: rec.displayName, model: rec.model }); }
      }
      for (const v of Object.values(rec)) walk(v);
    };
    walk(obj);
    return out;
  }

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
   *  Called once on first spawn so the user's global config is restored to whatever
   *  it was before our intrusion. trustedWorkspaces entries we added are intentionally
   *  left alone (the user may have grown to trust those dirs through normal IDE use). */
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
    // If all three lists now empty/absent, drop the `permissions` key entirely so the
    // user's settings file looks pristine.
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

  private async discoverLsPort(): Promise<number | null> {
    if (!this.agyPid) return null;
    for (let i = 0; i < 15; i++) {
      // 매 iter마다 재체크 — agy.exe가 즉시 exit하거나 외부에서 kill되면 agyPid가
      // null로 바뀐 상태에서 Get-NetTCPConnection -OwningProcess null 호출되어 PS 에러.
      if (!this.agyPid) {
        this.writeLog(`discoverLsPort: agyPid became null at iter ${i} — aborting`);
        return null;
      }
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
      // 비동기 sleep — 이전엔 execSync(Start-Sleep)로 node event loop를 700ms씩
      // 15회 = 10.5초 동안 통째로 블로킹했음. 다른 세션 요청까지 모두 hang.
      await new Promise(r => setTimeout(r, 700));
    }
    return null;
  }

  private async rpc<T = unknown>(method: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
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
          timeout: timeoutMs,
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
