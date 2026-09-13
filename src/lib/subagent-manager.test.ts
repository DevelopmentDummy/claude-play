import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThreadManifest } from "./thread-manifest";
import { buildThreadDefs } from "./subagent-manager";

test("v1 매니페스트는 기존과 동일한 def를 만든다", () => {
  const m = parseThreadManifest({
    version: 1,
    subagents: [{ name: "archivist", role: "기록", instructions: "instructions.md" }],
  });
  const defs = buildThreadDefs(m, [{ threadId: "archivist", role: "archivist", params: {} }]);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, "archivist");
  assert.equal(defs[0].threadId, "archivist");
  assert.equal(defs[0].instructionsFromSessionRoot, false);
  assert.equal(defs[0].role, "기록");
});

test("같은 역할의 스레드 여러 개가 각자 params를 갖는다", () => {
  const m = parseThreadManifest({
    version: 2,
    roles: [{ name: "villager", instructions: "roles/villager.md", loop: { mode: "loop" } }],
    threads: [],
  });
  const defs = buildThreadDefs(m, [
    { threadId: "v1", role: "villager", params: { entityId: "e1" } },
    { threadId: "v2", role: "villager", params: { entityId: "e2" } },
  ]);
  assert.deepEqual(defs.map((d) => d.threadId), ["v1", "v2"]);
  assert.equal(defs[0].instructions, "roles/villager.md");
  assert.equal(defs[1].instructions, "roles/villager.md");
  assert.equal(defs[0].params?.entityId, "e1");
  assert.equal(defs[1].params?.entityId, "e2");
});

test("알 수 없는 역할의 스레드는 건너뛴다", () => {
  const m = parseThreadManifest({ version: 2, roles: [], threads: [] });
  assert.deepEqual(buildThreadDefs(m, [{ threadId: "x", role: "nope", params: {} }]), []);
});
