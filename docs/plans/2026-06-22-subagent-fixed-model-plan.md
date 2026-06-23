# 서브에이전트 고정 모델/프로바이더 (v2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빌더가 서브에이전트별로 모델/프로바이더를 고정 지정할 수 있게 하고(미지정 시 세션 상속), provider는 model id에서 도출한다.

**Architecture:** 매니페스트는 단일 `model` 문자열을 1차 소스로 한다. `bridge_define_subagent` MCP(`.mjs`)는 문자열을 그대로 저장하고, 분해(`providerFromModel`/`parseModelEffort` → 분리 필드 `providerExplicit`/`model`/`effort`)는 `validateManifest`(.ts)가 수행한다. `spawnAll`이 def별로 resolve해 인스턴스를 띄운다. 인스턴스/spawn 인프라(`subagent-instance.ts`, 5개 provider 프로세스, open route)는 무변경.

**Tech Stack:** TypeScript(strict), Next.js 15 custom server, `@modelcontextprotocol/sdk`(MCP, ESM `.mjs`), Handlebars 패널.

## Global Constraints

- 검증은 `npx tsc --noEmit` 그린으로 한다. `npm run build` / `next build`는 **금지**(라이브 `.next` 손상 위험).
- MCP 서버 `src/mcp/claude-play-mcp-server.mjs`는 `.mjs`라 `.ts` 모듈을 import할 수 없다 — `providerFromModel`/`parseModelEffort` 로직을 **MCP에 복제하지 않는다**.
- **미지정(`model` 없는) 서브의 동작은 v2와 동일하게 보존**한다(behavior-preserving). 폴백 시 provider/model/effort는 세션 값.
- 프로젝트 경로에 공백이 있다("c:\repository\claude bridge") — 셸 명령에서 따옴표 처리.
- 작업 브랜치는 `feat/subagent-fixed-model`(이미 생성, 스펙 커밋 `c3a976d` 포함). 모든 커밋은 이 브랜치에.
- 세션 시작 시점에 `subagent-manifest.ts`·`subagent-manager.ts`에 이 기능의 lib 절반이 **미커밋 상태로 존재**한다. Task 1·2가 이를 이어받아 완성한다. `package.json`의 typescript 5.8.2 다운그레이드는 본 기능과 무관 — **건드리지 않는다**.
- 커밋 메시지 말미에: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: `validateManifest` — 단일 `model`에서 분리 필드 도출

**Files:**
- Modify: `src/lib/subagent-manifest.ts` (import 1줄 + `validateManifest` map 콜백 내부)
- Test(임시): `tmp-verify-manifest.ts` (리포 루트, 검증 후 삭제)

**Interfaces:**
- Consumes: `providerFromModel(model: string): AIProvider`, `parseModelEffort(value: string): { model: string; effort: string | undefined }` (둘 다 `src/lib/ai-provider.ts`)
- Produces: `validateManifest(raw: unknown): SubAgentManifest` — 각 `SubAgentDef`의 `providerExplicit?: AIProvider`(매니페스트가 provider를 명시했거나 model에서 도출됐을 때만 set; 미지정/도출실패 시 `undefined`), `model?: string`(effort suffix 제거된 base), `effort?: string`(명시 effort 또는 model suffix)을 채운다.

- [ ] **Step 1: 임시 검증 스크립트 작성 (실패 확인용)**

리포 루트에 `tmp-verify-manifest.ts` 생성:

