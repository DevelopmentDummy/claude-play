import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDueThreads, ThreadLoop, type ThreadTickState } from "./thread-loop";
import type { RoleDef } from "./thread-manifest";

const T = (id: string, intervalMs: number) => ({ threadId: id, intervalMs });

test("주기가 안 된 스레드는 고르지 않는다", () => {
  const state: Record<string, ThreadTickState> = { a: { lastRunAt: 1000, turns: 0, busy: false } };
  assert.deepEqual(selectDueThreads(1500, [T("a", 5000)], state, 3), []);
  assert.deepEqual(selectDueThreads(6100, [T("a", 5000)], state, 3), ["a"]);
});

test("처음 보는 스레드는 즉시 깨운다", () => {
  assert.deepEqual(selectDueThreads(0, [T("a", 5000)], {}, 3), ["a"]);
});

test("바쁜 스레드는 건너뛴다 — 큐에 쌓지 않는다", () => {
  const state: Record<string, ThreadTickState> = { a: { lastRunAt: 0, turns: 0, busy: true } };
  assert.deepEqual(selectDueThreads(999_999, [T("a", 5000)], state, 3), []);
});

test("동시 실행 예산을 넘지 않는다", () => {
  const threads = [T("a", 1000), T("b", 1000), T("c", 1000), T("d", 1000)];
  const got = selectDueThreads(999_999, threads, {}, 2);
  assert.equal(got.length, 2);
});

test("예산이 0이면 아무것도 안 고른다", () => {
  assert.deepEqual(selectDueThreads(999_999, [T("a", 1000)], {}, 0), []);
});

test("가장 오래 기다린 스레드가 먼저 — 기아 방지", () => {
  const state: Record<string, ThreadTickState> = {
    a: { lastRunAt: 900, turns: 0, busy: false },
    b: { lastRunAt: 100, turns: 0, busy: false },
    c: { lastRunAt: 500, turns: 0, busy: false },
  };
  const got = selectDueThreads(999_999, [T("a", 1000), T("b", 1000), T("c", 1000)], state, 2);
  assert.deepEqual(got, ["b", "c"]);
});


function fakeRole(intervalMs: number): RoleDef {
  return {
    name: "r", instructions: "roles/r.md", instructionsFromSessionRoot: true,
    loop: { mode: "loop", intervalMs, resetEveryTurns: 999, summarizeOnReset: false },
    emitSummary: false, delegable: false, description: "r",
  };
}

/** step()/observe()가 HTTP를 타므로, 루프의 배선만 보려면 world-engine을 가로채야 한다.
 *  대신 여기서는 공개 표면(status/tick)과 의존성 호출 여부만 본다. */
test("월드 시계는 AI 스레드가 하나도 없어도 진행된다", async () => {
  // 스레드 0개 = 깨울 AI가 없는 상태. 예전 구현은 여기서 step에 도달조차 못 했다.
  const calls: string[] = [];
  const loop = new ThreadLoop({
    sessionId: "no-such-session-for-tick-test",
    app: { entry: "app/index.html", engine: "world", worldFile: "world.json", worldTickMs: 100, chatMode: "hidden" },
    loopThreads: () => { calls.push("loopThreads"); return []; },
    isBusy: () => false,
    dispatch: () => { calls.push("dispatch"); return true; },
    applyOps: () => {},
    hasClients: () => true,
    resetThread: () => {},
  });
  loop.start();
  await new Promise((r) => setTimeout(r, 350));
  loop.stop();
  // step()은 실제 세션이 없어 실패하지만, 시도했다는 것이 lastError에 남는다 —
  // 즉 AI가 없어도 월드 시계가 엔진을 부르러 갔다는 뜻이다.
  assert.notEqual(loop.status().lastError, null, "AI가 없으면 step을 시도조차 하지 않았다");
  assert.equal(calls.includes("dispatch"), false, "깨울 스레드가 없는데 디스패치했다");
});

test("일시정지하면 월드 시계도 멈춘다", async () => {
  const loop = new ThreadLoop({
    sessionId: "no-such-session-paused",
    app: { entry: "app/index.html", engine: "world", worldFile: "world.json", worldTickMs: 100, chatMode: "hidden" },
    loopThreads: () => [{ threadId: "t1", role: fakeRole(5000) }],
    isBusy: () => false,
    dispatch: () => true,
    applyOps: () => {},
    hasClients: () => true,
    resetThread: () => {},
  });
  loop.setPaused(true);
  loop.start();
  await new Promise((r) => setTimeout(r, 300));
  loop.stop();
  assert.equal(loop.status().lastError, null, "일시정지 중에 엔진을 불렀다");
});

test("클라이언트가 없으면 아무것도 돌지 않는다", async () => {
  const loop = new ThreadLoop({
    sessionId: "no-such-session-noclients",
    app: { entry: "app/index.html", engine: "world", worldFile: "world.json", worldTickMs: 100, chatMode: "hidden" },
    loopThreads: () => [{ threadId: "t1", role: fakeRole(5000) }],
    isBusy: () => false,
    dispatch: () => true,
    applyOps: () => {},
    hasClients: () => false,
    resetThread: () => {},
  });
  loop.start();
  await new Promise((r) => setTimeout(r, 300));
  loop.stop();
  assert.equal(loop.status().lastError, null, "클라이언트가 없는데 엔진을 불렀다");
});
