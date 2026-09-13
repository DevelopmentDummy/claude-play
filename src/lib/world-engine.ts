import { getApiBase } from "./endpoints";
import { getInternalToken } from "./auth";

/** step()이 요청하는 스레드 스폰. threadId는 [a-z0-9_-]만 허용 (unsetPath dot 제약과 동일 규칙). */
export interface ThreadSpawnRequest {
  threadId: string;
  role: string;
  params?: Record<string, unknown>;
}

export interface StepResult {
  /** 스레드 런타임 명령. 패치가 아니므로 tool 라우트가 아니라 thread-loop이 해석한다. */
  threads?: { spawn?: ThreadSpawnRequest[]; despawn?: string[] };
  /** 엔진이 남기는 사람이 읽는 요약 (로그용) */
  note?: string;
}

/** 세션별 직렬 실행 큐. step()의 읽기-계산-쓰기를 하나의 임계 구역으로 묶는다.
 *  파일 뮤텍스(runExclusive)는 쓰기 순간만 잡으므로 이것을 대체하지 못한다. */
const sessionChains = new Map<string, Promise<unknown>>();

export function runExclusiveSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  // 이전 작업의 실패가 뒤 작업을 막지 않도록 체인은 항상 resolve로 잇는다.
  const next = prev.then(fn, fn);
  sessionChains.set(sessionId, next.then(() => undefined, () => undefined));
  return next;
}

interface ToolResponse {
  result?: unknown;
  error?: string;
}

/** 세션의 tool 라우트로 엔진 액션을 호출한다. 패치 적용은 라우트가 하고, 여기서는 result만 본다. */
async function callEngine(
  sessionId: string,
  engine: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(
    `${getApiBase()}/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(engine)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-token": getInternalToken() },
      body: JSON.stringify({ args }),
    },
  );
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as ToolResponse;
  if (!res.ok) throw new Error(`world engine ${String(args.action)} failed (${res.status}): ${data.error ?? text}`);
  return data.result;
}

/** 관찰자 시점 브리핑. since가 없으면 전체 스냅샷, 있으면 그 이후 변화분. */
export async function observe(
  sessionId: string,
  engine: string,
  observerId: string,
  opts?: { since?: number | null },
): Promise<string> {
  const r = await callEngine(sessionId, engine, {
    action: "observe",
    observerId,
    since: opts?.since ?? null,
  });
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
    return (r as { text: string }).text;
  }
  return r === undefined || r === null ? "" : JSON.stringify(r);
}

/** 의도 제출. 검증하지 않는다 — 검증은 step()의 몫. 세션 뮤텍스가 필요 없다:
 *  엔진이 $merge:"deep"로 자기 키만 쓰므로 동시 제출이 서로를 덮지 않는다 (spec §5.6). */
export async function submit(
  sessionId: string,
  engine: string,
  observerId: string,
  intent: unknown,
): Promise<void> {
  await callEngine(sessionId, engine, { action: "submit", observerId, intent });
}

/** 큐 배치 드레인 + 규칙 적용. 세션 뮤텍스 아래에서만 실행된다. */
export function step(sessionId: string, engine: string): Promise<StepResult> {
  return runExclusiveSession(sessionId, async () => {
    const r = await callEngine(sessionId, engine, { action: "step" });
    return (r && typeof r === "object" ? (r as StepResult) : {});
  });
}

/** 앱 렌더용 월드 상태. 읽기 전용이라 락이 없다. */
export function snapshot(sessionId: string, engine: string): Promise<unknown> {
  return callEngine(sessionId, engine, { action: "snapshot" });
}