```ts
import { validateManifest } from "./src/lib/subagent-manifest";

let failed = 0;
function check(label: string, cond: boolean) {
  console.log((cond ? "PASS" : "FAIL") + " — " + label);
  if (!cond) failed++;
}
function def(extra: Record<string, unknown>) {
  return validateManifest({ version: 1, subagents: [{ name: "s", role: "r", ...extra }] }).subagents[0];
}

// 1) model 미지정 → 세션 폴백용으로 분리 필드 전부 undefined, provider는 back-compat 기본 claude
const a = def({});
check("unset → providerExplicit undefined", a.providerExplicit === undefined);
check("unset → model undefined", a.model === undefined);
check("unset → effort undefined", a.effort === undefined);
check("unset → provider default claude", a.provider === "claude");

// 2) codex model + effort suffix
const b = def({ model: "gpt-5.4:high" });
check("gpt-5.4:high → providerExplicit codex", b.providerExplicit === "codex");
check("gpt-5.4:high → model gpt-5.4", b.model === "gpt-5.4");
check("gpt-5.4:high → effort high", b.effort === "high");

// 3) antigravity model, suffix 없음 → effort undefined (gemini는 env 의존이라 antigravity로 검증)
const c = def({ model: "antigravity-flash" });
check("antigravity → providerExplicit antigravity", c.providerExplicit === "antigravity");
check("antigravity → effort undefined", c.effort === undefined);

// 4) 명시 provider/effort가 도출보다 우선 (legacy/수동 편집)
const d = def({ model: "opus[1m]", provider: "kimi", effort: "medium" });
check("explicit provider wins → kimi", d.providerExplicit === "kimi");
check("explicit effort wins → medium", d.effort === "medium");
check("model base preserved → opus[1m]", d.model === "opus[1m]");

// 5) 무효/오타 id → providerFromModel이 claude 반환(강검증 안 함)
const e = def({ model: "totally-bogus-model" });
check("bogus → providerExplicit claude", e.providerExplicit === "claude");
check("bogus → model preserved", e.model === "totally-bogus-model");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
```

- [ ] **Step 2: 실패 확인 — 현재 구현은 단일 model을 분해하지 않음**

Run: `cd "c:/repository/claude bridge" && npx tsx tmp-verify-manifest.ts`
Expected: FAIL 다수 — 현재 `validateManifest`는 `e.model`을 그대로 `model`에 넣고 `providerFromModel` 도출을 안 하므로, case 2가 `model === "gpt-5.4:high"`(suffix 미제거)·`providerExplicit === undefined`로 FAIL.

- [ ] **Step 3: import에 도출 함수 추가**

`src/lib/subagent-manifest.ts` 상단 import 교체:

```ts
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";
```

(기존: `import { AIProvider } from "./ai-provider";`)

- [ ] **Step 4: `validateManifest` map 콜백에서 단일 model 도출로 교체**

`validateManifest` 내부, `seen.add(name);` 다음의 provider/effort 계산 블록을 아래로 교체한다. 교체 대상은 현재 다음 블록:

```ts
    const providerExplicit = typeof e.provider === "string" && e.provider.trim()
      ? (e.provider.trim() as AIProvider) : undefined;        // honored per-sub when present
    const provider = providerExplicit ?? ("claude" as AIProvider); // default-filled for back-compat
    const autoTrigger = e.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none";
    return {
      name,
      role: String(e.role ?? ""),
      provider,
      providerExplicit,
      model: typeof e.model === "string" ? e.model : undefined,
      effort: typeof e.effort === "string" ? e.effort : undefined,
      instructions: typeof e.instructions === "string" && e.instructions.trim()
        ? e.instructions : "instructions.md",
      delegable: e.delegable !== false,
      autoTrigger,
      autoTriggerTask: typeof e.autoTriggerTask === "string" ? e.autoTriggerTask : undefined,
      emitSummary: e.emitSummary !== false,
      writes: Array.isArray(e.writes) ? e.writes.filter((w): w is string => typeof w === "string") : undefined,
    };
```

교체 후:

