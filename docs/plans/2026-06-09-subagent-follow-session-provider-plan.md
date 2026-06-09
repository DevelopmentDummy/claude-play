# 서브에이전트가 세션 provider를 따라가게 (v2) — 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션을 어떤 provider로 열든 그 세션의 서브에이전트도 같은 provider·모델·effort로 돌게 만들어, 비용/인증을 한 provider로 일원화한다 (Claude 폴백 없음).

**Architecture:** 서브 provider/model/effort를 매니페스트가 아니라 **세션 open 시점**에 세션 값에서 파생한다. role은 시스템 프롬프트가 아니라 **서브 대화의 첫 메시지(leading-message)**로 주입해 5개 provider를 단일 경로로 처리한다. 서브는 세션 디렉토리를 cwd로 공유(MCP 신원 유지)하되, provider별 로그 경로를 `logName`으로 분리해 같은 provider 메인+서브의 로그 충돌을 막는다.

**Tech Stack:** TypeScript(strict) + Next.js 15 custom server. 자동 테스트 없음 → 각 태스크는 `npx tsc --noEmit` 그린으로 검증, `.mjs`는 `node --check`, 최종은 라이브 스모크.

**선행 문서:** [v2 설계](../specs/2026-06-09-subagent-follow-session-provider-design.md)

---

## 파일 구조 (변경 단위)

| 파일 | 책임 | 태스크 |
|---|---|---|
| `src/lib/codex-process.ts` | Codex 프로세스 — 로그 경로 `logName` 반영 | 1 |
| `src/lib/gemini-process.ts` | Gemini 프로세스 — 로그 경로 `logName` 반영 | 1 |
| `src/lib/kimi-process.ts` | Kimi 프로세스 — 로그 경로 `logName` 반영 | 1 |
| `src/lib/antigravity-process.ts` | Antigravity 프로세스 — 로그 경로 `logName` 반영 | 1 |
| `src/lib/subagent-instance.ts` | role을 leading-message로; 세션 provider/model/effort 사용 | 2, 3 |
| `src/lib/subagent-manager.ts` | `spawnAll`에 세션 provider/model/effort 전달; provider 변경 시 재spawn | 3 |
| `src/app/api/sessions/[id]/open/route.ts` | `spawnAll`에 세션 값 전달 | 3 |
| `src/lib/subagent-manifest.ts` | `PROVIDERS` 게이트 제거; 매니페스트 provider/model 무시 | 4 |
| `src/mcp/claude-play-mcp-server.mjs` | `bridge_define_subagent`에서 provider/model 제거 | 5 |
| `builder-prompt.md` | `## 서브에이전트` 섹션 정정 | 6 |
| `docs/session-lifecycle.md` | v2 동작/한계 갱신 | 7 |

---

## Task 1: provider별 로그 경로를 `logName`으로 분리

**배경:** v1에서 Claude `spawn`에 7번째 인자 `logName`을 추가해 서브가 `subagents/<name>/sub.log`에 쓰게 했지만, Codex/Gemini/Kimi/Antigravity는 `logName`을 무시하고 cwd에 `*-stream.log`를 하드코딩한다. 같은 provider의 메인+서브가 같은 로그 파일에 동시 append하면 인터리브된다. 이 태스크는 4개 provider가 `logName`을 존중하게 한다 (기본값 유지 → 메인 동작 불변, behavior-preserving).

**공통 패턴 (4개 provider 동일):**
1. 클래스에 `private logName = "<provider>-stream.log";` 필드 추가.
2. `spawn` 시그니처의 미사용 `_logName?: string` → `logName?: string`.
3. 로그 스트림 열기 직전 `if (logName) this.logName = logName;` (인자 없으면 직전 값 유지 → `respawn()`이 기본값으로 되돌아가지 않음).
4. 로그 경로를 `path.join(cwd, this.logName)`으로.

**Files:**
- Modify: `src/lib/codex-process.ts:26,103,121`
- Modify: `src/lib/gemini-process.ts:110-118,135`
- Modify: `src/lib/kimi-process.ts:84-92,107`
- Modify: `src/lib/antigravity-process.ts:38,54-62,74,887`

- [ ] **Step 1: Codex — 필드 + 시그니처 + 경로**

`src/lib/codex-process.ts` line 26 근처(`private logStream` 아래)에 추가:

```typescript
  private logName = "codex-stream.log";
```

line 103 시그니처 변경 (`_logName?: string` → `logName?: string`):

