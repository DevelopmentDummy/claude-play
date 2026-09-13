import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseThreadManifest } from "./thread-manifest";
import { readLiveThreads, writeLiveThreads, reconcileThreads, applyThreadOps } from "./thread-registry";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thread-reg-"));
}

const MANIFEST = parseThreadManifest({
  version: 2,
  roles: [{ name: "villager", instructions: "roles/villager.md", loop: { mode: "loop" } }],
  threads: [{ threadId: "v1", role: "villager", params: { entityId: "e1" } }],
});

test("threads.json이 없으면 매니페스트로 시드한다", () => {
  const d = tmpDir();
  const live = reconcileThreads(d, MANIFEST);
  assert.deepEqual(live.map((t) => t.threadId), ["v1"]);
  assert.ok(fs.existsSync(path.join(d, "threads.json")), "시드 후 파일이 생겨야 한다");
});

test("threads.json이 있으면 그것이 진실 — 매니페스트가 덮지 않는다", () => {
  const d = tmpDir();
  writeLiveThreads(d, [{ threadId: "v9", role: "villager", params: {} }]);
  const live = reconcileThreads(d, MANIFEST);
  assert.deepEqual(live.map((t) => t.threadId), ["v9"], "런타임에 스폰된 상태가 보존돼야 한다");
});

test("알 수 없는 역할을 참조하는 저장분은 버려진다", () => {
  const d = tmpDir();
  writeLiveThreads(d, [{ threadId: "v9", role: "gone", params: {} }]);
  assert.deepEqual(reconcileThreads(d, MANIFEST), []);
});

test("spawn/despawn을 적용하고 영속화한다", () => {
  const d = tmpDir();
  reconcileThreads(d, MANIFEST);
  const after = applyThreadOps(d, MANIFEST, {
    spawn: [{ threadId: "v2", role: "villager", params: { entityId: "e2" } }],
    despawn: ["v1"],
  });
  assert.deepEqual(after.map((t) => t.threadId), ["v2"]);
  assert.deepEqual(readLiveThreads(d).map((t) => t.threadId), ["v2"]);
});

test("잘못된 스폰 요청은 무시하고 나머지는 적용한다", () => {
  const d = tmpDir();
  reconcileThreads(d, MANIFEST);
  const after = applyThreadOps(d, MANIFEST, {
    spawn: [
      { threadId: "bad.id", role: "villager" },
      { threadId: "ok1", role: "nosuch" },
      { threadId: "ok2", role: "villager" },
    ],
  });
  assert.deepEqual(after.map((t) => t.threadId).sort(), ["ok2", "v1"]);
});

test("중복 스폰은 params를 갱신할 뿐 늘리지 않는다", () => {
  const d = tmpDir();
  reconcileThreads(d, MANIFEST);
  const after = applyThreadOps(d, MANIFEST, { spawn: [{ threadId: "v1", role: "villager", params: { entityId: "z" } }] });
  assert.equal(after.length, 1);
  assert.equal(after[0].params.entityId, "z");
});

test("상한을 넘는 스폰은 거부된다", () => {
  const d = tmpDir();
  reconcileThreads(d, MANIFEST);
  const spawn = Array.from({ length: 50 }, (_, i) => ({ threadId: `x${i}`, role: "villager" }));
  const after = applyThreadOps(d, MANIFEST, { spawn });
  assert.ok(after.length <= 12, `상한 12를 넘었다: ${after.length}`);
});