```ts
    // Single `model` string is the primary source: split any effort suffix
    // (parseModelEffort) and infer the provider (providerFromModel). A manifest MAY still
    // specify `provider`/`effort` explicitly (legacy / hand-edit) — those take precedence.
    const rawModel = typeof e.model === "string" && e.model.trim() ? e.model.trim() : undefined;
    const { model: baseModel, effort: suffixEffort }: { model: string | undefined; effort: string | undefined } =
      rawModel ? parseModelEffort(rawModel) : { model: undefined, effort: undefined };
    let providerExplicit: AIProvider | undefined;
    if (typeof e.provider === "string" && e.provider.trim()) {
      providerExplicit = e.provider.trim() as AIProvider;       // explicit override wins
    } else if (rawModel) {
      try { providerExplicit = providerFromModel(rawModel); }   // infer from model id
      catch { providerExplicit = undefined; }                   // e.g. gemini disabled → session fallback
    }
    const provider = providerExplicit ?? ("claude" as AIProvider); // default-filled for back-compat
    const effort = typeof e.effort === "string" && e.effort.trim()
      ? e.effort.trim()                                          // explicit effort wins
      : suffixEffort;                                            // else from model suffix
    const autoTrigger = e.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none";
    return {
      name,
      role: String(e.role ?? ""),
      provider,
      providerExplicit,
      model: baseModel || undefined,
      effort,
      instructions: typeof e.instructions === "string" && e.instructions.trim()
        ? e.instructions : "instructions.md",
      delegable: e.delegable !== false,
      autoTrigger,
      autoTriggerTask: typeof e.autoTriggerTask === "string" ? e.autoTriggerTask : undefined,
      emitSummary: e.emitSummary !== false,
      writes: Array.isArray(e.writes) ? e.writes.filter((w): w is string => typeof w === "string") : undefined,
    };
```

- [ ] **Step 5: 헤더 주석 갱신 (정확성 유지)**

`src/lib/subagent-manifest.ts`의 `NAME_RE` 아래 주석(현재 "v2.1: ... `provider` is always default-filled ...")을 아래로 교체:

```ts
// v2.1: by default a sub follows the SESSION's provider/model/effort (resolved at spawn time
// in SubAgentManager.spawnAll). A sub MAY pin itself by setting `model` (a single id, optionally
// with an effort suffix like "gpt-5.4:high"); validateManifest derives provider via
// providerFromModel and splits the effort via parseModelEffort into the per-sub fields below.
// An explicit `provider`/`effort` in the manifest (hand-edit) still takes precedence over derivation.
// `provider` is always default-filled ("claude"); use `providerExplicit` to detect a real override.
```

- [ ] **Step 6: 검증 스크립트 통과 확인**

Run: `cd "c:/repository/claude bridge" && npx tsx tmp-verify-manifest.ts`
Expected: `ALL PASS` (모든 check PASS, exit 0)

- [ ] **Step 7: 타입 체크**

Run: `cd "c:/repository/claude bridge" && npx tsc --noEmit`
Expected: 에러 없이 종료(exit 0)

- [ ] **Step 8: 임시 스크립트 삭제 후 커밋**

```bash
cd "c:/repository/claude bridge"
rm tmp-verify-manifest.ts
git add src/lib/subagent-manifest.ts
git commit -m "feat(subagent): derive per-sub provider/model/effort from single model string

validateManifest now treats the manifest \`model\` field as the primary source:
splits the effort suffix (parseModelEffort) and infers provider (providerFromModel),
filling providerExplicit/model/effort. Explicit provider/effort still win. Provider
inference failure (e.g. gemini disabled) falls back to undefined → session value.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `spawnAll` — effort 폴백 3분기

**Files:**
- Modify: `src/lib/subagent-manager.ts` (`spawnAll` def 루프 내 `subEffort` 계산 1줄)

**Interfaces:**
- Consumes: `SubAgentDef.providerExplicit`/`model`/`effort` (Task 1 산출), `spawnAll(provider, model?, effort?)` 파라미터(= 세션 값)
- Produces: `new SubAgentInstance(def, dir, sessionId, subProvider, subModel, subEffort)` — resolve된 런타임으로 인스턴스 생성(시그니처 무변경)

- [ ] **Step 1: `subEffort` 폴백 규칙 교체**

`src/lib/subagent-manager.ts`의 `spawnAll` def 루프에서 현재 줄:

```ts
      const subEffort = def.effort ?? effort;
```

을 아래로 교체:

```ts
      // effort: explicit sub effort wins; else inherit the session effort ONLY when the sub
      // runs on the same provider as the session (a foreign provider's effort scale differs);
      // otherwise leave undefined so that provider's own default applies.
      const subEffort = def.effort ?? (subProvider === provider ? effort : undefined);
