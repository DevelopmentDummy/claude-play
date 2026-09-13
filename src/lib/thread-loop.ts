import { observe, step, type StepResult } from "./world-engine";
import type { AppModeConfig } from "./app-mode";
import type { RoleDef } from "./thread-manifest";

/** 한 스레드의 스케줄 상태. */
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
 * 이번 회차에 깨울 스레드를 고른다. 순수 함수.
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
      if (s.busy) return false;                  // 바쁘면 이번 회차는 건너뛴다
      return now - s.lastRunAt >= t.intervalMs;
    })
    .sort((a, b) => (state[a.threadId]?.lastRunAt ?? -1) - (state[b.threadId]?.lastRunAt ?? -1));
  return due.slice(0, budget).map((t) => t.threadId);
}

export interface ThreadLoopStatus {
  running: boolean;
  paused: boolean;
  speed: number;
  /** 지금까지 진행된 월드 틱 수 (AI와 무관하게 오른다). */
  tick: number;
  threads: number;
  /** 현재 턴을 돌고 있는 스레드 수. */
  busy: number;
  lastError: string | null;
}

export interface ThreadLoopDeps {
  sessionId: string;
  app: AppModeConfig;
  /** 살아있는 루프 스레드 목록 (매번 새로 읽는다 — 런타임 스폰 반영). */
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

/** 동시에 턴을 도는 스레드 수 상한. 프리워밍 스왑도 이 예산을 먹는다. */
const CONCURRENCY = Number(process.env.THREAD_CONCURRENCY) > 0 ? Number(process.env.THREAD_CONCURRENCY) : 3;
/** 스레드 스케줄러 해상도. 실제 주기는 역할별 intervalMs가 정한다. */
const SCHEDULER_MS = 1_000;
/** 리셋 주기 지터 — 같은 역할 스레드들이 동시에 리셋되어 세계가 멈추는 것을 막는다. */
const RESET_JITTER = 0.2;

/**
 * 앱 모드 런타임. **월드 시계와 AI 스케줄링은 서로를 기다리지 않는다.**
 *
 * - **월드 시계**: `worldTickMs`마다 `step()`을 부른다. 큐에 도착해 있는 의도만 꺼내
 *   판정·적용하고, 없으면 없는 대로 세계를 진행시킨다(시간 경과·정책 이동·자원 변화).
 *   AI가 한 명도 안 깨어 있어도, 느린 스레드가 있어도 시계는 계속 간다.
 * - **스레드 스케줄러**: 주기가 된 스레드에 `observe` → `dispatch`를 걸고 **기다리지 않는다**.
 *   스레드는 백그라운드에서 돌다가 끝날 때 `submit`으로 의도를 큐에 넣는다.
 *
 * 즉 의도는 비동기로 도착하고 월드 틱이 폴링한다. 늦게 도착한 의도는 다음 틱 배치에 합류한다.
 * 관측 시점과 적용 시점이 어긋나는 것은 버그가 아니라 이 모델의 전제다 — 엔진이 규칙에
 * 비추어 기각하고, 사유가 다음 `observe`에 실려 돌아간다(권위 서버 + 커맨드 큐).
 */
export class ThreadLoop {
  private readonly d: ThreadLoopDeps;
  private worldTimer: NodeJS.Timeout | null = null;
  private schedTimer: NodeJS.Timeout | null = null;
  private state: Record<string, ThreadTickState> = {};
  private resetAt: Record<string, number> = {};
  private paused = false;
  private speed = 1;
  private tick = 0;
  private lastError: string | null = null;
  /** step()이 아직 진행 중 — 틱이 겹쳐 쌓이지 않게 한다. */
  private stepping = false;

  constructor(deps: ThreadLoopDeps) {
    this.d = deps;
  }

  start(): void {
    if (this.worldTimer || this.schedTimer) return;
    // 재open마다 ThreadLoop이 새로 만들어지므로 state가 비어 있다. 그대로 두면
    // selectDueThreads가 모든 스레드를 "처음 보는 스레드"로 보고 예산만큼 한꺼번에
    // 깨우고, 각자 since=null로 전체 스냅샷을 받는다 — 재open마다 토큰 스파이크.
    const now = Date.now();
    for (const t of this.d.loopThreads()) {
      if (!this.state[t.threadId]) {
        this.state[t.threadId] = { lastRunAt: now, turns: 0, busy: false, lastObservedAt: null };
      }
    }
    // 월드 시계와 스레드 스케줄러는 독립적으로 돈다 — 서로를 기다리지 않는다.
    this.worldTimer = setInterval(() => { void this.worldTick(); }, this.worldIntervalMs());
    this.schedTimer = setInterval(() => { void this.scheduleDue(); }, SCHEDULER_MS);
    this.worldTimer.unref?.();
    this.schedTimer.unref?.();
    this.emitStatus();
  }

  stop(): void {
    if (this.worldTimer) clearInterval(this.worldTimer);
    if (this.schedTimer) clearInterval(this.schedTimer);
    this.worldTimer = null;
    this.schedTimer = null;
    this.emitStatus();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.emitStatus();
  }

  /** 1 = 기본. 2 = 2배 빠름(월드 틱·스레드 주기 모두). 0.25~4로 클램프. */
  setSpeed(mult: number): void {
    const next = Math.min(4, Math.max(0.25, Number.isFinite(mult) ? mult : 1));
    if (next === this.speed) return;
    this.speed = next;
    // 월드 틱 간격이 속도에 걸리므로 타이머를 다시 건다.
    if (this.worldTimer) {
      clearInterval(this.worldTimer);
      this.worldTimer = setInterval(() => { void this.worldTick(); }, this.worldIntervalMs());
      this.worldTimer.unref?.();
    }
    this.emitStatus();
  }

