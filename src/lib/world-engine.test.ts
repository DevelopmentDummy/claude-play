import { test } from "node:test";
import assert from "node:assert/strict";
import { runExclusiveSession } from "./world-engine";

test("같은 세션의 작업은 직렬화된다 (lost update 방지)", async () => {
  let shared = 0;
  const order: string[] = [];
  const task = (tag: string) => runExclusiveSession("s1", async () => {
    const read = shared;                                  // 읽기
    await new Promise((r) => setTimeout(r, 10));          // 계산 (교차 유도)
    shared = read + 1;                                    // 쓰기
    order.push(tag);
  });
  await Promise.all([task("a"), task("b"), task("c")]);
  assert.equal(shared, 3, "직렬화되지 않으면 3이 아니다");
  assert.deepEqual(order, ["a", "b", "c"], "FIFO 순서여야 한다");
});

test("다른 세션은 서로를 막지 않는다", async () => {
  const started: string[] = [];
  // gate를 바깥에서 만든다 — 콜백 안에서 대입하면 TS가 타입을 never로 좁힌다.
  const gate: { release: () => void } = { release: () => {} };
  const blocked = new Promise<void>((r) => { gate.release = r; });
  const a = runExclusiveSession("A", async () => {
    started.push("A");
    await blocked;
  });
  await new Promise((r) => setTimeout(r, 5));
  const b = runExclusiveSession("B", async () => { started.push("B"); });
  await b;
  assert.deepEqual(started, ["A", "B"], "B는 A를 기다리지 않아야 한다");
  gate.release();
  await a;
});

test("작업이 throw해도 락이 풀린다", async () => {
  await assert.rejects(runExclusiveSession("s2", async () => { throw new Error("boom"); }));
  let ran = false;
  await runExclusiveSession("s2", async () => { ran = true; });
  assert.equal(ran, true, "이전 실패가 락을 잠그면 안 된다");
});
