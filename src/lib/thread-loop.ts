import { observe, step, type StepResult } from "./world-engine";
import type { AppModeConfig } from "./app-mode";
import type { RoleDef } from "./thread-manifest";

/** 한 스레드의 틱 상태. */
export interface ThreadTickState {
  lastRunAt: number;
  /** 컨텍스트 리셋 판단용 누적 턴 수. */
  turns: number;
  busy: boolean;
  /** 직전 observe 시각 — 다음 observe의 since가 된다. 리셋되면 null. */
  lastObservedAt?: number | null;
}

export interface ThreadTickCandidate {
  threadId: string;
  intervalMs: number;
}

/**
 * 이번 틱에 깨울 스레드를 고른다. 순수 함수.
 * - 주기가 도래했고, 바쁘지 않고, 예산이 남은 스레드만
 * - 오래 기다린 순서(기아 방지)
 */
export function selectDueThreads(
  now: number,
  threads: ThreadTickCandidate[],
  state: Record<string, ThreadTickState>,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  const due = threads
    .filter((t) => {
      const s = state[t.threadId];
      if (!s) return true;                       // 처음 보는 스레드는 즉시
      if (s.busy) return false;                  // 바쁘면 이번 틱은 건너뛴다
      return now - s.lastRunAt >= t.intervalMs;
    })
    .sort((a, b) => (state[a.threadId]?.lastRunAt ?? -1) - (state[b.threadId]?.lastRunAt ?? -1));
  return due.slice(0, budget).map((t) => t.threadId);
}

export interface ThreadLoopStatus {
  running: boolean;
  paused: boolean;
  speed: number;
  tick: number;
  threads: number;
  lastError: string | null;
}

export interface ThreadLoopDeps {
  sessionId: string;
  app: AppModeConfig;
  /** 살아있는 루프 스레드 목록 (매 틱 새로 읽는다 — 런타임 스폰 반영). */
  loopThreads: () => Array<{ threadId: string; role: RoleDef }>;
  isBusy: (threadId: string) => boolean;
  dispatch: (threadId: string, task: string) => boolean;
  /** step()이 돌려준 스레드 명령 적용. */
  applyOps: (ops: NonNullable<StepResult["threads"]>) => void;
  /** 연결된 클라이언트가 있는지 — 없으면 자동 일시정지. */
  hasClients: () => boolean;
  /** 스레드의 컨텍스트를 버리고 상태 기반으로 재prime한다. */
  resetThread: (threadId: string) => void;
  broadcast?: (event: string, data: unknown) => void;
}

/** 세션 동시 실행 턴 상한. 프리워밍 스왑도 이 예산을 먹는다. */
const CONCURRENCY = Number(process.env.THREAD_CONCURRENCY) > 0 ? Number(process.env.THREAD_CONCURRENCY) : 3;
/** 한 틱의 디스패치 완료 대기 상한. 넘으면 다음 틱으로 넘긴다 (의도는 다음 배치에 합류). */
const TICK_WAIT_MS = Number(process.env.THREAD_TICK_WAIT_MS) > 0 ? Number(process.env.THREAD_TICK_WAIT_MS) : 120_000;
/** 스케줄러 기본 해상도. 실제 주기는 역할별 intervalMs가 정한다. */
const RESOLUTION_MS = 1_000;
/** 리셋 주기 지터 — 같은 역할 스레드들이 동시에 리셋되어 세계가 멈추는 것을 막는다. */
const RESET_JITTER = 0.2;

export class ThreadLoop {
  private readonly d: ThreadLoopDeps;
  private timer: NodeJS.Timeout | null = null;
  private state: Record<string, ThreadTickState> = {};
  private resetAt: Record<string, number> = {};
  private paused = false;
  private speed = 1;
  private tick = 0;
  private lastError: string | null = null;
  private ticking = false;