  status(): ThreadLoopStatus {
    const threads = this.d.loopThreads();
    return {
      running: !!this.worldTimer,
      paused: this.paused,
      speed: this.speed,
      tick: this.tick,
      threads: threads.length,
      busy: threads.filter((t) => this.d.isBusy(t.threadId)).length,
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

  private worldIntervalMs(): number {
    return Math.max(100, Math.round(this.d.app.worldTickMs / this.speed));
  }

  private active(): boolean {
    if (this.paused) return false;
    // 아무도 안 보면 멈춘다 — 토큰뿐 아니라 월드 진행도 멈춰 복귀 시 상태가 튀지 않게.
    return this.d.hasClients();
  }

  private emitStatus(): void {
    try { this.d.broadcast?.("threads:status", this.status()); } catch { /* ignore */ }
  }

  /** 리셋까지의 턴 수를 지터와 함께 정한다. */
  private resetBudgetFor(role: RoleDef): number {
    const base = role.loop.resetEveryTurns;
    const jitter = 1 + (Math.random() * 2 - 1) * RESET_JITTER;
    return Math.max(1, Math.round(base * jitter));
  }

  /**
   * 월드 시계. AI와 무관하게 `worldTickMs`마다 돈다.
   * 큐에 도착해 있는 의도만 꺼내 판정하고, 없으면 없는 대로 세계를 진행시킨다.
   */
  private async worldTick(): Promise<void> {
    if (!this.active()) return;
    if (this.stepping) return;            // 이전 step이 아직 진행 중 — 쌓지 않는다
    this.stepping = true;
    try {
      let result: StepResult = {};
      try {
        result = await step(this.d.sessionId, this.d.app.engine);
      } catch (err) {
        this.lastError = `step: ${(err as Error).message}`;
        console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
        return;
      }
      if (result.threads) {
        try { this.d.applyOps(result.threads); } catch (err) {
          console.warn(`[thread-loop:${this.d.sessionId}] applyOps 실패:`, err);
        }
      }
      this.tick += 1;
      this.emitStatus();
    } finally {
      this.stepping = false;
    }
  }

  /**
   * 스레드 스케줄러. 주기가 된 스레드에 관측을 물려 디스패치하고 **기다리지 않는다**.
   * 완료는 스레드가 `submit`으로 큐에 넣는 것으로 드러나고, 월드 틱이 그걸 폴링한다.
   */
  private async scheduleDue(): Promise<void> {
    if (!this.active()) return;

    const threads = this.d.loopThreads();
    if (threads.length === 0) return;

    // busy는 매니저에서 실시간으로 읽는다.
    let busyCount = 0;
    for (const t of threads) {
      const busy = this.d.isBusy(t.threadId);
      if (busy) busyCount += 1;
      const s = this.state[t.threadId];
      if (s) s.busy = busy;
    }

    const roleOf = new Map(threads.map((t) => [t.threadId, t.role]));

    // 컨텍스트 리셋은 스레드가 idle일 때 — 턴 사이의 자연스러운 경계다.
    for (const t of threads) {
      const s = this.state[t.threadId];
      if (!s || s.busy) continue;
      const role = roleOf.get(t.threadId);
      if (!role) continue;
      if (this.resetAt[t.threadId] === undefined) this.resetAt[t.threadId] = this.resetBudgetFor(role);
      if (s.turns >= this.resetAt[t.threadId]) {
        this.d.resetThread(t.threadId);
        s.turns = 0;
        s.lastObservedAt = null;              // 다음 observe는 전체 스냅샷
        s.lastRunAt = Date.now();             // 프리워밍이 끝날 시간을 준다
        this.resetAt[t.threadId] = this.resetBudgetFor(role);
      }
    }

    // 남은 동시 실행 예산만큼만 새로 깨운다.
    const budget = CONCURRENCY - busyCount;
    const candidates = threads.map((t) => ({
      threadId: t.threadId,
      intervalMs: Math.max(1, Math.round(t.role.loop.intervalMs / this.speed)),
    }));
    const due = selectDueThreads(Date.now(), candidates, this.state, budget);
    if (due.length === 0) return;

    // fire-and-forget: 각 스레드를 독립적으로 깨우고 완료를 기다리지 않는다.
    for (const threadId of due) {
      void this.wakeThread(threadId);
    }
  }

  /** 한 스레드에 관측을 물려 디스패치한다. 턴 완료를 기다리지 않는다. */
  private async wakeThread(threadId: string): Promise<void> {
    const prev = this.state[threadId];
    // 디스패치 전에 선점해 둔다 — observe를 기다리는 동안 다음 스케줄 회차가
    // 같은 스레드를 또 고르지 않게.
    this.state[threadId] = {
      lastRunAt: Date.now(),
      turns: (prev?.turns ?? 0) + 1,
      busy: true,
      lastObservedAt: prev?.lastObservedAt ?? null,
    };

    let text: string;
    try {
      text = await observe(this.d.sessionId, this.d.app.engine, threadId, {
        since: prev?.lastObservedAt ?? null,
      });
    } catch (err) {
      this.lastError = `observe(${threadId}): ${(err as Error).message}`;
      console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
      // 관측이 실패했으면 턴을 쓰지 않았으므로 되돌린다.
      if (prev) this.state[threadId] = { ...prev, busy: false };
      return;
    }

    this.state[threadId].lastObservedAt = Date.now();

    if (!text.trim()) {
      // 볼 게 없으면 턴을 낭비하지 않는다. 턴 카운트도 되돌린다.
      this.state[threadId].turns = prev?.turns ?? 0;
      this.state[threadId].busy = false;
      return;
    }
    this.d.dispatch(threadId, text);
  }
}
