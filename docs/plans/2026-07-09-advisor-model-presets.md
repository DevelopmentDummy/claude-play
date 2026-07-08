# Advisor 모델 프리셋 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Bridge 모델 선택기에 "Opus 베이스 + Fable advisor" 조합 프리셋 3개를 추가하고, 세션 spawn 시 `claude -p`에 `--advisor` 플래그를 전달한다.

**Architecture:** advisor를 모델 값 문자열의 `@advisor` 접미사로 인코딩(`모델[:effort][@advisor]`). `parseModelEffort`/`resolveBuilderModel`이 이를 분해하고, Claude spawn 호출부 5곳이 `claude-process.spawn(...)`의 새 `advisor` 파라미터로 전달한다. 프론트엔드는 `MODEL_GROUPS`를 그대로 렌더하므로 변경 없음.

**Tech Stack:** TypeScript(strict), Next.js API routes, Node child_process. 테스트 프레임워크 없음 — 스탠드얼론 `npx tsx` 하네스 사용.

## Global Constraints

- TypeScript strict — `any` 금지.
- 리포 경로에 공백 존재(`C:\repository\claude bridge`) — 셸 명령에서 경로 인용.
- 커밋 전 `npm run typecheck` 필수, 머지 전 `npm run verify`.
- advisor는 **Claude 프로바이더 전용** — 다른 프로바이더 spawn 경로는 건드리지 않는다.
- `@`는 advisor 구분자 — 어떤 모델 id에도 쓰이지 않음(충돌 없음).
- 하위호환: 기존 `{ model, effort }` 구조분해 호출부는 그대로 동작해야 함.

---

### Task 1: `parseModelEffort` / `resolveBuilderModel` advisor 파싱 + 프리셋 등록

**Files:**
- Modify: `src/lib/ai-provider.ts:63-67` (`parseModelEffort`), `:138-145` (`resolveBuilderModel`), `:152-169` (Claude 그룹 옵션)
- Test: `src/lib/ai-provider.test.mts` (신규)

**Interfaces:**
- Produces:
  - `parseModelEffort(value: string): { model: string; effort: string | undefined; advisor: string | undefined }`
  - `resolveBuilderModel(rawModel?, providerOverride?): { model; effort; provider; combined; advisor: string | undefined }`
  - 프리셋 값: `"opus@fable"`, `"opus:high@fable"`, `"opus:ultracode@fable"`

- [ ] **Step 1: 실패 테스트 작성**

`src/lib/ai-provider.test.mts` 생성:

```typescript
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx tsx "src/lib/ai-provider.test.mts"`
Expected: FAIL — 현재 `parseModelEffort`는 `advisor` 필드가 없어 `advisor-only` 등에서 불일치, `builder-combined`는 `opus:high`(advisor 유실).

- [ ] **Step 3: `parseModelEffort` 확장**

`src/lib/ai-provider.ts`의 기존 함수(63-67행)를 교체:

```typescript
/**
 * Parse a model value that may carry an effort suffix and/or an advisor suffix.
 * Grammar: <model>[:<effort>][@<advisor>]
 * e.g. "opus:medium"        → { model: "opus", effort: "medium", advisor: undefined }
 *      "opus:ultracode@fable" → { model: "opus", effort: "ultracode", advisor: "fable" }
 *      "opus@fable"          → { model: "opus", effort: undefined, advisor: "fable" }
 * The advisor (`@…`) is split off first so it never contaminates the effort slot.
 */
export function parseModelEffort(value: string): { model: string; effort: string | undefined; advisor: string | undefined } {
  if (!value) return { model: "", effort: undefined, advisor: undefined };
  let rest = value;
  let advisor: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    advisor = rest.slice(at + 1) || undefined;
    rest = rest.slice(0, at);
  }
  const parts = rest.split(":");
  return { model: parts[0], effort: parts[1] || undefined, advisor };
}
```

- [ ] **Step 4: `resolveBuilderModel` 확장**

기존 함수(138-145행)를 교체 (advisor 보존 + combined 재조립):