  constructor(deps: ThreadLoopDeps) {
    this.d = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runTick(); }, RESOLUTION_MS);
    // 서버 종료를 막지 않는다.
    this.timer.unref?.();
    this.emitStatus();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitStatus();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.emitStatus();
  }

  /** 1 = 기본. 2 = 주기 절반(2배 빠름). 0.5 = 2배 느림. 0.25~4로 클램프. */
  setSpeed(mult: number): void {
    this.speed = Math.min(4, Math.max(0.25, Number.isFinite(mult) ? mult : 1));
    this.emitStatus();
  }

  status(): ThreadLoopStatus {
    return {
      running: !!this.timer,
      paused: this.paused,
      speed: this.speed,
      tick: this.tick,
      threads: this.d.loopThreads().length,
      lastError: this.lastError,
    };
  }

  /** 메인이 깨어날 때 붙일 브리핑. 이벤트 큐 재생이 아니라 현재 월드 상태다 (spec §8.3). */
  async briefMain(): Promise<string> {
    try {
      return await observe(this.d.sessionId, this.d.app.engine, "main", { since: null });
    } catch (err) {
      console.warn(`[thread-loop:${this.d.sessionId}] main 브리핑 실패:`, err);
      return "";
    }
  }

  private emitStatus(): void {
    try { this.d.broadcast?.("threads:status", this.status()); } catch { /* ignore */ }
  }

  /** 리셋까지 남은 턴 수를 지터와 함께 정한다. */
  private resetBudgetFor(role: RoleDef): number {
    const base = role.loop.resetEveryTurns;
    const jitter = 1 + (Math.random() * 2 - 1) * RESET_JITTER;
    return Math.max(1, Math.round(base * jitter));
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;                 // 이전 틱이 아직 4단계에 있다
    if (this.paused) return;
    if (!this.d.hasClients()) return;         // 아무도 안 보면 태우지 않는다

    const threads = this.d.loopThreads();
    if (threads.length === 0) return;

    this.ticking = true;
    try {
      const now = Date.now();
      // 1단계: 후보 선정. busy는 매니저에서 실시간으로 읽는다.
      for (const t of threads) {
        const s = this.state[t.threadId];
        if (s) s.busy = this.d.isBusy(t.threadId);
      }
      const candidates = threads.map((t) => ({
        threadId: t.threadId,
        intervalMs: Math.max(1, Math.round(t.role.loop.intervalMs / this.speed)),
      }));
      const due = selectDueThreads(now, candidates, this.state, CONCURRENCY);
      if (due.length === 0) return;

      const roleOf = new Map(threads.map((t) => [t.threadId, t.role]));

      // 2단계: 병렬 observe → dispatch
      await Promise.all(due.map(async (threadId) => {
        const role = roleOf.get(threadId);
        if (!role) return;
        const prev = this.state[threadId];
        let text: string;
        try {
          text = await observe(this.d.sessionId, this.d.app.engine, threadId, {
            since: prev?.lastObservedAt ?? null,
          });
        } catch (err) {
          this.lastError = `observe(${threadId}): ${(err as Error).message}`;
          console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
          return;
        }
        const turns = (prev?.turns ?? 0) + 1;
        this.state[threadId] = {
          lastRunAt: Date.now(),
          turns,
          busy: true,
          lastObservedAt: Date.now(),
        };
        if (!text.trim()) return;              // 볼 게 없으면 턴을 낭비하지 않는다
        this.d.dispatch(threadId, text);
      }));

      // 3단계: 이번 틱의 턴들이 끝날 때까지 대기 (상한 초과 시 다음 틱으로)
      await this.waitForIdle(due, TICK_WAIT_MS);

      // 4단계: 세션 뮤텍스 아래 step() 1회 — 배치 드레인
      let result: StepResult = {};
      try {
        result = await step(this.d.sessionId, this.d.app.engine);
      } catch (err) {
        this.lastError = `step: ${(err as Error).message}`;
        console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
      }
      if (result.threads) {
        try { this.d.applyOps(result.threads); } catch (err) {
          console.warn(`[thread-loop:${this.d.sessionId}] applyOps 실패:`, err);
        }
      }

      // 5단계: 컨텍스트 리셋 (틱 경계 = step 적용 후)
      for (const threadId of due) {
        const role = roleOf.get(threadId);
        const s = this.state[threadId];
        if (!role || !s) continue;
        if (this.resetAt[threadId] === undefined) this.resetAt[threadId] = this.resetBudgetFor(role);
        if (s.turns >= this.resetAt[threadId]) {
          this.d.resetThread(threadId);
          s.turns = 0;
          s.lastObservedAt = null;             // 다음 observe는 전체 스냅샷
          this.resetAt[threadId] = this.resetBudgetFor(role);
        }
      }

      this.tick += 1;
      this.emitStatus();
    } finally {
      this.ticking = false;
    }
  }

  /** 디스패치된 스레드들이 전부 idle이 될 때까지 폴링 대기. 상한을 넘으면 그냥 돌아온다. */
  private async waitForIdle(threadIds: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = threadIds.filter((id) => this.d.isBusy(id));
      for (const id of threadIds) {
        const s = this.state[id];
        if (s) s.busy = busy.includes(id);
      }
      if (busy.length === 0) return;
      if (Date.now() >= deadline) {
        console.warn(`[thread-loop:${this.d.sessionId}] 틱 대기 상한 초과 — ${busy.join(",")} 의도는 다음 배치에 합류`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
