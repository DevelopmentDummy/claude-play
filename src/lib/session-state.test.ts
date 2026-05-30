import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, SYSTEM_JSON, LINT_SKIP_JSON } from "./session-state";

test("applyPatch: shallow 기본은 top-level 키를 교체한다", () => {
  const cur = { a: 1, nested: { x: 1, y: 2 } };
  const out = applyPatch(cur, { nested: { z: 3 } });
  assert.deepEqual(out, { a: 1, nested: { z: 3 } });
});

test("applyPatch: $merge:'deep'는 형제 키를 보존한다", () => {
  const cur = { rel: { trust: 1, affection: 5 } };
  const out = applyPatch(cur, { $merge: "deep", rel: { trust: 9 } });
  assert.deepEqual(out, { rel: { trust: 9, affection: 5 } });
});

test("applyPatch: deep merge는 배열을 통째로 교체한다", () => {
  const cur = { list: [1, 2, 3], o: { a: 1 } };
  const out = applyPatch(cur, { $merge: "deep", list: [9], o: { b: 2 } });
  assert.deepEqual(out, { list: [9], o: { a: 1, b: 2 } });
});

test("applyPatch: $unset은 top-level 및 dot-path 키를 삭제한다", () => {
  const cur = { keep: 1, gone: 2, flags: { temp: true, perm: false } };
  const out = applyPatch(cur, { $unset: ["gone", "flags.temp"] });
  assert.deepEqual(out, { keep: 1, flags: { perm: false } });
});

test("applyPatch: 디렉티브 키는 영속되지 않는다", () => {
  const out = applyPatch({}, { $merge: "deep", $unset: ["x"], a: 1 });
  assert.deepEqual(out, { a: 1 });
});

test("applyPatch: $unset이 입력을 변형하지 않는다(순수)", () => {
  const cur = { flags: { temp: true } };
  applyPatch(cur, { $unset: ["flags.temp"] });
  assert.deepEqual(cur, { flags: { temp: true } });
});

test("applyPatch: 빈 패치는 no-op 복제", () => {
  assert.deepEqual(applyPatch({ a: 1 }, {}), { a: 1 });
});

test("SSOT: SYSTEM_JSON union(17) + LINT_SKIP_JSON은 variables.json 미포함", () => {
  assert.equal(SYSTEM_JSON.has("comfyui-config.json"), true);
  assert.equal(SYSTEM_JSON.has("style-check.json"), true);
  assert.equal(SYSTEM_JSON.size, 17);
  assert.equal(LINT_SKIP_JSON.has("variables.json"), false);
  assert.equal(LINT_SKIP_JSON.has("voice.json"), false);
});