```typescript
export function resolveBuilderModel(rawModel?: string, providerOverride?: AIProvider) {
  const { model: parsed, effort: parsedEffort, advisor } = parseModelEffort(rawModel || "");
  const provider = providerOverride || (parsed ? providerFromModel(parsed) : "claude");
  const model = parsed || DEFAULT_MODELS[provider];
  const effort = parsedEffort || DEFAULT_EFFORTS[provider];
  const base = effort ? `${model}:${effort}` : model;
  const combined = advisor ? `${base}@${advisor}` : base;
  return { model, effort, provider, combined, advisor };
}
```

- [ ] **Step 5: Claude 그룹에 프리셋 3개 추가**

`buildModelGroups()`의 Claude 그룹 `options` 배열에서 `claude-fable-5:ultracode` 항목 뒤(168행 다음)에 추가:

```typescript
        // Opus 베이스 + Fable advisor 조합 프리셋 (advisor는 claude -p 전용, `--advisor`로 전달).
        { value: "opus@fable", label: "Opus + Fable advisor" },
        { value: "opus:high@fable", label: "Opus High + Fable advisor" },
        { value: "opus:ultracode@fable", label: "Opus Ultracode + Fable advisor" },
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx tsx "src/lib/ai-provider.test.mts"`
Expected: PASS — `N passed, 0 failed`.

- [ ] **Step 7: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음. (기존 `{ model, effort }` 구조분해 호출부는 새 `advisor` 필드를 무시하므로 영향 없음.)

- [ ] **Step 8: 커밋**

```bash
git add "src/lib/ai-provider.ts" "src/lib/ai-provider.test.mts"
git commit -m "feat(model): parse @advisor suffix + add Opus×Fable advisor presets"
```

---

### Task 2: `claude-process.spawn`에 `advisor` 전달

**Files:**
- Modify: `src/lib/claude-process.ts:159` (`lastSpawnParams` 타입), `:168` (spawn 시그니처), `:170` (params 저장), `:205-211` (args 조립), `:414-417` (`respawn`)

**Interfaces:**
- Consumes: `parseModelEffort(...).advisor` (Task 1).
- Produces: `spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions?, logName?, advisor?)` — 마지막 옵션 파라미터 `advisor?: string`. 있으면 `--advisor <advisor>` args에 추가.

- [ ] **Step 1: `lastSpawnParams` 타입에 advisor 추가**

159행 교체:

```typescript
  private lastSpawnParams: { cwd: string; model?: string; appendSystemPrompt?: string; effort?: string; skipPermissions?: boolean; logName?: string; advisor?: string } | null = null;
```

- [ ] **Step 2: spawn 시그니처 + 저장 갱신**

168행 시그니처 교체:

```typescript
  spawn(cwd: string, resumeId?: string, model?: string, appendSystemPrompt?: string, effort?: string, skipPermissions = true, logName = "claude-stream.log", advisor?: string): void {
```

170행 교체:

```typescript
    this.lastSpawnParams = { cwd, model, appendSystemPrompt, effort, skipPermissions, logName, advisor };
```

- [ ] **Step 3: args에 `--advisor` 추가**

`--model` 블록(205-207행) 바로 뒤, `--effort` 블록 앞에 삽입:

```typescript
    if (model) {
      args.push("--model", model);
    }

    if (advisor) {
      args.push("--advisor", advisor);
    }
```

- [ ] **Step 4: `respawn`이 advisor 복원하도록 갱신**

417행 교체 (마지막 인자로 advisor 전달):

```typescript
    this.spawn(p.cwd, this.lastSessionId || undefined, p.model, p.appendSystemPrompt, p.effort, p.skipPermissions, p.logName, p.advisor);
```

- [ ] **Step 5: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음. (advisor는 선택 파라미터라 기존 호출부 영향 없음.)

- [ ] **Step 6: 커밋**

```bash
git add "src/lib/claude-process.ts"
git commit -m "feat(claude-process): thread --advisor flag through spawn/respawn"
```

---

### Task 3: Claude spawn 호출부 5곳에 advisor 배선

**Files:**
- Modify: `src/app/api/sessions/[id]/open/route.ts:33,117`
- Modify: `src/app/api/sessions/[id]/options/apply/route.ts:46,59`
- Modify: `src/app/api/sessions/[id]/sync/route.ts:66,75`
- Modify: `src/app/api/builder/start/route.ts:82`
- Modify: `src/app/api/builder/edit/route.ts:113`

