import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThreadManifest, MIN_INTERVAL_MS } from "./thread-manifest";

test("v1 형식은 스레드 하나짜리 역할로 승격된다", () => {
  const m = parseThreadManifest({
    version: 1,
    subagents: [{ name: "archivist", role: "기록", instructions: "instructions.md" }],
  });
  assert.equal(m.roles.size, 1);
  const role = m.roles.get("archivist");
  assert.ok(role);
  assert.equal(role.loop.mode, "none");
  assert.deepEqual(m.threads, [{ threadId: "archivist", role: "archivist", params: {} }]);
});

test("v1의 autoTrigger는 loop.mode로 옮겨진다", () => {
  const m = parseThreadManifest({
    version: 1,
    subagents: [{ name: "a", role: "r", instructions: "i.md", autoTrigger: "onAssistantTurn" }],
  });
  assert.equal(m.roles.get("a")?.loop.mode, "onAssistantTurn");
});

test("v2 역할 + 스레드를 읽는다", () => {
  const m = parseThreadManifest({
    version: 2,
    roles: [{
      name: "villager", instructions: "roles/villager.md", scope: "local",
      loop: { mode: "loop", intervalMs: 8000, resetEveryTurns: 40 },
    }],
    threads: [{ threadId: "villager_03", role: "villager", params: { entityId: "villager_03" } }],
  });
  assert.equal(m.roles.get("villager")?.scope, "local");
  assert.equal(m.threads[0].params.entityId, "villager_03");
});

test("intervalMs는 하한으로 클램프된다", () => {
  const m = parseThreadManifest({
    version: 2,
    roles: [{ name: "r", instructions: "i.md", loop: { mode: "loop", intervalMs: 100 } }],
    threads: [],
  });
  assert.equal(m.roles.get("r")?.loop.intervalMs, MIN_INTERVAL_MS);
});

test("존재하지 않는 역할을 참조하는 스레드는 거부된다", () => {
  assert.throws(() => parseThreadManifest({
    version: 2,
    roles: [{ name: "a", instructions: "i.md" }],
    threads: [{ threadId: "t1", role: "nope" }],
  }), /unknown role/);
});

test("threadId 중복과 형식 위반을 거부한다", () => {
  assert.throws(() => parseThreadManifest({
    version: 2, roles: [{ name: "a", instructions: "i.md" }],
    threads: [{ threadId: "t1", role: "a" }, { threadId: "t1", role: "a" }],
  }), /duplicate/);
  assert.throws(() => parseThreadManifest({
    version: 2, roles: [{ name: "a", instructions: "i.md" }],
    threads: [{ threadId: "bad.id", role: "a" }],
  }), /invalid threadId/);
});

test("model에서 provider와 effort를 도출한다", () => {
  const m = parseThreadManifest({
    version: 2,
    roles: [{ name: "a", instructions: "i.md", model: "gpt-5.6-sol:high" }],
    threads: [],
  });
  const role = m.roles.get("a");
  assert.equal(role?.provider, "codex");
  assert.equal(role?.effort, "high");
  assert.equal(role?.model, "gpt-5.6-sol");
});

test("매니페스트가 없으면 빈 결과", () => {
  const m = parseThreadManifest({});
  assert.equal(m.roles.size, 0);
  assert.deepEqual(m.threads, []);
});