```typescript
  spawn(cwd: string, resumeId?: string, model?: string, _appendSystemPrompt?: string, effort?: string, _skipPermissions?: boolean, logName?: string): void {
```

line 120-121 변경:

```typescript
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    if (logName) this.logName = logName;
    const logPath = path.join(cwd, this.logName);
```

- [ ] **Step 2: Gemini — 필드 + 시그니처 + 경로**

`src/lib/gemini-process.ts`에 필드 추가 (다른 `private` 필드 옆):

```typescript
  private logName = "gemini-stream.log";
```

line 110-118 시그니처에서 `_logName?: string,` → `logName?: string,`. line 134-135 변경:

```typescript
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    if (logName) this.logName = logName;
    const logPath = path.join(cwd, this.logName);
```

- [ ] **Step 3: Kimi — 필드 + 시그니처 + 경로**

`src/lib/kimi-process.ts`에 필드 추가:

```typescript
  private logName = "kimi-stream.log";
```

line 84-92 시그니처에서 `_logName?: string,` → `logName?: string,`. line 106-107 변경:

```typescript
    if (this.logStream) { try { this.logStream.end(); } catch { /* */ } }
    if (logName) this.logName = logName;
    const logPath = path.join(cwd, this.logName);
```

- [ ] **Step 4: Antigravity — 필드 + 시그니처 + openLogStream**

`src/lib/antigravity-process.ts` line 38(`private logStream` 아래)에 추가:

```typescript
  private logName = "antigravity-stream.log";
```

line 54-62 시그니처에서 `_logName?: string,` → `logName?: string,`. line 74 직전에 한 줄 추가:

```typescript
    if (logName) this.logName = logName;
    this.openLogStream(cwd);
```

line 887 (`openLogStream` 내부) 변경:

```typescript
    const logPath = path.join(cwd, this.logName);
```

- [ ] **Step 5: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (exit 0). `_logName` 미사용 경고가 있었다면 사라짐.

- [ ] **Step 6: Commit**

```bash
git add src/lib/codex-process.ts src/lib/gemini-process.ts src/lib/kimi-process.ts src/lib/antigravity-process.ts
git commit -m "feat(subagents): honor logName in codex/gemini/kimi/antigravity spawn"
```

---

## Task 2: 서브 role을 leading-message로 전달

**배경:** 서브는 현재 role을 `appendSystemPrompt` spawn 인자로 받는데, 그 인자를 적용하는 건 `ClaudeProcess`뿐이다. 5개 provider 균일 처리를 위해 role 계약을 **첫 디스패치 메시지에 prepend**한다. 이 태스크는 provider는 아직 `def.provider`(=claude) 그대로 두고 전달 메커니즘만 바꾼다 → Claude 서브는 계속 동작(role을 시스템 프롬프트 대신 첫 메시지로 받음).

**resume 처리:** 이전 세션을 resume하면 role은 이미 직전 대화 히스토리에 있으므로 재주입하지 않는다 → `start()`에서 resumeId가 있으면 `primed=true`.

**Files:**
- Modify: `src/lib/subagent-instance.ts`

- [ ] **Step 1: `primed` 필드 추가**

`src/lib/subagent-instance.ts` line 40 근처(`private pid` 옆)에 추가:

```typescript
  private primed = false;
```

- [ ] **Step 2: `start()` — appendSystemPrompt 제거 + resume 시 primed**

[subagent-instance.ts:88-105](../../src/lib/subagent-instance.ts) 영역을 다음으로 교체. `systemPrompt` 변수와 spawn의 4번째 인자(appendSystemPrompt)를 제거하고, resume일 때 primed를 세운다:

```typescript
    // Resume previous provider session id when available (intra-session continuity across restart).
    try {
      if (!this.resumeId && fs.existsSync(this.resumePath())) {
        this.resumeId = fs.readFileSync(this.resumePath(), "utf-8").trim() || null;
      }
    } catch { /* ignore */ }
    // A resumed conversation already contains the role leading-message from its first turn,
    // so don't re-inject it. A fresh spawn primes on first dispatch (see dispatch()).
    if (this.resumeId) this.primed = true;
    // Role is delivered as a leading message on first dispatch — NOT as the appendSystemPrompt
    // spawn arg (only ClaudeProcess applied that; leading-message is provider-uniform).
    // spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions, logName)
    this._process.spawn(
      this.sessionDir,
      this.resumeId ?? undefined,
      this.def.model,
      undefined,
      this.def.effort,
      true,
      path.join("subagents", this.name, "sub.log"),
    );
```