**Interfaces:**
- Consumes: `parseModelEffort(...).advisor`, `resolveBuilderModel(...).advisor` (Task 1); `spawn(..., advisor)` (Task 2).

- [ ] **Step 1: open route**

33행 교체 (advisor 캡처):

```typescript
  const { model: effectiveModel, effort: effectiveEffort, advisor: effectiveAdvisor } = parseModelEffort(effectiveRaw);
```

117행 교체 (advisor 전달 — logName 기본값 명시 필요):

```typescript
    instance.claude.spawn(sessionDir, resumeId, effectiveModel || undefined, runtimeSystemPrompt, finalEffort, skipPerms, "claude-stream.log", effectiveAdvisor);
```

- [ ] **Step 2: options/apply route**

46행 교체:

```typescript
    const { model, effort, advisor } = parseModelEffort(savedModel);
```

59행 교체:

```typescript
    instance.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort, skipPerms, "claude-stream.log", advisor);
```

- [ ] **Step 3: sync route**

66행 교체:

```typescript
    const { model, effort, advisor } = parseModelEffort(savedModel);
```

75행 교체:

```typescript
    instance.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort, skipPerms, "claude-stream.log", advisor);
```

- [ ] **Step 4: builder/start route**

82행 교체 (skipPermissions 기본 true + logName 기본값 명시 후 advisor):

```typescript
  instance.claude.spawn(personaDir, undefined, resolved.model, runtimeSystemPrompt, resolved.effort, true, "claude-stream.log", resolved.advisor);
```

- [ ] **Step 5: builder/edit route**

113행 교체 (원본은 5개 인자 — skipPermissions 기본 true + logName 기본값 명시 후 advisor):

```typescript
    instance.claude.spawn(personaDir, resumeId, resolved.model, runtimeSystemPrompt, resolved.effort, true, "claude-stream.log", resolved.advisor);
```

- [ ] **Step 6: 타입체크**

Run: `npm run typecheck`
Expected: 에러 없음.

- [ ] **Step 7: 커밋**

```bash
git add "src/app/api/sessions/[id]/open/route.ts" "src/app/api/sessions/[id]/options/apply/route.ts" "src/app/api/sessions/[id]/sync/route.ts" "src/app/api/builder/start/route.ts" "src/app/api/builder/edit/route.ts"
git commit -m "feat(sessions): pass advisor from model string to claude spawn"
```

---

### Task 4: 검증 게이트 + 라이브 스모크

**Files:** 없음 (검증만).

- [ ] **Step 1: verify 게이트**

Run: `npm run verify`
Expected: typecheck + lint:data + check:static + smoke 모두 통과.

- [ ] **Step 2: 라이브 스모크 (dev 서버)**

Run: `npm run dev` 로 서버 기동 후, UI 모델 선택기에서 **"Opus Ultracode + Fable advisor"** 로 세션을 새로 열거나 옵션 적용.

확인: 해당 세션 디렉터리의 `claude-stream.log` 최신 `--- spawn … args: …` 라인에 `--advisor fable` 와 `--effort xhigh`, `CLAUDE_CODE_WORKFLOWS`(env) 가 포함되는지.

```bash
# 세션 디렉터리에서
grep -- "--advisor" "claude-stream.log" | tail -1
```
Expected: `... --model opus --advisor fable --effort xhigh ...` 형태의 라인 출력.

- [ ] **Step 3: 문서 갱신 확인**

`docs/` 구조 진실성 규약(change-propagation)에 따라, 모델 선택기/effort 인코딩을 다루는 문서가 있으면 `@advisor` 접미사 문법을 한 줄 반영. (예: `docs/session-lifecycle.md` 또는 `docs/architecture.md`의 Penta Runtime/effort 설명.) 해당 문서 Read 후 필요한 곳만 추가.

- [ ] **Step 4: 최종 커밋 (문서 변경이 있을 때만)**

```bash
git add docs/
git commit -m "docs: note @advisor model-string suffix for advisor presets"
```