```

(`subProvider`/`subModel`은 바로 위에 이미 정의돼 있다 — 그 줄들은 그대로 둔다.)

- [ ] **Step 2: 타입 체크**

Run: `cd "c:/repository/claude bridge" && npx tsc --noEmit`
Expected: 에러 없이 종료(exit 0)

- [ ] **Step 3: 커밋**

```bash
cd "c:/repository/claude bridge"
git add src/lib/subagent-manager.ts
git commit -m "feat(subagent): inherit session effort only when sub shares the session provider

A pinned sub on a foreign provider gets undefined effort (provider default)
instead of the session's effort, whose scale may not apply across providers.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `bridge_define_subagent` MCP — `model` 파라미터

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs` (`bridge_define_subagent` description + inputSchema + entry 머지, ~1508–1541)

**Interfaces:**
- Consumes: 빌더가 전달하는 `input.model?: string`
- Produces: `subagents.json`의 해당 항목에 `model` 키(있을 때만). 분해는 하지 않음 — Task 1의 `validateManifest`가 읽을 때 도출.

- [ ] **Step 1: description 교체**

`server.registerTool("bridge_define_subagent", { description: ... })`의 description 문자열을 교체. 현재:

```js
    description:
      "[Builder mode] Define or update a specialized sub-agent for this persona. " +
      "Writes subagents.json (merging by name) and subagents/<name>/instructions.md in the persona dir. " +
      "Sub-agents run always-on alongside the main narrator at session time and handle delegated bookkeeping " +
      "(panel variable updates, flow control, lore consistency). A sub automatically runs on the SAME provider " +
      "and model/effort as the session it belongs to — you do not choose a provider or model here.",
```

교체 후:

```js
    description:
      "[Builder mode] Define or update a specialized sub-agent for this persona. " +
      "Writes subagents.json (merging by name) and subagents/<name>/instructions.md in the persona dir. " +
      "Sub-agents run always-on alongside the main narrator at session time and handle delegated bookkeeping " +
      "(panel variable updates, flow control, lore consistency). By default a sub follows the session's " +
      "provider/model/effort. Optionally pin it to a specific model with `model` (a single id like " +
      "'gemini-3-flash-preview' or 'gpt-5.4:high'); the provider is inferred from the id and that CLI must be " +
      "authenticated. Omit `model` to follow the session.",
```

- [ ] **Step 2: inputSchema에 `model` 추가**

`inputSchema: { ... }`의 `emitSummary` 항목 다음에 추가:

```js
      model: z.string().optional().describe("Optional: pin this sub to a model id (e.g. 'gemini-3-flash-preview', 'gpt-5.4:high', 'opus[1m]'). Provider is inferred from the id. Omit to follow the session's provider/model/effort."),
```

- [ ] **Step 3: entry 머지에 `model` 추가**

`const entry = { ... }`에서 `emitSummary: input.emitSummary !== false,` 다음 줄에 추가:

```js
        ...(input.model && input.model.trim() ? { model: input.model.trim() } : {}),
```

(미지정/공백이면 키를 넣지 않아 "세션 상속" 시맨틱을 유지한다.)

- [ ] **Step 4: 문법 검사**

Run: `cd "c:/repository/claude bridge" && node --check src/mcp/claude-play-mcp-server.mjs`
Expected: 출력 없이 exit 0 (문법 오류 없음)

- [ ] **Step 5: 커밋**

```bash
cd "c:/repository/claude bridge"
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat(subagent): accept optional model in bridge_define_subagent

Builder can now pin a sub to a specific model id (provider inferred downstream
by validateManifest). Omitting model keeps session inheritance. MCP stores the
raw string only — no provider/effort split here (.mjs cannot import ai-provider.ts).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 빌더 프롬프트 — 서브에이전트 모델 지정 안내

**Files:**
- Modify: `builder-prompt.md` (서브에이전트 섹션 ~1346, 인자 목록, 예시)

**Interfaces:** 없음(빌더 AI용 메타 프롬프트 문서).

- [ ] **Step 1: "provider·모델은 지정하지 않는다" 줄 교체**

`builder-prompt.md`에서 현재 줄(1346 부근):