- [ ] **Step 3: `dispatch()` — 첫 메시지에 role prepend**

[subagent-instance.ts:116-124](../../src/lib/subagent-instance.ts) `dispatch` 메서드를 교체:

```typescript
  /** Dispatch a task to the sub. Spawns lazily if not yet running. Async-safe fire-and-forget.
   *  On the first dispatch of a fresh conversation, the role contract is prepended as a
   *  leading message (provider-uniform role delivery). */
  dispatch(task: string): void {
    if (this.destroyed) return;
    if (!this._process.isRunning()) this.start();
    if (!this._process.isRunning()) {
      console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch skipped — not running`);
      return;
    }
    let payload = task;
    if (!this.primed) {
      const role = buildSubSystemPrompt(this.def, this.readInstructions());
      payload = `${role}\n\n--- TASK ---\n${task}`;
      this.primed = true;
    }
    this._process.send(payload);
  }
```

- [ ] **Step 4: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 에러 없음. `buildSubSystemPrompt`는 같은 파일 상단에 이미 정의돼 있으므로 import 추가 불필요.

- [ ] **Step 5: Commit**

```bash
git add src/lib/subagent-instance.ts
git commit -m "feat(subagents): deliver role as leading-message (provider-uniform)"
```

---

## Task 3: 서브 provider/model/effort를 세션에서 파생

**배경:** 서브는 세션을 연 provider·모델·effort로 돌아야 한다. open route는 `spawnAll`을 부르는 지점에서 이미 `provider`/`effectiveModel`/`finalEffort`를 갖고 있으므로 그대로 전달한다. `SubAgentInstance`는 `def.provider` 대신 세션 provider로 프로세스를 만들고, 세션 model/effort로 spawn한다. 재오픈 시 세션 provider/model이 바뀌면 캐시된 서브를 재생성한다.

**Files:**
- Modify: `src/lib/subagent-instance.ts`
- Modify: `src/lib/subagent-manager.ts`
- Modify: `src/app/api/sessions/[id]/open/route.ts`

- [ ] **Step 1: `SubAgentInstance` 생성자에 세션 런타임 인자 추가**

`src/lib/subagent-instance.ts` 상단 import에 `AIProvider`를 추가:

```typescript
import { AIProvider } from "./ai-provider";
```

[subagent-instance.ts:32-61](../../src/lib/subagent-instance.ts) 필드와 생성자를 교체. 세션 런타임 값을 보관하고, 프로세스 생성에 세션 provider를 사용:

```typescript
export class SubAgentInstance {
  readonly name: string;
  readonly def: SubAgentDef;
  readonly provider: AIProvider;
  readonly model?: string;
  readonly effort?: string;
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private _process: AIProcess;
  private resumeId: string | null = null;
  private destroyed = false;
  private pid: number | null = null;
  private primed = false;

