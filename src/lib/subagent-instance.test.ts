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

test("emitSummary=false면 report_to_main 언급이 프리앰블 어디에도 없다", () => {
  const p = buildSubSystemPrompt({ ...base, emitSummary: false }, "본문");
  assert.doesNotMatch(p, /(?<!NOT )call report_to_main/);
  assert.match(p, /do NOT call report_to_main/);
});

test("emitSummary=true면 [OPERATOR] 예외에도 report_to_main 허가가 붙는다", () => {
  const p = buildSubSystemPrompt(base, "본문");
  assert.match(p, /use your tools and call report_to_main when you actually change state/);
});
