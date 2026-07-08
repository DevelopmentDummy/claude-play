/**
 * Standalone behavior harness for ai-provider (no test framework configured).
 * Run:  npx tsx src/lib/ai-provider.test.mts
 * Exits non-zero on any failure.
 */
const mod = (await import("./ai-provider.ts")) as unknown as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const parseModelEffort = (mod.parseModelEffort ?? (mod.default as Record<string, unknown>)?.parseModelEffort) as
  (v: string) => { model: string; effort: string | undefined; advisor: string | undefined };
const providerFromModel = (mod.providerFromModel ?? (mod.default as Record<string, unknown>)?.providerFromModel) as
  (v: string) => string;
const resolveBuilderModel = (mod.resolveBuilderModel ?? (mod.default as Record<string, unknown>)?.resolveBuilderModel) as
  (v?: string) => { model: string; effort: string | undefined; provider: string; combined: string; advisor: string | undefined };

let pass = 0, fail = 0;
function eq(label: string, got: unknown, expected: unknown) {
  const g = JSON.stringify(got), e = JSON.stringify(expected);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${label}\n  got=${g}\n  exp=${e}`); }
}

// advisor 없는 기존 형식은 advisor=undefined
eq("plain", parseModelEffort("opus"), { model: "opus", effort: undefined, advisor: undefined });
eq("effort", parseModelEffort("opus:high"), { model: "opus", effort: "high", advisor: undefined });
// advisor 접미사
eq("advisor-only", parseModelEffort("opus@fable"), { model: "opus", effort: undefined, advisor: "fable" });
eq("effort+advisor", parseModelEffort("opus:high@fable"), { model: "opus", effort: "high", advisor: "fable" });
eq("ultracode+advisor", parseModelEffort("opus:ultracode@fable"), { model: "opus", effort: "ultracode", advisor: "fable" });
// @가 붙어도 provider 판정은 베이스 기준
eq("provider-with-advisor", providerFromModel("opus:ultracode@fable"), "claude");
// resolveBuilderModel: combined에 @advisor 유지
eq("builder-combined", resolveBuilderModel("opus:high@fable").combined, "opus:high@fable");
eq("builder-advisor", resolveBuilderModel("opus@fable").advisor, "fable");
// 슬래시 포함 모델 id는 advisor 분리 영향 없음
eq("kimi-slash", parseModelEffort("moonshot-ai/kimi-k2.6:thinking"), { model: "moonshot-ai/kimi-k2.6", effort: "thinking", advisor: undefined });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