```markdown
- **provider·모델은 지정하지 않는다** — 서브는 세션을 연 provider/모델/effort를 자동으로 따라간다 (비용/인증이 세션과 일원화됨). 나머지 인자(`role`·`instructions`·`delegable`·`autoTrigger`·`autoTriggerTask`·`emitSummary`)는 아래 목록대로 정한다.
```

을 아래로 교체:

```markdown
- **모델은 기본 미지정(세션 상속)이다** — 서브는 기본적으로 세션을 연 provider/모델/effort를 그대로 따라간다. 특정 서브에 다른 모델/프로바이더가 유리하면 `model` 인자에 **단일 id**를 지정한다(provider는 id에서 자동 판별). 예: 가볍고 빈번한 부기 → `gemini-3-flash-preview`·`gpt-5.4`; 무거운 일관성 분석 → `gpt-5.4:high`·`opus[1m]:high`. ⚠️ 지정한 provider의 CLI가 **인증돼 있어야** 한다(미인증이면 그 서브만 spawn 실패, 메인엔 영향 없음). ⚠️ `antigravity-*`는 spawn이 무겁고 도구 호출 안정성이 낮으니 꼭 필요할 때만. 유효 id 예시: Claude `opus[1m]`·`sonnet`, Codex `gpt-5.4`·`gpt-5.5`, Gemini `gemini-3-flash-preview`·`gemini-3.1-pro-preview`, Kimi `kimi-auto`, Antigravity `antigravity-flash`. 나머지 인자(`role`·`instructions`·`delegable`·`autoTrigger`·`autoTriggerTask`·`emitSummary`)는 아래 목록대로 정한다.
```

- [ ] **Step 2: 인자 목록에 `model?` 추가**

같은 섹션의 인자 목록에서 `emitSummary` 항목 줄 다음에 추가:

```markdown
- `model`(선택): 이 서브를 특정 모델에 고정하는 단일 id (예: `gemini-3-flash-preview`, `gpt-5.4:high`). provider는 id에서 도출. **생략하면 세션 상속**(권장 기본값).
```

- [ ] **Step 3: 예시 jsonc에 model 지정 변형 추가**

`### 예시`의 jsonc 블록(현재 `combat-keeper` 예시) 다음에 두 번째 예시 블록을 추가:

````markdown
```jsonc
// 다른 프로바이더로 고정한 서브 (문체 검토를 가벼운 Gemini로)
{
  "name": "style-checker",
  "role": "문체 드리프트 점검",
  "instructions": "instructions.md",
  "model": "gemini-3-flash-preview",   // provider는 id에서 gemini로 자동 판별; 생략 시 세션 상속
  "delegable": true,
  "autoTrigger": "none",
  "emitSummary": true
}
```
````

- [ ] **Step 4: 육안 검토 + 커밋**

`builder-prompt.md`를 열어 교체된 문장과 두 예시 블록이 올바른 위치에 있고 Handlebars 토큰(`{{`)을 새로 추가하지 않았는지 확인한다.