  constructor(
    def: SubAgentDef,
    sessionDir: string,
    sessionId: string,
    provider: AIProvider,
    model?: string,
    effort?: string,
  ) {
    this.def = def;
    this.name = def.name;
    this.sessionDir = sessionDir;
    this.sessionId = sessionId;
    this.provider = provider;
    this.model = model;
    this.effort = effort;
    this._process = createProcess(provider);
    // Prevent unhandledRejection crashes if initialize/emit fires after destroy.
    this._process.on("error", (e: unknown) => {
      console.error(`[subagent:${sessionId}/${this.name}] process error:`, e);
    });
    this._process.on("sessionId", (id: string) => {
      this.resumeId = id;
      try { fs.writeFileSync(this.resumePath(), id, "utf-8"); } catch { /* ignore */ }
    });
    this._process.on("exit", () => {
      if (this.pid) unregisterSubProc(this.pid);
    });
  }
```

> 참고: Step 1에서 `private primed = false;` 가 이 블록에 포함되므로 Task 2 Step 1에서 추가한 줄과 중복되지 않게 한 번만 둔다.

- [ ] **Step 2: `start()` — 세션 model/effort로 spawn**

Task 2 Step 2에서 만든 `spawn(...)` 호출의 model/effort 인자를 세션 값으로 바꾼다:

```typescript
    this._process.spawn(
      this.sessionDir,
      this.resumeId ?? undefined,
      this.model,
      undefined,
      this.effort,
      true,
      path.join("subagents", this.name, "sub.log"),
    );
```

또한 line 112 로그를 정확히 하기 위해 `provider=${this.def.provider}` → `provider=${this.provider}`로 바꾼다.

- [ ] **Step 3: `SubAgentManager.spawnAll`에 세션 런타임 인자 전달 + provider 변경 시 재생성**

`src/lib/subagent-manager.ts` 상단 import에 추가:

```typescript
import { AIProvider } from "./ai-provider";
```

[subagent-manager.ts:21-42](../../src/lib/subagent-manager.ts) `spawnAll`을 교체:

```typescript
  /** Read the manifest and spawn every declared sub-agent with the SESSION's
   *  provider/model/effort (subs follow the session, not the manifest). Safe to call
   *  again (re-open): already-running subs with the same runtime are left as-is; if the
   *  session provider/model/effort changed, the cached sub is destroyed and recreated.
   *  Manifest errors are logged, never thrown into the open flow. */
  spawnAll(provider: AIProvider, model?: string, effort?: string): void {
    const dir = this.getDir();
    if (!dir) return;
    let defs: SubAgentDef[] = [];
    try {
      defs = loadSubAgentManifest(dir).subagents;
    } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] manifest invalid:`, (err as Error).message);
      return;
    }
    for (const def of defs) {
      this.defs.set(def.name, def);
      let inst = this.subs.get(def.name);
      if (inst && (inst.provider !== provider || inst.model !== model || inst.effort !== effort)) {
        try { inst.destroy(); } catch { /* ignore */ }
        this.subs.delete(def.name);
        inst = undefined;
      }
      if (!inst) {
        inst = new SubAgentInstance(def, dir, this.sessionId, provider, model, effort);
        this.subs.set(def.name, inst);
      }
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${def.name} failed:`, err);
      }
    }
  }
```

- [ ] **Step 4: open route — 세션 값 전달**

`src/app/api/sessions/[id]/open/route.ts:123` 의 `spawnAll()` 호출을 교체. `provider`/`effectiveModel`/`finalEffort`는 같은 함수 line 33-35에서 이미 계산돼 스코프에 있다:

```typescript
    try { instance.subAgents.spawnAll(provider, effectiveModel || undefined, finalEffort); }
```

- [ ] **Step 5: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 에러 없음. `SubAgentInstance` 생성자 호출이 manager 한 곳뿐이고 새 시그니처와 일치.

- [ ] **Step 6: Commit**

```bash
git add src/lib/subagent-instance.ts src/lib/subagent-manager.ts "src/app/api/sessions/[id]/open/route.ts"
git commit -m "feat(subagents): derive sub provider/model/effort from the session"
```

---

## Task 4: 매니페스트 provider 게이트 제거

**배경:** 서브 provider가 세션에서 파생되므로(Task 3), 매니페스트의 `PROVIDERS = ["claude"]` 검증 게이트는 불필요하고, 비-Claude provider를 적은 매니페스트를 거부하면 안 된다. `provider`/`model`/`effort` 필드는 하위호환을 위해 파싱은 유지하되 런타임에서 무시된다(SubAgentInstance가 세션 값을 씀).

**Files:**
- Modify: `src/lib/subagent-manifest.ts:10-18,69-70`

- [ ] **Step 1: `PROVIDERS` 상수/주석 제거**

[subagent-manifest.ts:10-18](../../src/lib/subagent-manifest.ts) 의 주석과 `const PROVIDERS` 선언을 통째로 삭제하고, 한 줄 주석으로 대체:

```typescript
// v2: a sub follows the SESSION's provider/model/effort (resolved at spawn time in
// SubAgentManager.spawnAll). The manifest's provider/model/effort are parsed for backward
// compat but ignored at runtime.
```

- [ ] **Step 2: provider 검증 throw 제거**

[subagent-manifest.ts:69-70](../../src/lib/subagent-manifest.ts) 의 두 줄을 교체. 검증 throw를 없애고 파싱만 유지:

```typescript
    const provider = String(e.provider ?? "claude") as AIProvider; // parsed for back-compat; ignored at runtime
