import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyPatch, SYSTEM_JSON, LINT_SKIP_JSON,
  mutateSessionJsonSync, resolveSessionFilePath, readSessionJson, loadSessionData,
} from "./session-state";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
}

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

test("resolveSessionFilePath: .json 부착", () => {
  assert.equal(resolveSessionFilePath("/s", "inventory"), path.join("/s", "inventory.json"));
});
test("resolveSessionFilePath: traversal 차단 → null", () => {
  assert.equal(resolveSessionFilePath("/s", "../secret"), null);
  assert.equal(resolveSessionFilePath("/s", "a/b.json"), null);
});

test("mutateSessionJsonSync: 신규 파일 2-space, BOM 없음", () => {
  const fp = path.join(tmpDir(), "variables.json");
  const r = mutateSessionJsonSync(fp, (cur) => ({ ...cur, a: 1 }));
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(fp, "utf-8");
  assert.notEqual(raw.charCodeAt(0), 0xfeff);
  assert.equal(raw, '{\n  "a": 1\n}');
});

test("mutateSessionJsonSync: 기존 갱신 + 읽기 BOM strip", () => {
  const fp = path.join(tmpDir(), "v.json");
  fs.writeFileSync(fp, "﻿" + JSON.stringify({ a: 1 }), "utf-8");
  const r = mutateSessionJsonSync(fp, (cur) => applyPatch(cur, { b: 2 }));
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf-8")), { a: 1, b: 2 });
});

test("mutateSessionJsonSync: 깨진 기존 파일은 abort(미덮어쓰기)", () => {
  const fp = path.join(tmpDir(), "v.json");
  fs.writeFileSync(fp, "{ not json", "utf-8");
  const r = mutateSessionJsonSync(fp, () => ({ a: 1 }));
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(fp, "utf-8"), "{ not json");
});

test("mutateSessionJsonSync: transform throw → ok:false, 파일 미생성", () => {
  const fp = path.join(tmpDir(), "v.json");
  const r = mutateSessionJsonSync(fp, () => { throw new Error("boom"); });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(fp), false);
});

test("mutateSessionJsonSync: 성공 후 .tmp 잔여 없음", () => {
  const dir = tmpDir();
  mutateSessionJsonSync(path.join(dir, "v.json"), () => ({ a: 1 }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("readSessionJson: 없으면 null", () => {
  assert.equal(readSessionJson(path.join(tmpDir(), "nope.json")), null);
});

test("loadSessionData: 비시스템 *.json만 data로, variables 분리", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ hp: 5 }), "utf-8");
  fs.writeFileSync(path.join(dir, "inventory.json"), JSON.stringify({ gold: 10 }), "utf-8");
  fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify({ x: 1 }), "utf-8");
  const { variables, data } = loadSessionData(dir);
  assert.deepEqual(variables, { hp: 5 });
  assert.deepEqual(data, { inventory: { gold: 10 } });
});
