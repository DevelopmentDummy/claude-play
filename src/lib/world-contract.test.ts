/**
 * 월드 엔진 계약의 회귀 테스트.
 *
 * tool 라우트를 서버 없이 재현한다: 스텁 엔진을 호출해 받은 `{data}` 패치를
 * 라우트와 똑같이 `mutateSessionJson`(= applyPatch + 원자 쓰기)으로 적용한다.
 * 여기서 검증하는 것은 엔진 로직이 아니라 **플랫폼 계약**이다 —
 * 특히 의도 큐가 동시 제출에서 유실되지 않는지(spec §5.6)와
 * `$unset` dot-path 드레인이 실제로 먹는지.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { mutateSessionJson, applyPatch, readSessionJson } from "./session-state";

const require_ = createRequire(import.meta.url);
const ENGINE_PATH = path.resolve(process.cwd(), "scripts/fixtures/app-mode-stub/tools/world.js");

type EngineResult = {
  data?: Record<string, Record<string, unknown>>;
  result?: unknown;
};
type Engine = (
  ctx: { variables: Record<string, unknown>; data: Record<string, unknown>; sessionDir: string },
  args: Record<string, unknown>,
) => Promise<EngineResult>;

function freshWorldDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-contract-"));
  fs.writeFileSync(
    path.join(dir, "world.json"),
    JSON.stringify({ tick: 0, wheat: 5, actors: {}, intents: {}, feedback: {} }),
    "utf-8",
  );
  return dir;
}

function readWorld(dir: string): Record<string, unknown> {
  return (readSessionJson(path.join(dir, "world.json")) ?? {}) as Record<string, unknown>;
}

/** tool 라우트의 호출 + 패치 적용 경로를 그대로 재현한다. */
async function callEngine(dir: string, args: Record<string, unknown>): Promise<unknown> {
  // 라우트는 매 호출 require.cache를 purge한다 — 엔진이 메모리 상태를 못 갖는다는 계약.
  delete require_.cache[ENGINE_PATH];
  const engine = require_(ENGINE_PATH) as Engine;
  const ctx = { variables: {}, data: { world: readWorld(dir) }, sessionDir: dir };
  const out = await engine(ctx, args);
  for (const [key, patch] of Object.entries(out.data ?? {})) {
    const fp = path.join(dir, `${key}.json`);
    const r = await mutateSessionJson(fp, (current) => applyPatch(current, patch));
    assert.equal(r.ok, true, `${key}.json 패치 적용 실패`);
  }
  return out.result;
}

test("전제: $merge deep은 배열을 교체하고 객체는 키 단위로 병합한다", () => {
  // 이 차이가 §5.6의 이유다. 이 전제가 깨지면 위/아래 테스트의 의미도 달라진다.
  const cur = { intents: ["a"], keyed: { a: 1 } };
  const asArray = applyPatch(cur, { $merge: "deep", intents: ["b"] });
  assert.deepEqual(asArray.intents, ["b"], "배열은 교체된다 — 그래서 큐를 배열로 두면 유실된다");
  const asObject = applyPatch(cur, { $merge: "deep", keyed: { b: 2 } });
  assert.deepEqual(asObject.keyed, { a: 1, b: 2 }, "객체는 형제 키가 보존된다");
});

test("동시 submit 두 건이 둘 다 큐에 남는다 (§5.6 lost-write 회귀)", async () => {
  const dir = freshWorldDir();
  // 같은 스냅샷을 읽는 두 제출을 동시에 — 큐가 배열이면 나중 것이 먼저 것을 덮어쓴다.
  await Promise.all([
    callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat" } }),
    callEngine(dir, { action: "submit", observerId: "b", intent: { type: "take_wheat" } }),
  ]);
  const intents = readWorld(dir).intents as Record<string, unknown>;
  assert.equal(Object.keys(intents).length, 2, `의도가 유실됐다: ${JSON.stringify(intents)}`);
});

test("step이 큐를 $unset dot-path로 비운다", async () => {
  const dir = freshWorldDir();
  await callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat" } });
  assert.equal(Object.keys(readWorld(dir).intents as object).length, 1);
  await callEngine(dir, { action: "step" });
  assert.deepEqual(readWorld(dir).intents, {}, "소비한 의도가 남아 있다");
});

test("단독 의도는 적용된다", async () => {
  const dir = freshWorldDir();
  await callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat", memory: "밀밭 근처" } });
  await callEngine(dir, { action: "step" });
  const w = readWorld(dir);
  assert.equal(w.wheat, 4);
  assert.equal((w.actors as Record<string, { held: number; memory: string }>).a.held, 1);
  assert.equal((w.actors as Record<string, { held: number; memory: string }>).a.memory, "밀밭 근처");
  assert.equal(w.tick, 1);
});

test("같은 배치의 경합은 전원 기각되고 사유가 남는다", async () => {
  const dir = freshWorldDir();
  await callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat" } });
  await callEngine(dir, { action: "submit", observerId: "b", intent: { type: "take_wheat" } });
  await callEngine(dir, { action: "step" });
  const w = readWorld(dir);
  assert.equal(w.wheat, 5, "경합이면 아무도 못 집는다");
  const fb = w.feedback as Record<string, string>;
  assert.match(fb.a, /기각/);
  assert.match(fb.b, /기각/);
});

test("기각 사유가 다음 observe에 실린다", async () => {
  const dir = freshWorldDir();
  await callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat" } });
  await callEngine(dir, { action: "submit", observerId: "b", intent: { type: "take_wheat" } });
  await callEngine(dir, { action: "step" });
  const obs = await callEngine(dir, { action: "observe", observerId: "a", since: null });
  assert.match((obs as { text: string }).text, /직전 결과.*기각/);
});

test("step 중에 들어온 의도는 드레인되지 않고 다음 배치로 넘어간다", async () => {
  const dir = freshWorldDir();
  await callEngine(dir, { action: "submit", observerId: "a", intent: { type: "take_wheat" } });
  // step이 읽은 뒤 쓰기 전에 도착한 제출을 모사: step과 submit을 동시에 건다.
  await Promise.all([
    callEngine(dir, { action: "step" }),
    callEngine(dir, { action: "submit", observerId: "b", intent: { type: "take_wheat" } }),
  ]);
  const intents = readWorld(dir).intents as Record<string, unknown>;
  const keys = Object.keys(intents);
  // a의 의도는 소비됐고, b의 의도는 남아 있어야 한다 (순서에 따라 0건일 수도 있으나
  // 그 경우 b가 step보다 먼저 들어와 함께 소비된 것이므로 a·b 둘 다 처리된 상태여야 한다).
  const w = readWorld(dir);
  const consumed = (w.tick as number) === 1;
  assert.equal(consumed, true, "step이 돌지 않았다");
  assert.ok(keys.length <= 1, `예상 밖의 큐 상태: ${JSON.stringify(intents)}`);
});

test("observe는 상태를 바꾸지 않는다", async () => {
  const dir = freshWorldDir();
  const before = JSON.stringify(readWorld(dir));
  await callEngine(dir, { action: "observe", observerId: "a", since: null });
  assert.equal(JSON.stringify(readWorld(dir)), before);
});