```

- [ ] **Step 3: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 에러 없음. `AIProvider` import는 이미 line 3에 있고, `MAX_SUBAGENTS`는 그대로.

- [ ] **Step 4: Commit**

```bash
git add src/lib/subagent-manifest.ts
git commit -m "feat(subagents): drop claude-only manifest gate (provider follows session)"
```

---

## Task 5: `bridge_define_subagent`에서 provider/model 제거

**배경:** 빌더가 서브를 정의할 때 provider/model을 지정할 여지가 없다(세션 값을 따름). 하드코딩된 `provider:"claude"`와 `model` 입력 필드를 제거하고 description을 정정한다. `.mjs` 파일이라 `tsc` 대신 `node --check`로 검증한다.

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs:1506-1521,1532-1542`

- [ ] **Step 1: description 정정**

[claude-play-mcp-server.mjs:1506-1511](../../src/mcp/claude-play-mcp-server.mjs) 의 description 문자열에서 "v1: Claude provider only — pick a cheap model like claude-haiku-4-5 for low-cost specialized subs." 를 다음으로 교체:

```javascript
      "Sub-agents run always-on alongside the main narrator at session time and handle delegated bookkeeping " +
      "(panel variable updates, flow control, lore consistency). A sub automatically runs on the SAME provider " +
      "and model as the session it belongs to — you do not choose a provider or model here.",
```

- [ ] **Step 2: `model` 입력 필드 제거**

[claude-play-mcp-server.mjs:1515](../../src/mcp/claude-play-mcp-server.mjs) 의 `model: z.string().optional()...` 줄을 통째로 삭제한다.

- [ ] **Step 3: entry에서 provider/model 제거**

[claude-play-mcp-server.mjs:1532-1542](../../src/mcp/claude-play-mcp-server.mjs) 의 `entry` 객체에서 `provider: "claude",` 줄과 `...(input.model ? { model: input.model } : {}),` 줄을 삭제. 결과:

```javascript
      const entry = {
        name: input.name,
        role: input.role,
        instructions: "instructions.md",
        delegable: input.delegable !== false,
        autoTrigger: input.autoTrigger || "none",
        ...(input.autoTriggerTask ? { autoTriggerTask: input.autoTriggerTask } : {}),
        emitSummary: input.emitSummary !== false,
      };
```

- [ ] **Step 4: 구문 검사**