```bash
cd "c:/repository/claude bridge"
git add builder-prompt.md
git commit -m "docs(builder): document optional per-sub model pinning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `docs/session-lifecycle.md` — 서브 provider 서술 갱신

**Files:**
- Modify: `docs/session-lifecycle.md` (line 41, line 78)

**Interfaces:** 없음(구조 문서).

- [ ] **Step 1: spawn 상속 서술(41줄) 교체**

현재:

```markdown
- **v2: 서브는 세션을 연 provider·모델·effort를 자동 상속한다.** Open 라우트가 세션의 이미 결정된 값으로 `SubAgentManager.spawnAll(provider, model, effort)`를 호출.
```

교체 후:

```markdown
- **v2.1: 서브는 기본적으로 세션의 provider·모델·effort를 상속하되, 매니페스트 `model`로 개별 고정할 수 있다.** Open 라우트가 세션 값으로 `SubAgentManager.spawnAll(provider, model, effort)`를 호출하고, `spawnAll`이 def별로 resolve한다 — `model`이 지정된 서브는 그 id에서 provider를 도출(`providerFromModel`)하고 effort suffix를 분리(`parseModelEffort`); effort는 서브가 세션과 같은 provider일 때만 세션 값을 상속하고, 다른 provider면 그 provider 기본을 쓴다. `model` 미지정 서브는 세션 값을 그대로 따른다.
```

- [ ] **Step 2: "런타임에서 무시된다"(78줄) 교체**

현재:

```markdown
매니페스트의 `provider`/`model`/`effort` 필드는 하위 호환을 위해 파싱은 유지하되 런타임에서 무시된다 (v2부터 세션 값이 적용). `bridge_define_subagent` MCP 도구도 이 필드들을 더 이상 기록하지 않는다.
```

교체 후:

```markdown
매니페스트의 `model` 필드(effort suffix 포함 가능)는 해당 서브의 런타임 고정에 사용된다 — `validateManifest`가 `providerFromModel`/`parseModelEffort`로 `providerExplicit`/`model`/`effort` 분리 필드를 채운다. 매니페스트에 `provider`/`effort`를 직접 적으면(수동 편집) 도출보다 우선한다. `bridge_define_subagent` MCP 도구는 단일 `model` 문자열만 받아 기록하고(분해는 `validateManifest`가 수행), 미지정 시 세션 값을 상속한다.
```

- [ ] **Step 3: 육안 검토 + 커밋**

```bash
cd "c:/repository/claude bridge"
git add docs/session-lifecycle.md
git commit -m "docs(lifecycle): update sub-agent provider/model inheritance to v2.1

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 최종 검증 (전체 태스크 완료 후)

- [ ] `cd "c:/repository/claude bridge" && npx tsc --noEmit` → exit 0
- [ ] `node --check src/mcp/claude-play-mcp-server.mjs` → exit 0
- [ ] `git log --oneline feat/subagent-fixed-model` 에 스펙 + 5개 태스크 커밋 확인
- [ ] **라이브 스모크(사용자 몫, 인증된 provider로)** — 머지 전 권장:
  1. 서브 1개에 세션과 다른 provider model 지정(예: 세션 claude, 서브 `gpt-5.4`) → 세션 open → `data/sessions/{id}/subagents/{name}/sub.log`에 해당 provider 기동 + `.resume-codex` 생성 확인.
  2. `model` 미지정 서브 → 세션 provider 그대로 따라가는지 확인.
  3. 빌더로 `model` 재정의 → 세션 닫았다 다시 열어 갈아끼워지는지 확인.

---

## Self-Review

**1. Spec coverage:**
- 스펙 §1 데이터 모델(validateManifest 단일 model 도출) → Task 1 ✓
- 스펙 §2 spawnAll effort 폴백 3분기 → Task 2 ✓
- 스펙 §3 인스턴스 무변경 → 태스크 없음(의도적, "무변경") ✓
- 스펙 §4 MCP model 파라미터 → Task 3 ✓
- 스펙 §5 builder-prompt → Task 4 ✓
- 스펙 §6 docs/session-lifecycle → Task 5 ✓
- 폴백 시맨틱 테이블 → Task 1(도출)+Task 2(effort 분기)로 분담, 검증 스크립트 case 1~5가 도출 부분 커버 ✓

**2. Placeholder scan:** "TBD/TODO/적절히 처리" 없음. 모든 코드 스텝에 실제 코드/명령/기대출력 포함 ✓

**3. Type consistency:** `providerExplicit`/`model`/`effort` 명칭이 Task 1(생성)·Task 2(소비)에서 일치. `parseModelEffort` 반환 타입(`{ model: string; effort: string | undefined }`)과 destructure 타입 주석 일치. `spawnAll(provider, model?, effort?)` 시그니처 무변경, `SubAgentInstance` 생성자 인자 순서(provider, model, effort) 무변경 ✓

**검증 환경 주의:** 이 프로젝트는 테스트 프레임워크가 없어 Task 1만 순수 함수에 대한 임시 `tsx` 검증을 쓴다. Task 2(spawn 부수효과)·Task 3(MCP 런타임)·Task 4·5(문서)는 `tsc`/`node --check`/육안 + 사용자 라이브 스모크로 검증한다. 단위 테스트가 없는 만큼 최종 라이브 스모크가 실질 검증이다.
