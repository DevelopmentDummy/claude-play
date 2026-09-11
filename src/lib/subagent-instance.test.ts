import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubSystemPrompt } from "./subagent-instance";
import type { SubAgentDef } from "./subagent-manifest";

const base: SubAgentDef = {
  name: "villager", role: "마을 주민", provider: "claude",
  instructions: "roles/villager.md", delegable: false,
  autoTrigger: "none", emitSummary: true,
};

test("params가 있으면 [THREAD] 블록이 붙는다", () => {
  const p = buildSubSystemPrompt(
    { ...base, threadId: "villager_03", params: { entityId: "e3" } },
    "역할 본문",
  );
  assert.match(p, /\[THREAD\]/);
  assert.match(p, /villager_03/);
  assert.match(p, /"entityId": *"e3"/);
  assert.match(p, /역할 본문/);
});

test("params가 없으면 [THREAD] 블록이 없다 — v1 하위호환", () => {
  const p = buildSubSystemPrompt(base, "본문");
  assert.doesNotMatch(p, /\[THREAD\]/);
});

test("report_to_main의 from은 threadId를 쓴다", () => {
  const p = buildSubSystemPrompt({ ...base, threadId: "villager_03", params: { a: 1 } }, "본문");
  assert.match(p, /from: "villager_03"/);
});
