import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDueThreads, type ThreadTickState } from "./thread-loop";

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