Run: `node --check src/mcp/claude-play-mcp-server.mjs`
Expected: 출력 없음 (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat(subagents): bridge_define_subagent drops provider/model (follows session)"
```

---

## Task 6: 빌더 프롬프트 `## 서브에이전트` 섹션 정정

**배경:** 빌더 AI가 서브를 "Claude 전용 / claude-haiku 권장"으로 안내받으면 안 된다. 서브가 세션 provider/모델을 자동 상속한다는 사실로 교체한다.

**Files:**
- Modify: `builder-prompt.md:1346,1374-1375,1310`

- [ ] **Step 1: `model` 인자 설명 줄 교체**

`builder-prompt.md:1346` 의 `model` 불릿을 다음으로 교체:

```markdown
- **provider·모델은 지정하지 않는다** — 서브는 세션을 연 provider/모델/effort를 자동으로 따라간다 (비용/인증이 세션과 일원화됨). 빌더는 `role`·`instructions`·`autoTrigger`만 정한다.
```

- [ ] **Step 2: 예시 jsonc에서 provider/model 제거**

`builder-prompt.md:1374-1375` 의 `"provider": "claude",` 와 `"model": "claude-haiku-4-5",` 두 줄을 삭제. 결과 예시:

```jsonc
// bridge_define_subagent 호출로 생성되는 subagents.json 항목
{
  "name": "combat-keeper",
  "role": "전투 상태/HP/적 행동 변수 관리",
  "instructions": "instructions.md",
  "delegable": true,
  "autoTrigger": "onAssistantTurn",
```

- [ ] **Step 3: 체크리스트 항목 확인**

`builder-prompt.md:1310-1314` 의 서브에이전트 체크리스트는 provider 언급이 없으므로 그대로 둔다. (변경 없음 — 확인만.)

- [ ] **Step 4: Commit**

```bash
git add builder-prompt.md
git commit -m "docs(subagents): builder prompt — subs follow session provider/model"
```

---

## Task 7: `docs/session-lifecycle.md` v2 갱신

**배경:** 구조 문서에 v1의 "서브 Claude 전용" 한계가 남아 있다. v2 동작과 잔여 한계로 갱신한다.

**Files:**
- Modify: `docs/session-lifecycle.md` (서브에이전트 섹션)

- [ ] **Step 1: 서브에이전트 섹션 찾기**

Run: `grep -n "Claude" docs/session-lifecycle.md`
서브에이전트 관련 "Claude 전용/Claude provider only" 문장 위치를 찾는다.

- [ ] **Step 2: v2 동작으로 교체**

해당 섹션의 provider 제약 문장을 다음 내용으로 교체(문맥에 맞게 한 단락):

```markdown
서브에이전트는 **세션을 연 provider·모델·effort를 그대로 따라간다** (세션 open 시 `SubAgentManager.spawnAll(provider, model, effort)`에서 파생). role은 시스템 프롬프트가 아니라 서브 대화의 첫 메시지(leading-message)로 주입되어 5개 provider가 단일 경로로 처리된다. 서브는 세션 디렉토리를 cwd로 공유하므로 MCP 설정을 자동 상속하고, 로그만 `subagents/<name>/sub.log`로 분리된다.

**v2 잔여 한계:** ⓐ leading-message는 시스템 프롬프트보다 role 고정력이 약하다(긴 세션 compaction 시 희석 가능 — 주기적 재주입은 후속). ⓑ 서브가 공유 cwd에서 메인 나레이터 instruction 파일을 base context로 상속한다(role 계약이 가드 — v1과 동일). ⓒ 비-Claude 서브의 cmdline-dir 기반 orphan reap은 동작하지 않을 수 있다(정상 PID 등록/해제 경로는 OK; Antigravity는 `agy-procs.json`+`killAgyForDir`가 dir 단위로 커버).
```

- [ ] **Step 3: Commit**

```bash
git add docs/session-lifecycle.md
git commit -m "docs(subagents): session-lifecycle v2 — subs follow session provider"
```

---

## Task 8: 라이브 스모크 검증 (사용자 수동 실행)

**배경:** 자동 테스트가 없고 단일 사용자 라이브 서비스이므로, 실제 동작 확인은 사용자가 dev 서버에서 수동으로 한다. AI가 자율 실행하지 않는다.

- [ ] **Step 1: 타입 그린 최종 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 2: 서브 1개 페르소나로 provider별 스모크**

각 provider(claude / codex / gemini / kimi / antigravity) 모델로 세션을 생성·Open(기존 라이브 세션은 닫았다 재오픈)하고 확인:
- 서브 프로세스가 세션과 **같은 provider**로 spawn되는지 (`subagents/<name>/sub.log` 생성 + provider별 CLI 흔적 확인, 콘솔 `[subagent:...] started ... provider=<P>` 로그).
- 메인 1턴 후 autoTrigger로 서브가 dispatch되고, 첫 디스패치 페이로드에 role 계약이 prepend됐는지 (`sub.log`).
- 서브가 MCP로 variables를 변경하고 `[SUB:<name>]` 요약이 다음 유저 턴 머리에 합류하는지.
- 같은 provider 메인+서브에서 메인 로그(`<provider>-stream.log`)와 서브 로그(`subagents/<name>/sub.log`)가 **분리**되어 인터리브가 없는지.

- [ ] **Step 3: 결과 기록**

스모크 결과(통과/이슈)를 메모리 [[subagent-orchestration-design]]에 갱신하고, 통과 시 v1+v2를 함께 main 머지 여부를 사용자와 결정.

---

## Self-Review 결과

- **Spec coverage:** §3.1(provider/model 파생)=Task 3·4·5, §3.2(leading-message)=Task 2, §3.3(로그 분리)=Task 1·(MCP/resume는 변경 불필요), §3.4(reap)=문서화(Task 7 ⓒ), §5(검증)=Task 8, 빌더/문서=Task 6·7. 모든 섹션에 대응 태스크 존재.
- **Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 실제 코드 포함.
- **Type consistency:** `spawnAll(provider, model?, effort?)`(Task 3 Step 3)와 open route 호출(Step 4) 일치. `SubAgentInstance` 생성자 6-인자(Step 1)와 manager의 `new SubAgentInstance(def, dir, this.sessionId, provider, model, effort)` 일치. `readonly provider/model/effort` getter(Step 1)와 spawnAll의 `inst.provider/model/effort` 비교(Step 3) 일치. `logName?` 시그니처(Task 1)와 SubAgentInstance가 넘기는 `path.join("subagents", name, "sub.log")`(Task 2) 일치.
- **중복 주의:** `private primed = false;` 는 Task 2 Step 1과 Task 3 Step 1에 모두 등장 — Task 3 Step 1의 생성자 블록 교체 시 한 번만 남도록 명시함.
