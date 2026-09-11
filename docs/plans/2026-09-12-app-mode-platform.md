# 앱 모드 플랫폼 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채팅 중심 셸을 옵션으로 내리고, 전용 앱 UI + 자율 서브에이전트 스레드 루프가 메인 플레이가 되는 페르소나("앱")를 만들 수 있게 한다.

**Architecture:** 앱 슬롯(1회 마운트 shadow DOM)이 메인 영역을 차지하고, 페르소나가 작성한 월드 엔진(tool 모듈)이 규칙의 유일한 소유자다. 역할 템플릿에서 스폰된 스레드 N개가 각자 주기로 `observe → dispatch → submit`을 돌고, 세션 틱마다 `step()`이 한 번 배치 드레인한다. 메인 에이전트는 살아있되 자동 발화하지 않는다.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, 기존 세션 런타임(`session-instance`/`subagent-*`), 파일 기반 상태(`session-state.ts`).

**Spec:** [docs/specs/2026-09-12-app-mode-platform-design.md](../specs/2026-09-12-app-mode-platform-design.md)

## Global Constraints

- TypeScript strict. `any` 금지 (src는 explicit any 0개 상태를 유지).
- 한국어 주석·UI 문자열. 식별자·기술용어는 영어.
- `npm run typecheck`를 **모든 코드 변경 후** 실행. 커밋 전 `npm run verify`.
- `data/`는 라이브 유저 데이터 — 삭제·리셋 금지. tsconfig가 `data/`·`scratch/`를 제외하므로 거기에 `.ts`를 두지 말 것.
- 테스트는 `src/lib/*.test.ts` 패턴 + `npx tsx --test <file>`로 직접 실행 (테스트 프레임워크 없음).
- 기존 페르소나는 무영향이어야 한다 — `layout.app`이 없으면 모든 신규 분기가 꺼진다.
- 새 API 라우트를 만들지 않는다. `src/app/api/sessions/[id]/tools/[name]/route.ts`는 **무변경**.
- 커밋은 작게, 자주. 각 Task 끝에 커밋.
- `npm run build`는 프로덕션 서버가 `.next/`를 서빙 중이면 **실행 금지**.

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/lib/app-mode.ts` | `layout.json`의 `app`/`chat.mode` 읽기·정규화. 서버·클라 공용 순수 함수 | 신규 |
| `src/lib/world-engine.ts` | 엔진 액션 호출 래퍼 + 세션 뮤텍스. tool 라우트를 HTTP로 호출 | 신규 |
| `src/lib/thread-manifest.ts` | `subagents.json` v2 파싱 (roles/threads) + v1 승격 | 신규 |
| `src/lib/thread-registry.ts` | `threads.json` 영속화 (라이브 스레드 목록) | 신규 |
| `src/lib/thread-loop.ts` | 틱 스케줄링, 예산, 일시정지, 프리워밍 스왑, 메인 브리핑 | 신규 |
| `src/lib/subagent-manifest.ts` | v2 타입을 재-export, `SubAgentDef`에 `params`/`roleName` 추가 | 수정 |
| `src/lib/subagent-instance.ts` | `params` 주입, 역할 지침 경로 해석, 스레드 디렉토리 | 수정 |
| `src/lib/subagent-manager.ts` | 키를 `threadId`로, 동적 spawn/despawn | 수정 |
| `src/lib/session-instance.ts` | 루프 런타임 수명주기 배선 | 수정 |
| `src/lib/static-file.ts` | `STATIC_MIME`에 `.js`/`.html`/`.css` | 수정 |
| `src/lib/use-panel-bridge.ts` | `stateChanged` 브리지 이벤트 | 수정 |
| `src/hooks/useLayout.ts` | `LayoutConfig`에 `app`, `chat.mode` | 수정 |
| `src/components/AppSlot.tsx` | 1회 마운트 shadow DOM + ErrorBoundary | 신규 |
| `src/app/chat/[sessionId]/page.tsx` | 앱 모드 분기, 챗 강등 | 수정 |
| `src/components/StatusBar.tsx` | 일시정지/속도 컨트롤 | 수정 |
| `src/app/api/sessions/[id]/variables/route.ts` | 월드 파일 쓰기 거부 | 수정 |
| `scripts/lint-data.mjs` | `layout.app`/`chat.mode` 검증 | 수정 |

---

### Task 1: 앱 모드 설정 읽기 (`app-mode.ts`)

**Files:**
- Create: `src/lib/app-mode.ts`
- Create: `src/lib/app-mode.test.ts`
- Modify: `src/hooks/useLayout.ts` (`LayoutConfig` 인터페이스)

**Interfaces:**
- Consumes: 없음 (첫 Task)
- Produces: `interface AppModeConfig { entry: string; engine: string; worldFile: string; chatMode: "normal" | "dock" | "hidden" }`, `function resolveAppMode(layout: unknown): AppModeConfig | null`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/lib/app-mode.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppMode } from "./app-mode";

test("app 설정이 없으면 null — 기존 페르소나 무영향", () => {
  assert.equal(resolveAppMode({ panels: { position: "right" } }), null);
  assert.equal(resolveAppMode(null), null);
  assert.equal(resolveAppMode({ app: null }), null);
});

test("app 설정의 기본값을 채운다", () => {
  const r = resolveAppMode({ app: { entry: "app/index.html" } });
  assert.deepEqual(r, {
    entry: "app/index.html",
    engine: "world",
    worldFile: "world.json",
    chatMode: "normal",
  });
});

test("chat.mode를 읽되 기존 chat 필드를 요구하지 않는다", () => {
  const r = resolveAppMode({ app: { entry: "a/i.html" }, chat: { maxWidth: 800, mode: "hidden" } });
  assert.equal(r?.chatMode, "hidden");
});

test("알 수 없는 chat.mode는 normal로 떨어진다", () => {
  const r = resolveAppMode({ app: { entry: "a/i.html" }, chat: { mode: "bogus" } });
  assert.equal(r?.chatMode, "normal");
});

test("worldFile은 .json이 강제되고 경로 구분자를 거부한다", () => {
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "w" } })?.worldFile, "w.json");
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "../w.json" } }), null);
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "sub/w.json" } }), null);
});

test("engine 이름은 경로 구분자를 거부한다", () => {
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", engine: "../evil" } }), null);
});

test("entry가 없으면 null", () => {
  assert.equal(resolveAppMode({ app: { engine: "world" } }), null);
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/app-mode.test.ts
```

Expected: FAIL — `Cannot find module './app-mode'`

- [ ] **Step 3: 최소 구현을 작성한다**

`src/lib/app-mode.ts`:

```ts
/** layout.json의 앱 모드 설정. `app`이 없으면 세션은 기존(채팅 중심) 셸로 동작한다. */
export interface AppModeConfig {
  /** 세션 디렉토리 기준 앱 진입 HTML 경로 */
  entry: string;
  /** tools/{engine}.js — 월드 엔진 모듈 이름 */
  engine: string;
  /** 세션 디렉토리 직하의 월드 상태 파일명 */
  worldFile: string;
  chatMode: ChatMode;
}

export type ChatMode = "normal" | "dock" | "hidden";

const CHAT_MODES = new Set<string>(["normal", "dock", "hidden"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 경로 구분자·traversal을 포함하면 안 되는 단일 세그먼트 이름인지. */
function isSafeSegment(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/**
 * layout.json에서 앱 모드 설정을 해석한다. 설정이 없거나 유효하지 않으면 null —
 * 호출부는 null을 "기존 셸"로 취급하므로 기존 페르소나는 이 경로를 전혀 타지 않는다.
 */
export function resolveAppMode(layout: unknown): AppModeConfig | null {
  if (!isObject(layout) || !isObject(layout.app)) return null;
  const app = layout.app;

  const entry = typeof app.entry === "string" ? app.entry.trim() : "";
  if (!entry || entry.includes("..") || entry.startsWith("/") || entry.startsWith("\\")) return null;

  const engine = typeof app.engine === "string" && app.engine.trim() ? app.engine.trim() : "world";
  if (!isSafeSegment(engine)) return null;

  let worldFile = typeof app.worldFile === "string" && app.worldFile.trim() ? app.worldFile.trim() : "world.json";
  if (!worldFile.endsWith(".json")) worldFile = `${worldFile}.json`;
  if (!isSafeSegment(worldFile)) return null;

  const rawMode = isObject(layout.chat) && typeof layout.chat.mode === "string" ? layout.chat.mode : "normal";
  const chatMode = (CHAT_MODES.has(rawMode) ? rawMode : "normal") as ChatMode;

  return { entry, engine, worldFile, chatMode };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/app-mode.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 5: `LayoutConfig`에 필드를 추가한다**

`src/hooks/useLayout.ts`의 `LayoutConfig` 인터페이스에서 `chat` 블록을 찾아 `mode`를 추가하고, 최상위에 `app`을 추가한다. **기존 필드는 건드리지 않는다**:

```ts
  chat: {
    maxWidth: number | null;
    align: "stretch" | "center";
    /** 앱 모드에서 채팅 영역의 강등 수준. 미지정 = "normal"(기존 동작). */
    mode?: "normal" | "dock" | "hidden";
  };
  /** 앱 모드 설정. 없으면 기존 채팅 중심 셸. 해석은 resolveAppMode()가 담당. */
  app?: {
    entry: string;
    engine?: string;
    worldFile?: string;
  };
```

- [ ] **Step 6: typecheck**

```bash
npm run typecheck
```

Expected: 에러 0

- [ ] **Step 7: 커밋**

```bash
git add src/lib/app-mode.ts src/lib/app-mode.test.ts src/hooks/useLayout.ts
git commit -m "feat(app-mode): layout.json의 app/chat.mode 설정 해석기"
```

---

### Task 2: 앱 번들 정적 서빙 (MIME)

**Files:**
- Modify: `src/lib/static-file.ts` (`STATIC_MIME`)
- Create: `src/lib/static-file.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `mimeForPath()`가 `.js`/`.mjs`/`.html`/`.css`/`.json`에 올바른 타입을 반환

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/lib/static-file.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mimeForPath } from "./static-file";

test("앱 번들 확장자에 올바른 MIME을 준다", () => {
  assert.equal(mimeForPath("app/main.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeForPath("app/mod.mjs"), "text/javascript; charset=utf-8");
  assert.equal(mimeForPath("app/index.html"), "text/html; charset=utf-8");
  assert.equal(mimeForPath("app/style.css"), "text/css; charset=utf-8");
  assert.equal(mimeForPath("app/data.json"), "application/json; charset=utf-8");
});

test("기존 타입은 그대로다", () => {
  assert.equal(mimeForPath("a/b.png"), "image/png");
  assert.equal(mimeForPath("a/b.mp4"), "video/mp4");
  assert.equal(mimeForPath("a/b.unknown"), "application/octet-stream");
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/static-file.test.ts
```

Expected: FAIL — `.js`가 `application/octet-stream`

- [ ] **Step 3: `STATIC_MIME`에 항목을 추가한다**

`src/lib/static-file.ts`의 `STATIC_MIME` 객체 끝(`".vtt"` 다음)에 추가:

```ts
  // 앱 모드 번들 (layout.app.entry가 가리키는 HTML과 그 자산)
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/static-file.test.ts
npm run typecheck
```

Expected: PASS, 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/lib/static-file.ts src/lib/static-file.test.ts
git commit -m "feat(static): 앱 번들 확장자 MIME 추가 (.html/.css/.js/.mjs/.json)"
```

---

### Task 3: 월드 엔진 래퍼 + 세션 뮤텍스 (`world-engine.ts`)

엔진은 기존 tool 라우트로 호출한다 (패치 적용·타임아웃·경로 안전을 한 곳에 유지). `step`만 세션 뮤텍스 아래 돈다.

**Files:**
- Create: `src/lib/world-engine.ts`
- Create: `src/lib/world-engine.test.ts`

**Interfaces:**
- Consumes: `getApiBase()` (`src/lib/endpoints.ts`), `getInternalToken()` (`src/lib/auth.ts`)
- Produces:
  - `function observe(sessionId, engine, observerId, opts?): Promise<string>`
  - `function submit(sessionId, engine, observerId, intent): Promise<void>`
  - `function step(sessionId, engine): Promise<StepResult>` — 세션 뮤텍스 아래 실행
  - `function snapshot(sessionId, engine): Promise<unknown>`
  - `interface StepResult { threads?: { spawn?: ThreadSpawnRequest[]; despawn?: string[] } }`
  - `interface ThreadSpawnRequest { threadId: string; role: string; params?: Record<string, unknown> }`
  - `function runExclusiveSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>` (테스트용 export)

- [ ] **Step 1: 실패하는 테스트를 작성한다**

세션 뮤텍스가 동시 `step`을 직렬화하는지만 검증한다 (HTTP는 테스트하지 않는다 — 라우트는 이미 존재하고 스모크가 덮는다).

`src/lib/world-engine.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExclusiveSession } from "./world-engine";

test("같은 세션의 작업은 직렬화된다 (lost update 방지)", async () => {
  let shared = 0;
  const order: string[] = [];
  const task = (tag: string) => runExclusiveSession("s1", async () => {
    const read = shared;                                  // 읽기
    await new Promise((r) => setTimeout(r, 10));          // 계산 (교차 유도)
    shared = read + 1;                                    // 쓰기
    order.push(tag);
  });
  await Promise.all([task("a"), task("b"), task("c")]);
  assert.equal(shared, 3, "직렬화되지 않으면 3이 아니다");
  assert.deepEqual(order, ["a", "b", "c"], "FIFO 순서여야 한다");
});

test("다른 세션은 서로를 막지 않는다", async () => {
  const started: string[] = [];
  let releaseA: (() => void) | null = null;
  const a = runExclusiveSession("A", async () => {
    started.push("A");
    await new Promise<void>((r) => { releaseA = r; });
  });
  await new Promise((r) => setTimeout(r, 5));
  const b = runExclusiveSession("B", async () => { started.push("B"); });
  await b;
  assert.deepEqual(started, ["A", "B"], "B는 A를 기다리지 않아야 한다");
  releaseA?.();
  await a;
});

test("작업이 throw해도 락이 풀린다", async () => {
  await assert.rejects(runExclusiveSession("s2", async () => { throw new Error("boom"); }));
  let ran = false;
  await runExclusiveSession("s2", async () => { ran = true; });
  assert.equal(ran, true, "이전 실패가 락을 잠그면 안 된다");
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/world-engine.test.ts
```

Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현을 작성한다**

`src/lib/world-engine.ts`:

```ts
import { getApiBase } from "./endpoints";
import { getInternalToken } from "./auth";

/** step()이 요청하는 스레드 스폰. threadId는 [a-z0-9_-]만 허용 (unsetPath dot 제약과 동일 규칙). */
export interface ThreadSpawnRequest {
  threadId: string;
  role: string;
  params?: Record<string, unknown>;
}

export interface StepResult {
  /** 스레드 런타임 명령. 패치가 아니므로 tool 라우트가 아니라 thread-loop이 해석한다. */
  threads?: { spawn?: ThreadSpawnRequest[]; despawn?: string[] };
  /** 엔진이 남기는 사람이 읽는 요약 (로그용) */
  note?: string;
}

/** 세션별 직렬 실행 큐. step()의 읽기-계산-쓰기를 하나의 임계 구역으로 묶는다.
 *  파일 뮤텍스(runExclusive)는 쓰기 순간만 잡으므로 이것을 대체하지 못한다. */
const sessionChains = new Map<string, Promise<unknown>>();

export function runExclusiveSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  // 이전 작업의 실패가 뒤 작업을 막지 않도록 체인은 항상 resolve로 잇는다.
  const next = prev.then(fn, fn);
  sessionChains.set(sessionId, next.then(() => undefined, () => undefined));
  return next;
}

interface ToolResponse {
  result?: unknown;
  error?: string;
}

/** 세션의 tool 라우트로 엔진 액션을 호출한다. 패치 적용은 라우트가 하고, 여기서는 result만 본다. */
async function callEngine(
  sessionId: string,
  engine: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(
    `${getApiBase()}/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(engine)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bridge-token": getInternalToken() },
      body: JSON.stringify({ args }),
    },
  );
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as ToolResponse;
  if (!res.ok) throw new Error(`world engine ${String(args.action)} failed (${res.status}): ${data.error ?? text}`);
  return data.result;
}

/** 관찰자 시점 브리핑. since가 없으면 전체 스냅샷, 있으면 그 이후 변화분. */
export async function observe(
  sessionId: string,
  engine: string,
  observerId: string,
  opts?: { since?: number | null },
): Promise<string> {
  const r = await callEngine(sessionId, engine, {
    action: "observe",
    observerId,
    since: opts?.since ?? null,
  });
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
    return (r as { text: string }).text;
  }
  return r === undefined || r === null ? "" : JSON.stringify(r);
}

/** 의도 제출. 검증하지 않는다 — 검증은 step()의 몫. 세션 뮤텍스가 필요 없다:
 *  엔진이 $merge:"deep"로 자기 키만 쓰므로 동시 제출이 서로를 덮지 않는다 (spec §5.6). */
export async function submit(
  sessionId: string,
  engine: string,
  observerId: string,
  intent: unknown,
): Promise<void> {
  await callEngine(sessionId, engine, { action: "submit", observerId, intent });
}

/** 큐 배치 드레인 + 규칙 적용. 세션 뮤텍스 아래에서만 실행된다. */
export function step(sessionId: string, engine: string): Promise<StepResult> {
  return runExclusiveSession(sessionId, async () => {
    const r = await callEngine(sessionId, engine, { action: "step" });
    return (r && typeof r === "object" ? (r as StepResult) : {});
  });
}

/** 앱 렌더용 월드 상태. 읽기 전용이라 락이 없다. */
export function snapshot(sessionId: string, engine: string): Promise<unknown> {
  return callEngine(sessionId, engine, { action: "snapshot" });
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/world-engine.test.ts
npm run typecheck
```

Expected: PASS (3 tests), 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/lib/world-engine.ts src/lib/world-engine.test.ts
git commit -m "feat(world): 엔진 액션 래퍼 + 세션 뮤텍스 (step 직렬화)"
```

---

### Task 4: 매니페스트 v2 — 역할과 스레드 (`thread-manifest.ts`)

**Files:**
- Create: `src/lib/thread-manifest.ts`
- Create: `src/lib/thread-manifest.test.ts`

**Interfaces:**
- Consumes: `providerFromModel`, `parseModelEffort` (`src/lib/ai-provider.ts`), `SubAgentDef` (`src/lib/subagent-manifest.ts`)
- Produces:
  - `interface RoleDef { name, instructions, provider?, model?, effort?, scope?, loop: LoopConfig, emitSummary, delegable }`
  - `interface LoopConfig { mode: "loop" | "onAssistantTurn" | "none"; intervalMs: number; resetEveryTurns: number }`
  - `interface ThreadDef { threadId: string; role: string; params: Record<string, unknown> }`
  - `interface ThreadManifest { version: number; roles: Map<string, RoleDef>; threads: ThreadDef[] }`
  - `function loadThreadManifest(dir: string): ThreadManifest`
  - `function parseThreadManifest(raw: unknown): ThreadManifest`
  - `const MIN_INTERVAL_MS = 5000`, `const THREAD_MAX: number`
  - `const THREAD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/lib/thread-manifest.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/thread-manifest.test.ts
```

Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현을 작성한다**

`src/lib/thread-manifest.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";

/** 스레드 주기 하한. 저자가 실수로 100ms를 적는 것을 막는다. */
export const MIN_INTERVAL_MS = 5_000;
/** 루프 스레드의 기본 주기. */
export const DEFAULT_INTERVAL_MS = 8_000;
/** 컨텍스트 리셋 전까지의 기본 턴 수. */
export const DEFAULT_RESET_TURNS = 40;
/** 세션당 스레드 상한. 기존 SUBAGENT_MAX(6)를 대체한다. */
export const THREAD_MAX = Number(process.env.THREAD_MAX) > 0 ? Number(process.env.THREAD_MAX) : 12;

/** threadId는 dot을 허용하지 않는다 — $unset dot-path 드레인과 충돌하기 때문 (spec §5.6). */
export const THREAD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type LoopMode = "loop" | "onAssistantTurn" | "none";

export interface LoopConfig {
  mode: LoopMode;
  intervalMs: number;
  resetEveryTurns: number;
  /** true면 컨텍스트 리셋 시 대화 요약 턴을 돌린다. 기본 false = 상태 기반 재prime. */
  summarizeOnReset: boolean;
}

export interface RoleDef {
  name: string;
  /** 지침 파일 경로. v2는 세션 디렉토리 기준, v1 승격분은 subagents/{name}/ 기준. */
  instructions: string;
  /** true면 instructions가 세션 디렉토리 기준 경로다. */
  instructionsFromSessionRoot: boolean;
  provider?: AIProvider;
  model?: string;
  effort?: string;
  /** 엔진이 해석하는 가시 범위 태그. 플랫폼은 전달만 한다. */
  scope?: string;
  loop: LoopConfig;
  emitSummary: boolean;
  delegable: boolean;
  /** v1 autoTrigger의 기본 태스크 (하위호환). */
  autoTriggerTask?: string;
}

export interface ThreadDef {
  threadId: string;
  role: string;
  params: Record<string, unknown>;
}

export interface ThreadManifest {
  version: number;
  roles: Map<string, RoleDef>;
  threads: ThreadDef[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseLoop(raw: unknown, fallbackMode: LoopMode): LoopConfig {
  const o = isObject(raw) ? raw : {};
  const mode: LoopMode =
    o.mode === "loop" || o.mode === "onAssistantTurn" || o.mode === "none" ? o.mode : fallbackMode;
  const rawInterval = typeof o.intervalMs === "number" && Number.isFinite(o.intervalMs)
    ? o.intervalMs : DEFAULT_INTERVAL_MS;
  const rawReset = typeof o.resetEveryTurns === "number" && Number.isFinite(o.resetEveryTurns) && o.resetEveryTurns > 0
    ? Math.floor(o.resetEveryTurns) : DEFAULT_RESET_TURNS;
  return {
    mode,
    intervalMs: Math.max(MIN_INTERVAL_MS, Math.floor(rawInterval)),
    resetEveryTurns: rawReset,
    summarizeOnReset: o.summarizeOnReset === true,
  };
}

/** model 문자열에서 provider/effort를 도출한다. 실패하면 pin 전체를 버려 세션 런타임을 따르게 한다
 *  (기존 subagent-manifest v2.1의 폴백 규칙과 동일). */
function resolveRuntime(raw: Record<string, unknown>, roleName: string): Pick<RoleDef, "provider" | "model" | "effort"> {
  const rawModel = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  const explicitProvider = typeof raw.provider === "string" && raw.provider.trim()
    ? (raw.provider.trim() as AIProvider) : undefined;
  const explicitEffort = typeof raw.effort === "string" && raw.effort.trim() ? raw.effort.trim() : undefined;

  if (!rawModel) return { provider: explicitProvider, model: undefined, effort: explicitEffort };

  const parsed = parseModelEffort(rawModel);
  let provider = explicitProvider;
  if (!provider) {
    try {
      provider = providerFromModel(rawModel);
    } catch {
      console.warn(`[thread-manifest] role "${roleName}": provider 도출 실패 (model="${rawModel}") — 세션 런타임을 따른다`);
      return { provider: undefined, model: undefined, effort: explicitEffort };
    }
  }
  return { provider, model: parsed.model || undefined, effort: explicitEffort ?? parsed.effort };
}

function parseRole(raw: unknown, i: number, fromV1: boolean): RoleDef {
  if (!isObject(raw)) throw new Error(`roles[${i}]: must be an object`);
  const name = String(raw.name ?? "");
  if (!ROLE_NAME_RE.test(name)) throw new Error(`roles[${i}]: invalid name "${name}"`);
  const instructions = typeof raw.instructions === "string" && raw.instructions.trim()
    ? raw.instructions.trim() : "instructions.md";
  if (instructions.includes("..")) throw new Error(`roles[${i}]: instructions must not traverse`);

  const fallbackMode: LoopMode = fromV1
    ? (raw.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none")
    : "none";

  return {
    name,
    instructions,
    instructionsFromSessionRoot: !fromV1,
    ...resolveRuntime(raw, name),
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    loop: parseLoop(raw.loop, fallbackMode),
    emitSummary: raw.emitSummary !== false,
    delegable: raw.delegable !== false,
    autoTriggerTask: typeof raw.autoTriggerTask === "string" ? raw.autoTriggerTask : undefined,
  };
}

/** subagents.json(raw)을 v2 형태로 파싱한다. v1 `subagents[]`는 스레드 하나짜리 역할로 승격. */
export function parseThreadManifest(raw: unknown): ThreadManifest {
  if (!isObject(raw)) throw new Error("subagents.json: root must be an object");

  const roles = new Map<string, RoleDef>();
  const threads: ThreadDef[] = [];

  // v1 경로: subagents[] → 역할 1 + 스레드 1
  const v1 = Array.isArray(raw.subagents) ? raw.subagents : null;
  if (v1) {
    v1.forEach((entry, i) => {
      const role = parseRole(entry, i, true);
      if (roles.has(role.name)) throw new Error(`subagents[${i}]: duplicate name "${role.name}"`);
      roles.set(role.name, role);
      threads.push({ threadId: role.name, role: role.name, params: {} });
    });
  }

  // v2 경로: roles[] + threads[]
  const v2Roles = Array.isArray(raw.roles) ? raw.roles : [];
  v2Roles.forEach((entry, i) => {
    const role = parseRole(entry, i, false);
    if (roles.has(role.name)) throw new Error(`roles[${i}]: duplicate name "${role.name}"`);
    roles.set(role.name, role);
  });

  const v2Threads = Array.isArray(raw.threads) ? raw.threads : [];
  const seen = new Set<string>(threads.map((t) => t.threadId));
  v2Threads.forEach((entry, i) => {
    if (!isObject(entry)) throw new Error(`threads[${i}]: must be an object`);
    const threadId = String(entry.threadId ?? "");
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`threads[${i}]: invalid threadId "${threadId}"`);
    if (seen.has(threadId)) throw new Error(`threads[${i}]: duplicate threadId "${threadId}"`);
    const role = String(entry.role ?? "");
    if (!roles.has(role)) throw new Error(`threads[${i}]: unknown role "${role}"`);
    seen.add(threadId);
    threads.push({ threadId, role, params: isObject(entry.params) ? entry.params : {} });
  });

  if (threads.length > THREAD_MAX) {
    throw new Error(`subagents.json: too many threads (${threads.length} > cap ${THREAD_MAX})`);
  }

  return { version: Array.isArray(raw.roles) ? 2 : 1, roles, threads };
}

/** 디렉토리에서 subagents.json을 읽어 파싱한다. 없으면 빈 매니페스트. */
export function loadThreadManifest(dir: string): ThreadManifest {
  const fp = path.join(dir, "subagents.json");
  if (!fs.existsSync(fp)) return { version: 2, roles: new Map(), threads: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (err) {
    throw new Error(`subagents.json parse error: ${(err as Error).message}`);
  }
  return parseThreadManifest(raw);
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/thread-manifest.test.ts
npm run typecheck
```

Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/thread-manifest.ts src/lib/thread-manifest.test.ts
git commit -m "feat(threads): subagents.json v2 파싱 — 역할 템플릿 + 스레드 인스턴스, v1 승격"
```

---

### Task 5: 라이브 스레드 레지스트리 (`thread-registry.ts`)

**Files:**
- Create: `src/lib/thread-registry.ts`
- Create: `src/lib/thread-registry.test.ts`

**Interfaces:**
- Consumes: `ThreadDef`, `THREAD_ID_RE`, `THREAD_MAX` (Task 4), `mutateSessionJsonSync`/`readSessionJson` (`src/lib/session-state.ts`)
- Produces:
  - `function readLiveThreads(sessionDir: string): ThreadDef[]`
  - `function writeLiveThreads(sessionDir: string, threads: ThreadDef[]): void`
  - `function reconcileThreads(sessionDir: string, manifest: ThreadManifest): ThreadDef[]` — 최초 1회 매니페스트 시드, 이후 `threads.json` 우선
  - `function applyThreadOps(sessionDir, manifest, ops): ThreadDef[]`

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/lib/thread-registry.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/thread-registry.test.ts
```

Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현을 작성한다**

`src/lib/thread-registry.ts`:

```ts
import * as path from "path";
import { readSessionJson, atomicWriteJsonSync } from "./session-state";
import { ThreadDef, ThreadManifest, THREAD_ID_RE, THREAD_MAX } from "./thread-manifest";
import type { ThreadSpawnRequest } from "./world-engine";

const FILE = "threads.json";

interface RegistryFile {
  version: number;
  threads: ThreadDef[];
}

function regPath(sessionDir: string): string {
  return path.join(sessionDir, FILE);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** threads.json을 읽는다. 없거나 깨졌으면 빈 배열. */
export function readLiveThreads(sessionDir: string): ThreadDef[] {
  let raw: unknown;
  try {
    raw = readSessionJson<RegistryFile>(regPath(sessionDir));
  } catch {
    return [];
  }
  if (!isObject(raw) || !Array.isArray(raw.threads)) return [];
  const out: ThreadDef[] = [];
  for (const entry of raw.threads) {
    if (!isObject(entry)) continue;
    const threadId = String(entry.threadId ?? "");
    const role = String(entry.role ?? "");
    if (!THREAD_ID_RE.test(threadId) || !role) continue;
    out.push({ threadId, role, params: isObject(entry.params) ? entry.params : {} });
  }
  return out;
}

export function writeLiveThreads(sessionDir: string, threads: ThreadDef[]): void {
  atomicWriteJsonSync(regPath(sessionDir), { version: 1, threads } as unknown as Record<string, unknown>);
}

/** 매니페스트의 역할에 속하는 스레드만 남긴다. */
function keepKnownRoles(threads: ThreadDef[], manifest: ThreadManifest): ThreadDef[] {
  return threads.filter((t) => manifest.roles.has(t.role));
}

/**
 * 세션 open 시 살아있는 스레드 목록을 확정한다.
 * - threads.json이 있으면 그것이 진실 (런타임 스폰 결과가 보존된다)
 * - 없으면 매니페스트의 threads[]로 시드하고 파일을 만든다
 */
export function reconcileThreads(sessionDir: string, manifest: ThreadManifest): ThreadDef[] {
  const stored = readLiveThreads(sessionDir);
  if (stored.length > 0) {
    const kept = keepKnownRoles(stored, manifest);
    if (kept.length !== stored.length) writeLiveThreads(sessionDir, kept);
    return kept;
  }
  const seeded = keepKnownRoles(manifest.threads, manifest).slice(0, THREAD_MAX);
  writeLiveThreads(sessionDir, seeded);
  return seeded;
}

/** step()이 요청한 스폰/소멸을 적용하고 영속화한다. 잘못된 요청은 조용히 무시한다. */
export function applyThreadOps(
  sessionDir: string,
  manifest: ThreadManifest,
  ops: { spawn?: ThreadSpawnRequest[]; despawn?: string[] },
): ThreadDef[] {
  const byId = new Map<string, ThreadDef>();
  for (const t of readLiveThreads(sessionDir)) byId.set(t.threadId, t);

  for (const id of ops.despawn ?? []) byId.delete(String(id));

  for (const req of ops.spawn ?? []) {
    if (!req || typeof req !== "object") continue;
    const threadId = String(req.threadId ?? "");
    const role = String(req.role ?? "");
    if (!THREAD_ID_RE.test(threadId)) {
      console.warn(`[thread-registry] spawn 무시 — 잘못된 threadId "${threadId}"`);
      continue;
    }
    if (!manifest.roles.has(role)) {
      console.warn(`[thread-registry] spawn 무시 — 알 수 없는 역할 "${role}"`);
      continue;
    }
    if (!byId.has(threadId) && byId.size >= THREAD_MAX) {
      console.warn(`[thread-registry] spawn 무시 — 스레드 상한 ${THREAD_MAX} 도달`);
      continue;
    }
    const params = req.params && typeof req.params === "object" ? req.params : {};
    byId.set(threadId, { threadId, role, params });
  }

  const next = [...byId.values()];
  writeLiveThreads(sessionDir, next);
  return next;
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/thread-registry.test.ts
npm run typecheck
```

Expected: PASS (7 tests). `atomicWriteJsonSync`가 `session-state.ts`에서 export되지 않았다면 export를 추가한다 (`git grep -n "atomicWriteJsonSync" -- src/lib/session-state.ts`로 확인).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/thread-registry.ts src/lib/thread-registry.test.ts src/lib/session-state.ts
git commit -m "feat(threads): threads.json 라이브 레지스트리 — 재open 복원, spawn/despawn 적용"
```

---

### Task 6: `SubAgentInstance`에 스레드 정체성 주입

역할 지침은 공유되고, 정체성은 `params`로 온다. 지침 경로는 v2에서 세션 루트 기준이다.

**Files:**
- Modify: `src/lib/subagent-instance.ts`
- Modify: `src/lib/subagent-manifest.ts` (`SubAgentDef`에 스레드 필드 추가)

**Interfaces:**
- Consumes: `RoleDef`, `ThreadDef` (Task 4)
- Produces: `SubAgentInstance`가 `threadId`로 식별되고 `buildSubSystemPrompt`가 `[THREAD]` 블록을 포함

- [ ] **Step 1: `SubAgentDef`를 확장한다**

`src/lib/subagent-manifest.ts`의 `SubAgentDef` 인터페이스에 필드를 추가한다 (기존 필드는 유지 — 기존 소비자가 그대로 동작해야 한다):

```ts
  /** 스레드 인스턴스 식별자. v1 승격분은 name과 같다. */
  threadId?: string;
  /** 이 스레드의 정체성 파라미터. 역할 지침은 공유되고 이것이 누구/무엇인지를 정한다. */
  params?: Record<string, unknown>;
  /** 지침 경로가 세션 디렉토리 기준인지 (v2 역할) 아니면 subagents/{name}/ 기준인지 (v1). */
  instructionsFromSessionRoot?: boolean;
  /** 엔진이 해석하는 가시 범위 태그. */
  scope?: string;
```

- [ ] **Step 2: 실패하는 테스트를 작성한다**

`src/lib/subagent-instance.test.ts`를 새로 만든다. 프로세스를 띄우지 않고 프롬프트 빌더만 검증하려면 `buildSubSystemPrompt`를 export해야 한다.

```ts
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
```

- [ ] **Step 3: 실패를 확인한다**

```bash
npx tsx --test src/lib/subagent-instance.test.ts
```

Expected: FAIL — `buildSubSystemPrompt` is not exported

- [ ] **Step 4: 구현한다**

`src/lib/subagent-instance.ts`에서:

(a) `buildSubSystemPrompt`를 `export function`으로 바꾸고 `[THREAD]` 블록을 추가한다:

```ts
export function buildSubSystemPrompt(def: SubAgentDef, instructions: string): string {
  const id = def.threadId ?? def.name;
  const hasParams = !!def.params && Object.keys(def.params).length > 0;
  return [
    `You are "${id}", a specialized background sub-agent for a roleplay session.`,
    `Your role: ${def.role}`,
    "You are NOT the narrator and you do NOT talk to the end user. The main narrator handles all user-facing prose.",
    "Exception: a message beginning with [OPERATOR] is the human operator talking to you directly, out of character. In that turn, reply to the operator concisely and conversationally. You MAY still use your tools and call report_to_main when you actually change state.",
    "You operate on the SHARED session directory: read/write panel variables and data files using the MCP tools available to you (run_tool and the session's custom tools).",
    def.emitSummary
      ? `When you finish a task, call the MCP tool report_to_main with { from: "${id}", summary: "<one or two concise sentences of what changed>" } so the narrator learns what happened on its next turn. Do NOT write user-facing narrative.`
      : "Do not emit user-facing narrative.",
    "Keep your own text responses terse. The real work happens through tool calls.",
    ...(hasParams
      ? [
          "",
          "--- THREAD IDENTITY ---",
          // 역할 지침은 같은 역할의 모든 스레드가 공유한다. 아래 값이 "네가 누구인지"다.
          `[THREAD] threadId=${id}`,
          JSON.stringify(def.params, null, 2),
          def.scope ? `[SCOPE] ${def.scope}` : "",
        ].filter(Boolean)
      : []),
    "",
    "--- ROLE INSTRUCTIONS ---",
    instructions,
  ].join("\n");
}
```

(b) `subDir()`와 `readInstructions()`를 threadId 기준으로 바꾼다:

```ts
  private subDir(): string { return path.join(this.sessionDir, "subagents", this.name); }

  private readInstructions(): string {
    // v2 역할 지침은 세션 루트 기준(roles/{role}.md) — 같은 역할의 스레드들이 한 파일을 공유한다.
    // v1 승격분은 기존대로 subagents/{name}/ 기준이라 마이그레이션이 필요 없다.
    const fp = this.def.instructionsFromSessionRoot
      ? path.join(this.sessionDir, this.def.instructions)
      : path.join(this.subDir(), this.def.instructions);
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      console.warn(`[subagent:${this.sessionId}/${this.name}] instructions not found at ${fp} — sub will run with an empty role body`);
      return "";
    }
  }
```

`this.name`은 생성자에서 `def.threadId ?? def.name`으로 채운다:

```ts
    this.def = def;
    this.name = def.threadId ?? def.name;
```

- [ ] **Step 5: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/subagent-instance.test.ts
npm run typecheck
```

Expected: PASS (3 tests), 타입 에러 0

- [ ] **Step 6: 커밋**

```bash
git add src/lib/subagent-instance.ts src/lib/subagent-manifest.ts src/lib/subagent-instance.test.ts
git commit -m "feat(threads): 스레드 정체성 주입 — [THREAD] params 블록 + 역할 지침 공유 경로"
```

---

### Task 7: `SubAgentManager`를 threadId로 키잉 + 동적 spawn/despawn

**Files:**
- Modify: `src/lib/subagent-manager.ts`

**Interfaces:**
- Consumes: `loadThreadManifest`, `reconcileThreads`, `applyThreadOps` (Task 4·5)
- Produces:
  - `spawnAll(provider, model?, effort?)` — 매니페스트 + 레지스트리를 합쳐 스레드를 띄운다 (시그니처 불변)
  - `applyOps(ops: { spawn?, despawn? }, provider, model?, effort?): void`
  - `loopThreads(): Array<{ threadId: string; role: RoleDef }>`
  - `manifest(): ThreadManifest | null`
  - 기존 `dispatch(name, task, origin)` / `recordReport` / `listDetailed` / `readTranscript` 시그니처 **유지**

- [ ] **Step 1: 변경 전 동작을 고정하는 테스트를 작성한다**

프로세스 스폰 없이 검증하려면 매니페스트→def 변환 로직을 순수 함수로 분리해야 한다. `src/lib/subagent-manager.ts`에 export를 추가하고 테스트한다.

`src/lib/subagent-manager.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/subagent-manager.test.ts
```

Expected: FAIL — `buildThreadDefs` 없음

- [ ] **Step 3: `buildThreadDefs`를 구현하고 매니저를 threadId로 키잉한다**

`src/lib/subagent-manager.ts` 상단에 추가:

```ts
import { loadThreadManifest, ThreadManifest, ThreadDef, RoleDef } from "./thread-manifest";
import { reconcileThreads, applyThreadOps } from "./thread-registry";
import type { ThreadSpawnRequest } from "./world-engine";

/** 매니페스트의 역할 + 라이브 스레드 목록 → SubAgentInstance가 먹는 def 배열.
 *  순수 함수라 테스트 가능하다. */
export function buildThreadDefs(manifest: ThreadManifest, threads: ThreadDef[]): SubAgentDef[] {
  const defs: SubAgentDef[] = [];
  for (const t of threads) {
    const role: RoleDef | undefined = manifest.roles.get(t.role);
    if (!role) continue;
    defs.push({
      name: role.name,
      role: role.name,
      provider: role.provider ?? "claude",
      providerExplicit: role.provider,
      model: role.model,
      effort: role.effort,
      instructions: role.instructions,
      instructionsFromSessionRoot: role.instructionsFromSessionRoot,
      delegable: role.delegable,
      autoTrigger: role.loop.mode === "onAssistantTurn" ? "onAssistantTurn" : "none",
      autoTriggerTask: role.autoTriggerTask,
      emitSummary: role.emitSummary,
      threadId: t.threadId,
      params: t.params,
      scope: role.scope,
    });
  }
  return defs;
}
```

`spawnAll`의 본문에서 `loadSubAgentManifest(dir).subagents` 대신:

```ts
    let manifest: ThreadManifest;
    try {
      manifest = loadThreadManifest(dir);
    } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] manifest invalid:`, (err as Error).message);
      return;
    }
    this._manifest = manifest;
    const live = reconcileThreads(dir, manifest);
    const defs = buildThreadDefs(manifest, live);
```

그리고 루프 안의 `this.defs.set(def.name, def)` / `this.subs.get(def.name)` / `this.subs.set(def.name, inst)`를 전부 `const key = def.threadId ?? def.name;`을 써서 `key`로 바꾼다. 콜백의 `subName`도 `key`를 쓴다.

**매니페스트에서 사라진 스레드를 정리한다** — 루프가 끝난 뒤:

```ts
    // 레지스트리에서 빠진 스레드의 인스턴스는 파괴한다 (재open 시 목록이 줄어든 경우).
    const liveKeys = new Set(defs.map((d) => d.threadId ?? d.name));
    for (const [key, inst] of [...this.subs]) {
      if (liveKeys.has(key)) continue;
      try { inst.destroy(); } catch { /* ignore */ }
      this.subs.delete(key);
      this.defs.delete(key);
    }
```

클래스에 필드와 메서드를 추가한다:

```ts
  private _manifest: ThreadManifest | null = null;
  private _dirForOps: string | null = null;

  manifest(): ThreadManifest | null { return this._manifest; }

  /** loop.mode === "loop"인 살아있는 스레드들. thread-loop이 소비한다. */
  loopThreads(): Array<{ threadId: string; role: RoleDef }> {
    const m = this._manifest;
    if (!m) return [];
    const out: Array<{ threadId: string; role: RoleDef }> = [];
    for (const [key, def] of this.defs) {
      const role = m.roles.get(def.role);
      if (role && role.loop.mode === "loop") out.push({ threadId: key, role });
    }
    return out;
  }

  /** step()이 요청한 스폰/소멸을 적용한다. 새 스레드는 즉시 띄우고, 소멸분은 파괴한다. */
  applyOps(
    ops: { spawn?: ThreadSpawnRequest[]; despawn?: string[] },
    provider: AIProvider, model?: string, effort?: string,
  ): void {
    const dir = this.getDir();
    const m = this._manifest;
    if (!dir || !m) return;
    const live = applyThreadOps(dir, m, ops);
    // despawn: 인스턴스를 먼저 죽인다. 턴 중이어도 destroy가 프로세스를 정리한다.
    const liveIds = new Set(live.map((t) => t.threadId));
    for (const [key, inst] of [...this.subs]) {
      if (liveIds.has(key)) continue;
      try { inst.destroy(); } catch { /* ignore */ }
      this.subs.delete(key);
      this.defs.delete(key);
    }
    // spawn: 새 def만 띄운다 (기존 인스턴스는 그대로).
    for (const def of buildThreadDefs(m, live)) {
      const key = def.threadId ?? def.name;
      if (this.subs.has(key)) continue;
      this.defs.set(key, def);
      const inst = new SubAgentInstance(
        def, dir, this.sessionId,
        def.providerExplicit ?? provider,
        def.model ?? model,
        def.effort ?? ((def.providerExplicit ?? provider) === provider ? effort : undefined),
        (entry) => this.broadcast?.("subagent:message", { name: key, entry }),
        (busy) => this.broadcast?.("subagent:status", { name: key, busy }),
      );
      this.subs.set(key, inst);
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${key} failed:`, err);
      }
    }
  }

  /** 스레드가 바쁜지 — 루프가 틱을 건너뛸지 판단한다. */
  isBusy(threadId: string): boolean {
    return this.subs.get(threadId)?.isBusy() ?? false;
  }
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/subagent-manager.test.ts
npm run typecheck
```

Expected: PASS (3 tests), 타입 에러 0. `loadSubAgentManifest` import가 더 이상 안 쓰이면 제거한다.

- [ ] **Step 5: 기존 서브에이전트 테스트가 있으면 함께 돌린다**

```bash
npx tsx --test src/lib/thread-manifest.test.ts src/lib/thread-registry.test.ts src/lib/subagent-instance.test.ts
```

Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add src/lib/subagent-manager.ts src/lib/subagent-manager.test.ts
git commit -m "feat(threads): SubAgentManager를 threadId로 키잉 + 동적 spawn/despawn"
```

---

### Task 8: 루프 런타임 (`thread-loop.ts`)

세션 틱마다: 깨울 스레드 선정 → 병렬 `observe`+`dispatch` → 전원 완료 대기 → `step()` 1회.

**Files:**
- Create: `src/lib/thread-loop.ts`
- Create: `src/lib/thread-loop.test.ts`

**Interfaces:**
- Consumes: `observe`/`step`/`StepResult` (Task 3), `SubAgentManager.loopThreads/isBusy/dispatch/applyOps` (Task 7), `AppModeConfig` (Task 1)
- Produces:
  - `class ThreadLoop { constructor(deps: ThreadLoopDeps); start(): void; stop(): void; setPaused(p: boolean): void; setSpeed(mult: number): void; status(): ThreadLoopStatus; briefMain(): Promise<string> }`
  - `interface ThreadLoopStatus { running: boolean; paused: boolean; speed: number; tick: number; threads: number; lastError: string | null }`
  - `function selectDueThreads(now, threads, state, budget): string[]` (순수 함수, 테스트용 export)

- [ ] **Step 1: 실패하는 테스트를 작성한다**

틱 선정 로직(예산·주기·바쁨·지터)만 순수 함수로 뽑아 검증한다. 타이머와 프로세스는 스모크가 덮는다.

`src/lib/thread-loop.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDueThreads, type ThreadTickState } from "./thread-loop";

const T = (id: string, intervalMs: number) => ({ threadId: id, intervalMs });

test("주기가 안 된 스레드는 고르지 않는다", () => {
  const state: Record<string, ThreadTickState> = { a: { lastRunAt: 1000, turns: 0, busy: false } };
  assert.deepEqual(selectDueThreads(1500, [T("a", 5000)], state, 3), []);
  assert.deepEqual(selectDueThreads(6100, [T("a", 5000)], state, 3), ["a"]);
});

test("처음 보는 스레드는 즉시 깨운다", () => {
  assert.deepEqual(selectDueThreads(0, [T("a", 5000)], {}, 3), ["a"]);
});

test("바쁜 스레드는 건너뛴다 — 큐에 쌓지 않는다", () => {
  const state: Record<string, ThreadTickState> = { a: { lastRunAt: 0, turns: 0, busy: true } };
  assert.deepEqual(selectDueThreads(999_999, [T("a", 5000)], state, 3), []);
});

test("동시 실행 예산을 넘지 않는다", () => {
  const threads = [T("a", 1000), T("b", 1000), T("c", 1000), T("d", 1000)];
  const got = selectDueThreads(999_999, threads, {}, 2);
  assert.equal(got.length, 2);
});

test("예산이 0이면 아무것도 안 고른다", () => {
  assert.deepEqual(selectDueThreads(999_999, [T("a", 1000)], {}, 0), []);
});

test("가장 오래 기다린 스레드가 먼저 — 기아 방지", () => {
  const state: Record<string, ThreadTickState> = {
    a: { lastRunAt: 900, turns: 0, busy: false },
    b: { lastRunAt: 100, turns: 0, busy: false },
    c: { lastRunAt: 500, turns: 0, busy: false },
  };
  const got = selectDueThreads(999_999, [T("a", 1000), T("b", 1000), T("c", 1000)], state, 2);
  assert.deepEqual(got, ["b", "c"]);
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx tsx --test src/lib/thread-loop.test.ts
```

Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현을 작성한다**

`src/lib/thread-loop.ts`:

```ts
import { observe, step, type StepResult } from "./world-engine";
import type { AppModeConfig } from "./app-mode";
import type { RoleDef } from "./thread-manifest";

/** 한 스레드의 틱 상태. */
export interface ThreadTickState {
  lastRunAt: number;
  /** 컨텍스트 리셋 판단용 누적 턴 수. */
  turns: number;
  busy: boolean;
  /** 직전 observe 시각 — 다음 observe의 since가 된다. 리셋되면 null. */
  lastObservedAt?: number | null;
}

export interface ThreadTickCandidate {
  threadId: string;
  intervalMs: number;
}

/**
 * 이번 틱에 깨울 스레드를 고른다. 순수 함수.
 * - 주기가 도래했고, 바쁘지 않고, 예산이 남은 스레드만
 * - 오래 기다린 순서(기아 방지)
 */
export function selectDueThreads(
  now: number,
  threads: ThreadTickCandidate[],
  state: Record<string, ThreadTickState>,
  budget: number,
): string[] {
  if (budget <= 0) return [];
  const due = threads
    .filter((t) => {
      const s = state[t.threadId];
      if (!s) return true;                       // 처음 보는 스레드는 즉시
      if (s.busy) return false;                  // 바쁘면 이번 틱은 건너뛴다
      return now - s.lastRunAt >= t.intervalMs;
    })
    .sort((a, b) => (state[a.threadId]?.lastRunAt ?? -1) - (state[b.threadId]?.lastRunAt ?? -1));
  return due.slice(0, budget).map((t) => t.threadId);
}

export interface ThreadLoopStatus {
  running: boolean;
  paused: boolean;
  speed: number;
  tick: number;
  threads: number;
  lastError: string | null;
}

export interface ThreadLoopDeps {
  sessionId: string;
  app: AppModeConfig;
  /** 살아있는 루프 스레드 목록 (매 틱 새로 읽는다 — 런타임 스폰 반영). */
  loopThreads: () => Array<{ threadId: string; role: RoleDef }>;
  isBusy: (threadId: string) => boolean;
  dispatch: (threadId: string, task: string) => boolean;
  /** step()이 돌려준 스레드 명령 적용. */
  applyOps: (ops: NonNullable<StepResult["threads"]>) => void;
  /** 연결된 클라이언트가 있는지 — 없으면 자동 일시정지. */
  hasClients: () => boolean;
  /** 스레드의 컨텍스트를 버리고 상태 기반으로 재prime한다. */
  resetThread: (threadId: string) => void;
  broadcast?: (event: string, data: unknown) => void;
}

/** 세션 동시 실행 턴 상한. 프리워밍 스왑도 이 예산을 먹는다. */
const CONCURRENCY = Number(process.env.THREAD_CONCURRENCY) > 0 ? Number(process.env.THREAD_CONCURRENCY) : 3;
/** 한 틱의 디스패치 완료 대기 상한. 넘으면 다음 틱으로 넘긴다 (의도는 다음 배치에 합류). */
const TICK_WAIT_MS = Number(process.env.THREAD_TICK_WAIT_MS) > 0 ? Number(process.env.THREAD_TICK_WAIT_MS) : 120_000;
/** 스케줄러 기본 해상도. 실제 주기는 역할별 intervalMs가 정한다. */
const RESOLUTION_MS = 1_000;
/** 리셋 주기 지터 — 같은 역할 스레드들이 동시에 리셋되어 세계가 멈추는 것을 막는다. */
const RESET_JITTER = 0.2;

export class ThreadLoop {
  private readonly d: ThreadLoopDeps;
  private timer: NodeJS.Timeout | null = null;
  private state: Record<string, ThreadTickState> = {};
  private resetAt: Record<string, number> = {};
  private paused = false;
  private speed = 1;
  private tick = 0;
  private lastError: string | null = null;
  private ticking = false;

  constructor(deps: ThreadLoopDeps) {
    this.d = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runTick(); }, RESOLUTION_MS);
    // 서버 종료를 막지 않는다.
    this.timer.unref?.();
    this.emitStatus();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitStatus();
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.emitStatus();
  }

  /** 1 = 기본. 2 = 주기 절반(2배 빠름). 0.5 = 2배 느림. 0.25~4로 클램프. */
  setSpeed(mult: number): void {
    this.speed = Math.min(4, Math.max(0.25, Number.isFinite(mult) ? mult : 1));
    this.emitStatus();
  }

  status(): ThreadLoopStatus {
    return {
      running: !!this.timer,
      paused: this.paused,
      speed: this.speed,
      tick: this.tick,
      threads: this.d.loopThreads().length,
      lastError: this.lastError,
    };
  }

  /** 메인이 깨어날 때 붙일 브리핑. 이벤트 큐 재생이 아니라 현재 월드 상태다 (spec §8.3). */
  async briefMain(): Promise<string> {
    try {
      return await observe(this.d.sessionId, this.d.app.engine, "main", { since: null });
    } catch (err) {
      console.warn(`[thread-loop:${this.d.sessionId}] main 브리핑 실패:`, err);
      return "";
    }
  }

  private emitStatus(): void {
    try { this.d.broadcast?.("threads:status", this.status()); } catch { /* ignore */ }
  }

  /** 리셋까지 남은 턴 수를 지터와 함께 정한다. */
  private resetBudgetFor(role: RoleDef): number {
    const base = role.loop.resetEveryTurns;
    const jitter = 1 + (Math.random() * 2 - 1) * RESET_JITTER;
    return Math.max(1, Math.round(base * jitter));
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;                 // 이전 틱이 아직 4단계에 있다
    if (this.paused) return;
    if (!this.d.hasClients()) return;         // 아무도 안 보면 태우지 않는다

    const threads = this.d.loopThreads();
    if (threads.length === 0) return;

    this.ticking = true;
    try {
      const now = Date.now();
      // 1단계: 후보 선정. busy는 매니저에서 실시간으로 읽는다.
      for (const t of threads) {
        const s = this.state[t.threadId];
        if (s) s.busy = this.d.isBusy(t.threadId);
      }
      const candidates = threads.map((t) => ({
        threadId: t.threadId,
        intervalMs: Math.max(1, Math.round(t.role.loop.intervalMs / this.speed)),
      }));
      const due = selectDueThreads(now, candidates, this.state, CONCURRENCY);
      if (due.length === 0) return;

      const roleOf = new Map(threads.map((t) => [t.threadId, t.role]));

      // 2단계: 병렬 observe → dispatch
      await Promise.all(due.map(async (threadId) => {
        const role = roleOf.get(threadId);
        if (!role) return;
        const prev = this.state[threadId];
        let text: string;
        try {
          text = await observe(this.d.sessionId, this.d.app.engine, threadId, {
            since: prev?.lastObservedAt ?? null,
          });
        } catch (err) {
          this.lastError = `observe(${threadId}): ${(err as Error).message}`;
          console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
          return;
        }
        const turns = (prev?.turns ?? 0) + 1;
        this.state[threadId] = {
          lastRunAt: Date.now(),
          turns,
          busy: true,
          lastObservedAt: Date.now(),
        };
        if (!text.trim()) return;              // 볼 게 없으면 턴을 낭비하지 않는다
        this.d.dispatch(threadId, text);
      }));

      // 3단계: 이번 틱의 턴들이 끝날 때까지 대기 (상한 초과 시 다음 틱으로)
      await this.waitForIdle(due, TICK_WAIT_MS);

      // 4단계: 세션 뮤텍스 아래 step() 1회 — 배치 드레인
      let result: StepResult = {};
      try {
        result = await step(this.d.sessionId, this.d.app.engine);
      } catch (err) {
        this.lastError = `step: ${(err as Error).message}`;
        console.warn(`[thread-loop:${this.d.sessionId}] ${this.lastError}`);
      }
      if (result.threads) {
        try { this.d.applyOps(result.threads); } catch (err) {
          console.warn(`[thread-loop:${this.d.sessionId}] applyOps 실패:`, err);
        }
      }

      // 5단계: 컨텍스트 리셋 (틱 경계 = step 적용 후)
      for (const threadId of due) {
        const role = roleOf.get(threadId);
        const s = this.state[threadId];
        if (!role || !s) continue;
        if (this.resetAt[threadId] === undefined) this.resetAt[threadId] = this.resetBudgetFor(role);
        if (s.turns >= this.resetAt[threadId]) {
          this.d.resetThread(threadId);
          s.turns = 0;
          s.lastObservedAt = null;             // 다음 observe는 전체 스냅샷
          this.resetAt[threadId] = this.resetBudgetFor(role);
        }
      }

      this.tick += 1;
      this.emitStatus();
    } finally {
      this.ticking = false;
    }
  }

  /** 디스패치된 스레드들이 전부 idle이 될 때까지 폴링 대기. 상한을 넘으면 그냥 돌아온다. */
  private async waitForIdle(threadIds: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = threadIds.filter((id) => this.d.isBusy(id));
      for (const id of threadIds) {
        const s = this.state[id];
        if (s) s.busy = busy.includes(id);
      }
      if (busy.length === 0) return;
      if (Date.now() >= deadline) {
        console.warn(`[thread-loop:${this.d.sessionId}] 틱 대기 상한 초과 — ${busy.join(",")} 의도는 다음 배치에 합류`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

```bash
npx tsx --test src/lib/thread-loop.test.ts
npm run typecheck
```

Expected: PASS (6 tests), 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/lib/thread-loop.ts src/lib/thread-loop.test.ts
git commit -m "feat(threads): 루프 런타임 — 틱 순서 고정(step 1회/틱), 예산, 일시정지, 리셋 지터"
```

---

### Task 9: 컨텍스트 리셋 + 프리워밍 스왑

`resetThread`의 실제 구현. 대화 요약 없이 프로세스를 갈아끼운다.

**Files:**
- Modify: `src/lib/subagent-instance.ts` (리셋 지원)
- Modify: `src/lib/subagent-manager.ts` (`resetThread` 노출)

**Interfaces:**
- Consumes: `SubAgentInstance` 내부
- Produces: `SubAgentInstance.resetContext(): void`, `SubAgentManager.resetThread(threadId: string): void`

- [ ] **Step 1: `SubAgentInstance.resetContext()`를 구현한다**

`src/lib/subagent-instance.ts`의 `destroy()` 근처에 추가한다:

```ts
  /**
   * 대화 컨텍스트를 버리고 다음 dispatch에서 역할·정체성·관측으로 재prime한다.
   * 요약 턴을 돌리지 않는다 — 권위 있는 상태는 월드에 있고, 재prime은 그것을 읽는다 (spec §7.2).
   * 프로세스를 죽이고 resume 파일을 지운 뒤 즉시 다시 띄워(프리워밍) 다음 틱의 지연을 줄인다.
   */
  resetContext(): void {
    if (this.destroyed) return;
    try { this._process.stop(); } catch { /* ignore */ }
    if (this.pid) { unregisterSubProc(this.pid); this.pid = null; }
    this.resumeId = null;
    try { fs.rmSync(this.resumePath(), { force: true }); } catch { /* ignore */ }
    this.primed = false;
    this.spawnInFlight = false;
    this.setBusy(false);
    this._process = createProcess(this.provider);
    this.attachProcessListeners();
    // 프리워밍: 다음 dispatch가 콜드 스타트를 기다리지 않도록 미리 띄운다.
    try { this.start(); } catch (err) {
      console.warn(`[subagent:${this.sessionId}/${this.name}] reset 후 재시작 실패:`, err);
    }
  }
```

이를 위해 생성자의 `this._process.on(...)` 블록 전체를 `private attachProcessListeners(): void { ... }`로 추출하고, 생성자에서 `this.attachProcessListeners()`를 호출하도록 바꾼다. `_process.stop()`이 없으면 `git grep -n "stop\|kill" -- src/lib/ai-process-factory.ts`로 실제 종료 메서드 이름을 확인해 쓴다.

- [ ] **Step 2: 매니저에 `resetThread`를 추가한다**

`src/lib/subagent-manager.ts`:

```ts
  /** 스레드의 컨텍스트를 버리고 재prime 준비 상태로 만든다 (thread-loop 5단계). */
  resetThread(threadId: string): void {
    const inst = this.subs.get(threadId);
    if (!inst) return;
    try { inst.resetContext(); } catch (err) {
      console.error(`[subagent-manager:${this.sessionId}] resetThread ${threadId} 실패:`, err);
    }
  }
```

- [ ] **Step 3: typecheck + 기존 테스트 재실행**

```bash
npm run typecheck
npx tsx --test src/lib/subagent-instance.test.ts src/lib/subagent-manager.test.ts
```

Expected: 타입 에러 0, 테스트 PASS

- [ ] **Step 4: 커밋**

```bash
git add src/lib/subagent-instance.ts src/lib/subagent-manager.ts
git commit -m "feat(threads): 상태 기반 컨텍스트 리셋 + 프리워밍 스왑"
```

---

### Task 10: 세션 배선 + 메인 브리핑

**Files:**
- Modify: `src/lib/session-instance.ts`

**Interfaces:**
- Consumes: `ThreadLoop` (Task 8), `resolveAppMode` (Task 1)
- Produces: `SessionInstance.threadLoop: ThreadLoop | null`, `SessionInstance.appMode: AppModeConfig | null`

- [ ] **Step 1: 앱 모드를 해석하고 루프를 만든다**

`src/lib/session-instance.ts`에서 `this.subAgents = new SubAgentManager(...)` 바로 다음(생성자 안, 현재 331행 근처)에 필드를 추가한다. 먼저 클래스 필드 선언부(`readonly subAgents: SubAgentManager;` 근처)에:

```ts
  /** 앱 모드 설정. null이면 기존 채팅 중심 셸. */
  appMode: import("./app-mode").AppModeConfig | null = null;
  /** 앱 모드에서만 존재하는 스레드 루프 런타임. */
  threadLoop: import("./thread-loop").ThreadLoop | null = null;
```

세션 open 경로(`spawnAll`을 호출하는 곳 — `git grep -n "subAgents.spawnAll" -- src`로 찾는다) 바로 뒤에 루프 기동을 붙인다:

```ts
    // 앱 모드일 때만 스레드 루프를 띄운다. layout.app이 없으면 전부 기존 동작.
    const layout = this.readLayoutJson();
    this.appMode = resolveAppMode(layout);
    if (this.appMode) {
      const app = this.appMode;
      this.threadLoop = new ThreadLoop({
        sessionId: this.id,
        app,
        loopThreads: () => this.subAgents.loopThreads(),
        isBusy: (threadId) => this.subAgents.isBusy(threadId),
        dispatch: (threadId, task) => this.subAgents.dispatch(threadId, task, "auto"),
        applyOps: (ops) => this.subAgents.applyOps(ops, provider, model, effort),
        hasClients: () => hasSessionClients(this.id),
        resetThread: (threadId) => this.subAgents.resetThread(threadId),
        broadcast: (ev, data) => this.broadcast(ev, data),
      });
      this.threadLoop.start();
    } else if (this.threadLoop) {
      this.threadLoop.stop();
      this.threadLoop = null;
    }
```

`provider`/`model`/`effort`는 `spawnAll`에 넘기는 값과 같은 것을 쓴다. `readLayoutJson()`이 없으면 `session-config-io.ts`의 기존 레이아웃 읽기 함수를 쓴다 (`git grep -n "layout.json" -- src/lib/session-config-io.ts`).

`hasSessionClients`는 `src/lib/ws-server.ts`에 이미 있는지 확인하고 (`git grep -n "export function has" -- src/lib/ws-server.ts`), 없으면 추가한다:

```ts
/** 해당 세션에 바인딩된 WS 클라이언트가 하나라도 있는지. 스레드 루프의 자동 일시정지 판단용. */
export function hasSessionClients(sessionId: string): boolean {
  for (const c of clients) if (c.sessionId === sessionId) return true;
  return false;
}
```

(`clients`의 실제 이름·형태는 파일을 읽고 맞춘다.)

- [ ] **Step 2: `destroy()`에서 루프를 멈춘다**

`destroy()`의 `this.subAgents.destroyAll()` 바로 앞에:

```ts
    try { this.threadLoop?.stop(); } catch (err) { console.error(`[session:${this.id}] threadLoop.stop failed:`, err); }
    this.threadLoop = null;
```

- [ ] **Step 3: 메인 턴 시작 시 브리핑을 붙인다**

`sendMessage`에서 `const eventHeaders = this.flushEvents();` (현재 486행 근처)를 찾아 바로 뒤에 추가한다:

```ts
    // 앱 모드에서는 밀린 이벤트 재생이 아니라 현재 월드 상태를 붙인다 (spec §8.3).
    let appBriefing = "";
    if (this.threadLoop) {
      const brief = await this.threadLoop.briefMain();
      if (brief.trim()) appBriefing = `[WORLD]\n${brief}`;
    }
```

그리고 헤더를 합치는 지점에서 `eventHeaders`와 함께 `appBriefing`을 포함시킨다 (기존 조립 코드의 형태에 맞춰 빈 문자열은 제외하고 `\n`으로 잇는다). `autoResumeTurn` (582행 근처)에도 같은 처리를 넣는다.

- [ ] **Step 4: typecheck**

```bash
npm run typecheck
```

Expected: 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-instance.ts src/lib/ws-server.ts
git commit -m "feat(app-mode): 세션에 스레드 루프 배선 + 메인 턴 월드 브리핑"
```

---

### Task 11: 월드 파일 쓰기 가드

**Files:**
- Modify: `src/app/api/sessions/[id]/variables/route.ts`

**Interfaces:**
- Consumes: `resolveAppMode` (Task 1)
- Produces: 앱 모드에서 `?file=<worldFile>` PATCH가 403

- [ ] **Step 1: 가드를 추가한다**

`PROTECTED_FILES.has(fileName)` 검사 바로 뒤에 넣는다:

```ts
  // 앱 모드에서 월드 파일은 엔진만 쓴다 (spec §9). 앱/패널은 run_tool("<engine>", {action:"submit"})로
  // 가야 규칙이 step()에만 존재한다는 불변식이 유지된다.
  // 주의: tool 라우트의 PROTECTED_FILES에는 월드 파일을 넣지 않는다 — 넣으면 엔진 자신의 쓰기가 막힌다.
  try {
    const layoutRaw = readSessionJson(path.join(sessionDir, "layout.json"));
    const app = resolveAppMode(layoutRaw);
    if (app && fileName === app.worldFile) {
      return NextResponse.json(
        { error: `${fileName} is owned by the world engine — submit an intent instead` },
        { status: 403 },
      );
    }
  } catch { /* layout.json 없음/깨짐 → 가드 없이 진행 (기존 동작) */ }
```

import를 추가한다:

```ts
import { mutateSessionJson, applyPatch, readSessionJson } from "@/lib/session-state";
import { resolveAppMode } from "@/lib/app-mode";
```

- [ ] **Step 2: typecheck**

```bash
npm run typecheck
```

Expected: 타입 에러 0

- [ ] **Step 3: 커밋**

```bash
git add "src/app/api/sessions/[id]/variables/route.ts"
git commit -m "feat(app-mode): variables 라우트에서 월드 파일 쓰기 거부 (엔진 단독 writer)"
```

---

### Task 12: 앱 슬롯 컴포넌트

**Files:**
- Create: `src/components/AppSlot.tsx`
- Modify: `src/lib/use-panel-bridge.ts` (`stateChanged` 이벤트)

**Interfaces:**
- Consumes: `usePanelBridge` (`src/lib/use-panel-bridge.ts`), `dispatchBridgeEvent`
- Produces: `<AppSlot sessionId entry panelData />`

- [ ] **Step 1: 브리지 이벤트 타입을 넓힌다**

`src/lib/use-panel-bridge.ts`의 `BridgeEvent` 유니온에 추가:

```ts
type BridgeEvent = "turnStart" | "turnEnd" | "imageUpdated" | "stateChanged";
```

- [ ] **Step 2: `AppSlot`을 만든다**

`src/components/AppSlot.tsx`:

```tsx
"use client";

import { useRef, useEffect, useState } from "react";

interface AppSlotProps {
  sessionId: string;
  /** 세션 디렉토리 기준 진입 HTML 경로 (예: "app/index.html") */
  entry: string;
  /** 상태 스냅샷 — 바뀌면 stateChanged 이벤트로 앱에 밀어넣는다 (재렌더하지 않는다) */
  panelData?: Record<string, unknown>;
}

/**
 * 앱 모드의 메인 슬롯. PanelSlot과 shadow DOM 기법은 같지만 정책이 반대다:
 * **한 번만 마운트하고 다시는 innerHTML을 쓰지 않는다.** 상태 변경은 이벤트로만 전달되므로
 * 앱의 rAF 루프·캔버스 컨텍스트·이벤트 리스너가 살아남는다 (spec §4.1).
 */
export default function AppSlot({ sessionId, entry, panelData }: AppSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const mountedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // 1회 마운트: HTML을 가져와 shadow에 넣고 스크립트를 한 번 실행한다.
  useEffect(() => {
    if (mountedRef.current || !containerRef.current) return;
    mountedRef.current = true;
    const host = containerRef.current;
    const shadow = host.attachShadow({ mode: "open" });
    shadowRef.current = shadow;

    let cancelled = false;
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/files/`;

    (async () => {
      try {
        const res = await fetch(base + entry);
        if (!res.ok) throw new Error(`앱 진입 파일을 불러오지 못했습니다 (${res.status})`);
        const html = await res.text();
        if (cancelled) return;

        shadow.innerHTML = html;

        // 상대 경로 자산을 세션 파일 라우트로 돌린다.
        for (const el of Array.from(shadow.querySelectorAll<HTMLImageElement>("img[src]"))) {
          const src = el.getAttribute("src") || "";
          if (!/^(https?:|data:|\/)/.test(src)) el.setAttribute("src", base + src);
        }
        for (const el of Array.from(shadow.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet][href]"))) {
          const href = el.getAttribute("href") || "";
          if (!/^(https?:|data:|\/)/.test(href)) el.setAttribute("href", base + href);
        }

        // 스크립트는 DOM 삽입으로는 실행되지 않으므로 직접 평가한다. PanelSlot과 달리 단 한 번뿐이다.
        const scripts = Array.from(
          shadow.querySelectorAll<HTMLScriptElement>("script:not([type]), script[type='text/javascript'], script[type='module']"),
        );
        for (const s of scripts) {
          const src = s.getAttribute("src");
          let code = s.textContent || "";
          if (src) {
            const url = /^(https?:|data:|\/)/.test(src) ? src : base + src;
            const r = await fetch(url);
            if (!r.ok) throw new Error(`앱 스크립트를 불러오지 못했습니다: ${src} (${r.status})`);
            code = await r.text();
          }
          if (cancelled) return;
          // 앱 오류가 셸을 죽이지 않도록 격리한다 (iframe 대신의 에러 격리, spec §4.2).
          try {
            new Function("shadow", "sessionId", code)(shadow, sessionId);
          } catch (err) {
            console.error("[AppSlot] 앱 스크립트 실행 오류:", err);
            setError(`앱 스크립트 오류: ${(err as Error).message}`);
          }
        }

        // 마운트 완료 후 최초 상태를 한 번 밀어준다.
        window.dispatchEvent(new CustomEvent("__bridge_evt:stateChanged", { detail: panelData ?? {} }));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => { cancelled = true; };
    // entry/sessionId가 바뀌면 그건 다른 세션이므로 페이지가 통째로 다시 마운트된다.
    // panelData는 의도적으로 의존성에서 제외한다 — 재마운트하면 앱 상태가 날아간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, entry]);

  // 상태 변경은 재렌더가 아니라 이벤트로만 전달한다.
  useEffect(() => {
    if (!mountedRef.current) return;
    window.dispatchEvent(new CustomEvent("__bridge_evt:stateChanged", { detail: panelData ?? {} }));
  }, [panelData]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {error && (
        <div className="absolute left-0 right-0 top-0 z-10 bg-red-900/80 px-3 py-2 text-xs text-white">
          {error}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
```

- [ ] **Step 3: typecheck + lint**

```bash
npm run typecheck
```

Expected: 타입 에러 0

- [ ] **Step 4: 커밋**

```bash
git add src/components/AppSlot.tsx src/lib/use-panel-bridge.ts
git commit -m "feat(app-mode): AppSlot — 1회 마운트 shadow DOM + stateChanged 이벤트"
```

---

### Task 13: 페이지 배선 (앱 모드 분기 + 챗 강등)

**Files:**
- Modify: `src/app/chat/[sessionId]/page.tsx`

**Interfaces:**
- Consumes: `AppSlot` (Task 12), `resolveAppMode` (Task 1)
- Produces: 앱 모드에서 메인 영역이 `AppSlot`, 챗은 `chatMode`에 따라 숨김/독/기본

- [ ] **Step 1: 앱 모드를 해석한다**

`const rawPlacement = layout?.panels?.placement || {};` (848행 근처) 바로 앞에 추가:

```tsx
  // 앱 모드: layout.app이 있으면 메인 영역을 앱이 차지하고 챗이 강등된다.
  // 없으면 null이라 아래 분기가 전부 기존 경로로 떨어진다.
  const appMode = resolveAppMode(layout);
```

import를 추가한다:

```tsx
import AppSlot from "@/components/AppSlot";
import { resolveAppMode } from "@/lib/app-mode";
```

- [ ] **Step 2: 메인 영역을 분기한다**

채팅 스트림(`ChatMessages` + `ChatInput`)을 감싸는 메인 컬럼 JSX를 찾는다 (`git grep -n "ChatMessages" -- "src/app/chat/[sessionId]/page.tsx"`). 그 컬럼을 다음 구조로 감싼다:

```tsx
{appMode ? (
  <div className="flex h-full min-w-0 flex-1 flex-col">
    <div className={appMode.chatMode === "dock" ? "min-h-0 flex-1" : "h-full"}>
      <AppSlot sessionId={sessionId} entry={appMode.entry} panelData={panelData} />
    </div>
    {appMode.chatMode === "dock" && (
      <div className="h-[38%] min-h-[180px] shrink-0 overflow-hidden border-t border-border">
        {/* 기존 채팅 컬럼 JSX를 여기로 */}
      </div>
    )}
  </div>
) : (
  <>{/* 기존 채팅 컬럼 JSX */}</>
)}
```

중복을 피하려면 기존 채팅 컬럼을 `const chatColumn = (<>...</>);`로 먼저 뽑아 두고 양쪽에서 `{chatColumn}`을 쓴다. `chatMode === "hidden"`이면 챗을 렌더하지 않는다.

- [ ] **Step 3: typecheck**

```bash
npm run typecheck
```

Expected: 타입 에러 0

- [ ] **Step 4: 기존 세션이 깨지지 않는지 육안 확인**

개발 서버를 띄우고 **앱 모드가 아닌** 기존 세션을 연다.

```bash
npm run dev
```

브라우저에서 기존 페르소나 세션을 열어 채팅·패널이 평소와 같은지 확인한다 (Ctrl+Shift+R로 하드 리프레시).

- [ ] **Step 5: 커밋**

```bash
git add "src/app/chat/[sessionId]/page.tsx"
git commit -m "feat(app-mode): 채팅 페이지에 앱 슬롯 분기 + 챗 강등(normal/dock/hidden)"
```

---

### Task 14: StatusBar 일시정지/속도 컨트롤

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx` (props 전달)

**Interfaces:**
- Consumes: `threads:status` WS 이벤트 (Task 8의 `emitStatus`)
- Produces: StatusBar에 스레드 상태 칩 + 일시정지/속도 버튼

- [ ] **Step 1: 루프 제어 API를 붙인다**

새 라우트를 만들지 않기로 했으므로, 기존 WS 채널을 쓴다. `src/lib/ws-server.ts`의 메시지 핸들러에서 `chat:cancel` 같은 기존 케이스를 찾아 옆에 추가한다:

```ts
      case "threads:control": {
        const inst = getSessionInstance(String(msg.sessionId ?? ""));
        const loop = inst?.threadLoop;
        if (!loop) break;
        if (msg.action === "pause") loop.setPaused(true);
        else if (msg.action === "resume") loop.setPaused(false);
        else if (msg.action === "speed") loop.setSpeed(Number(msg.value));
        break;
      }
```

- [ ] **Step 2: StatusBar에 컨트롤을 추가한다**

`src/components/StatusBar.tsx`에 props를 추가하고 (기존 props 스타일을 따른다):

```tsx
  /** 앱 모드에서만 전달된다. 없으면 스레드 컨트롤을 렌더하지 않는다. */
  threadStatus?: { running: boolean; paused: boolean; speed: number; threads: number } | null;
  onThreadControl?: (action: "pause" | "resume" | "speed", value?: number) => void;
```

렌더에 칩을 추가한다:

```tsx
{threadStatus && (
  <div className="flex items-center gap-1.5 text-xs text-text-dim">
    <span title="살아있는 스레드 수">스레드 {threadStatus.threads}</span>
    <button
      type="button"
      className="rounded px-1.5 py-0.5 hover:bg-surface-light"
      onClick={() => onThreadControl?.(threadStatus.paused ? "resume" : "pause")}
      aria-label={threadStatus.paused ? "월드 재개" : "월드 일시정지"}
    >
      {threadStatus.paused ? "재개" : "일시정지"}
    </button>
    <select
      className="rounded bg-transparent px-1 py-0.5"
      value={String(threadStatus.speed)}
      onChange={(e) => onThreadControl?.("speed", Number(e.target.value))}
      aria-label="월드 진행 속도"
    >
      <option value="0.5">0.5×</option>
      <option value="1">1×</option>
      <option value="2">2×</option>
      <option value="4">4×</option>
    </select>
  </div>
)}
```

- [ ] **Step 3: 페이지에서 상태를 구독해 전달한다**

`page.tsx`에서 `threads:status` WS 이벤트를 받아 state에 담고 StatusBar에 넘긴다. 기존 WS 이벤트 구독 패턴(`subagent:status` 등)을 그대로 따른다.

- [ ] **Step 4: typecheck**

```bash
npm run typecheck
```

Expected: 타입 에러 0

- [ ] **Step 5: 커밋**

```bash
git add src/components/StatusBar.tsx "src/app/chat/[sessionId]/page.tsx" src/lib/ws-server.ts
git commit -m "feat(app-mode): StatusBar 스레드 일시정지/속도 컨트롤"
```

---

### Task 15: lint-data 검증 + 문서 전파

**Files:**
- Modify: `scripts/lint-data.mjs`
- Modify: `docs/codebase-map.md`, `docs/architecture.md`, `docs/data-model.md`, `docs/frontend.md`, `docs/session-lifecycle.md`, `docs/change-propagation.md`

**Interfaces:**
- Consumes: 없음
- Produces: `npm run verify` 통과

- [ ] **Step 1: `lint-data.mjs`에 앱 모드 검증을 추가한다**

layout.json을 검사하는 블록(145행 근처, `data.panels.placement`를 보는 곳) 옆에 추가:

```js
      // 앱 모드 설정 검증 (docs/specs/2026-09-12-app-mode-platform-design.md)
      if (isObject(data.app)) {
        if (typeof data.app.entry !== "string" || !data.app.entry.trim()) {
          issue("error", "layout-app-entry", file, "layout.app.entry가 없거나 문자열이 아님");
        }
        for (const key of ["engine", "worldFile"]) {
          const v = data.app[key];
          if (v !== undefined && (typeof v !== "string" || /[\\/]|\.\./.test(v))) {
            issue("error", "layout-app-path", file, `layout.app.${key}는 경로 구분자 없는 단일 이름이어야 함`);
          }
        }
      }
      if (isObject(data.chat) && data.chat.mode !== undefined
          && !["normal", "dock", "hidden"].includes(data.chat.mode)) {
        issue("warn", "layout-chat-mode", file,
          `chat.mode "${data.chat.mode}"는 알 수 없는 값 (허용: normal, dock, hidden)`);
      }
```

- [ ] **Step 2: 문서를 갱신한다**

- `docs/codebase-map.md` §2에 행 추가:

```markdown
| 앱 모드, 월드, 스레드 루프, NPC가 안 움직임 | 앱 모드 | `src/lib/app-mode.ts` → `src/lib/thread-loop.ts` → `src/lib/world-engine.ts` → `src/lib/thread-registry.ts` → `src/components/AppSlot.tsx` | `resolveAppMode`, `selectDueThreads`, `runExclusiveSession`, `threads:status`, `[WORLD]` | [앱 모드 설계](specs/2026-09-12-app-mode-platform-design.md) | 세션 런타임 + 패널 시스템 | hot-path |
```

- `docs/architecture.md`의 Core Libraries 표에 `app-mode.ts` / `world-engine.ts` / `thread-manifest.ts` / `thread-registry.ts` / `thread-loop.ts` 행 추가
- `docs/frontend.md`의 Components 표에 `AppSlot.tsx` 행 추가
- `docs/data-model.md`에 `world.json` / `threads.json` / `app/` / `roles/` 추가
- `docs/session-lifecycle.md`에 앱 모드 절(틱 순서·예산·컨텍스트 리셋) 추가
- `docs/change-propagation.md`에 "앱 모드/스레드 루프 변경" 행 추가

- [ ] **Step 3: 문서 게이트를 돌린다**

```bash
npm run check:docs
```

Expected: 0 errors — 실패하면 누락된 파일의 문서 행을 채운다.

- [ ] **Step 4: 전체 검증**

```bash
npm run verify
```

Expected: 통과. `smoke`가 로그인 rate-limit(429)로 WARN을 내면 1분 기다렸다 다시 돌린다 (분당 4회 초과 금지).

- [ ] **Step 5: 커밋**

```bash
git add scripts/lint-data.mjs docs/
git commit -m "docs(app-mode): 앱 모드 문서 전파 + lint-data 검증"
```

---

### Task 16: 스텁 앱 + 라이브 스모크

**Files:**
- Create: `scripts/fixtures/app-mode-stub/` (레포 안의 픽스처 — `data/`에 두지 않는다)

**Interfaces:**
- Consumes: 전체
- Produces: 수동으로 페르소나에 복사해 돌릴 수 있는 최소 월드

- [ ] **Step 1: 스텁 엔진을 만든다**

`scripts/fixtures/app-mode-stub/tools/world.js`:

```js
/**
 * 앱 모드 검증용 최소 월드 엔진.
 * 규칙 하나: 자원 "밀"을 집는다. 같은 틱에 둘 이상이 노리면 전원 기각(경합).
 * 상태는 전부 world.json — 엔진은 메모리 상태를 가질 수 없다 (require.cache가 매 호출 purge).
 */
module.exports = async function world(ctx, args) {
  const w = (ctx.data && ctx.data.world) || {};
  const state = {
    tick: w.tick || 0,
    wheat: typeof w.wheat === "number" ? w.wheat : 5,
    actors: w.actors || {},
    intents: w.intents || {},
    feedback: w.feedback || {},
  };

  switch (args.action) {
    case "observe": {
      const id = String(args.observerId || "");
      const me = state.actors[id] || { held: 0, memory: "" };
      const fb = state.feedback[id];
      const lines = [
        `[월드] tick=${state.tick} 남은 밀=${state.wheat}`,
        `[나] id=${id} 보유=${me.held} 기억=${me.memory || "(없음)"}`,
        fb ? `[직전 결과] ${fb}` : "",
        id === "main" ? "" : '밀을 집으려면 run_tool("world", { action: "submit", observerId: "<네 id>", intent: { type: "take_wheat" } }) 를 호출하라. 한 턴에 한 번만.',
      ].filter(Boolean);
      return { result: { text: lines.join("\n") } };
    }

    case "submit": {
      const id = String(args.observerId || "");
      if (!id) return { result: { ok: false, error: "observerId 누락" } };
      const seq = state.tick * 1000 + Object.keys(state.intents).length;
      // 키 있는 객체 + $merge:"deep" — 배열이면 동시 제출이 서로를 덮어쓴다 (spec §5.6)
      return {
        data: {
          world: {
            $merge: "deep",
            intents: { [`${id}__${seq}`]: { seq, at: Date.now(), observerId: id, intent: args.intent } },
          },
        },
        result: { ok: true },
      };
    }

    case "step": {
      const entries = Object.entries(state.intents).sort((a, b) => a[1].seq - b[1].seq);
      const feedback = {};
      const actors = { ...state.actors };
      let wheat = state.wheat;

      const takers = entries.filter(([, v]) => v.intent && v.intent.type === "take_wheat");
      if (takers.length > 1) {
        for (const [, v] of takers) feedback[v.observerId] = "기각: 같은 틱에 경합이 발생했다.";
      } else {
        for (const [, v] of takers) {
          if (wheat <= 0) { feedback[v.observerId] = "기각: 밀이 없다."; continue; }
          wheat -= 1;
          const prev = actors[v.observerId] || { held: 0, memory: "" };
          actors[v.observerId] = { ...prev, held: prev.held + 1 };
          feedback[v.observerId] = "성공: 밀 1개를 집었다.";
        }
      }
      for (const [, v] of entries) {
        if (v.intent && v.intent.memory) {
          const prev = actors[v.observerId] || { held: 0, memory: "" };
          actors[v.observerId] = { ...prev, memory: String(v.intent.memory).slice(0, 200) };
        }
      }

      return {
        data: {
          world: {
            $merge: "deep",
            tick: state.tick + 1,
            wheat,
            actors,
            feedback,
            // 소비한 의도 키를 제거한다 (unsetPath dot-path)
            $unset: entries.map(([k]) => `intents.${k}`),
          },
        },
        result: { note: `tick ${state.tick} → ${state.tick + 1}, 밀 ${state.wheat} → ${wheat}` },
      };
    }

    case "snapshot":
      return { result: { tick: state.tick, wheat: state.wheat, actors: state.actors } };

    default:
      return { result: { error: `알 수 없는 action: ${args.action}` } };
  }
};
```

> **확인됨**: tool 라우트는 `result.data`의 각 항목을 `applyPatch(current, patch)`로 넘기므로, `data.world` 안의 `$unset`/`$merge`가 곧 그 패치의 최상위 키다. dot-path는 `world.json` 루트 기준(`intents.<key>`)이며 `unsetPath`가 처리한다. 별도 대응이 필요 없다.

- [ ] **Step 2: 나머지 픽스처를 만든다**

`scripts/fixtures/app-mode-stub/layout.json`:

```json
{
  "app": { "entry": "app/index.html", "engine": "world", "worldFile": "world.json" },
  "chat": { "mode": "dock" }
}
```

`scripts/fixtures/app-mode-stub/subagents.json`:

```json
{
  "version": 2,
  "roles": [
    {
      "name": "keeper",
      "instructions": "roles/keeper.md",
      "scope": "global",
      "loop": { "mode": "loop", "intervalMs": 15000, "resetEveryTurns": 10 },
      "emitSummary": false
    },
    {
      "name": "gatherer",
      "instructions": "roles/gatherer.md",
      "scope": "local",
      "loop": { "mode": "loop", "intervalMs": 10000, "resetEveryTurns": 10 },
      "emitSummary": false
    }
  ],
  "threads": [
    { "threadId": "keeper_1", "role": "keeper", "params": { "entityId": "keeper_1" } },
    { "threadId": "gatherer_1", "role": "gatherer", "params": { "entityId": "gatherer_1" } },
    { "threadId": "gatherer_2", "role": "gatherer", "params": { "entityId": "gatherer_2" } }
  ]
}
```

`scripts/fixtures/app-mode-stub/roles/gatherer.md`:

```markdown
너는 밀을 모으는 행위자다. 매 관측마다 판단하고, 밀을 집고 싶으면 의도를 한 번 제출한다.
제출 후에는 짧게 한 줄만 답하고 턴을 끝내라. 서사를 쓰지 마라.
[THREAD] 블록의 entityId가 네 observerId다.
```

`scripts/fixtures/app-mode-stub/roles/keeper.md`:

```markdown
너는 월드 관리자다. 캐릭터를 연기하지 않는다.
관측을 읽고 이상(밀이 0이 되었다 등)이 있으면 한 줄로 기록만 남겨라. 의도를 제출하지 않아도 된다.
```

`scripts/fixtures/app-mode-stub/app/index.html`:

```html
<style>
  :host { display: block; height: 100%; }
  .wrap { padding: 16px; font-family: system-ui, sans-serif; color: var(--text, #e0e0e0); }
  .tile { display: inline-block; margin: 2px; padding: 6px 10px; border: 1px solid var(--border, #444); border-radius: 4px; }
  button { margin-top: 12px; }
</style>
<div class="wrap">
  <h2>스텁 월드</h2>
  <div id="hud">로딩…</div>
  <div id="actors"></div>
  <button id="take">밀 집기 (유저)</button>
  <p id="log" style="opacity:.7;font-size:12px"></p>
</div>
<script>
  // 1회 마운트 검증: 이 카운터는 상태가 바뀌어도 리셋되면 안 된다.
  let renders = 0;
  const hud = shadow.getElementById("hud");
  const actorsEl = shadow.getElementById("actors");
  const log = shadow.getElementById("log");

  function draw(world) {
    renders += 1;
    hud.textContent = `tick=${world.tick ?? "?"} 밀=${world.wheat ?? "?"} (갱신 ${renders}회, 재마운트 없음)`;
    actorsEl.innerHTML = Object.entries(world.actors || {})
      .map(([id, a]) => `<span class="tile">${id}: ${a.held}</span>`).join("");
  }

  window.addEventListener("__bridge_evt:stateChanged", (e) => {
    const d = e.detail || {};
    draw(d.world || {});
  });

  shadow.getElementById("take").addEventListener("click", async () => {
    const r = await window.__panelBridge.runTool("world", {
      action: "submit", observerId: "user", intent: { type: "take_wheat" },
    });
    log.textContent = "제출: " + JSON.stringify(r);
  });
</script>
```

> `__panelBridge.runTool`이 없다면 `src/lib/use-panel-bridge.ts`에 추가한다:
> ```ts
>       async runTool(name: string, args: Record<string, unknown>) {
>         if (!sessionId) return;
>         const res = await fetch(`/api/sessions/${sessionId}/tools/${encodeURIComponent(name)}`, {
>           method: "POST",
>           headers: { "Content-Type": "application/json" },
>           body: JSON.stringify({ args }),
>         });
>         return res.json();
>       },
> ```

`scripts/fixtures/app-mode-stub/world.json`:

```json
{ "tick": 0, "wheat": 5, "actors": {}, "intents": {}, "feedback": {} }
```

`scripts/fixtures/app-mode-stub/README.md`에 사용법을 적는다: 페르소나 디렉토리에 복사 → 세션 생성 → Open.

- [ ] **Step 3: 스텁을 실제 페르소나로 설치한다**

```bash
npm run dev
```

새 페르소나를 만들고 (기존 페르소나를 건드리지 않는다), `scripts/fixtures/app-mode-stub/`의 내용을 그 페르소나 디렉토리에 복사한 뒤 세션을 생성해 Open한다.

- [ ] **Step 4: 스모크 체크리스트를 실행한다**

- [ ] 스레드 3개가 뜨고 각자 주기로 턴을 돈다
- [ ] 의도가 적용되어 `world.json`의 `wheat`이 줄고 `actors[*].held`가 는다
- [ ] 같은 틱 경합 시 양쪽 모두 기각되고 사유가 다음 관측에 실린다
- [ ] 앱 HUD의 "갱신 N회, 재마운트 없음" 카운터가 **리셋되지 않는다** (1회 마운트 검증)
- [ ] StatusBar 일시정지를 누르면 틱이 멈추고 재개하면 다시 돈다
- [ ] 브라우저 탭을 닫으면(=WS 끊김) 루프가 멈춘다 — `world.json`의 `tick`이 더 안 오른다
- [ ] `resetEveryTurns: 10` 도달 후에도 스레드가 자기 `entityId`로 계속 행동한다 (정체성 유지)
- [ ] 세션을 닫았다 다시 Open해도 `threads.json`의 스레드가 복원된다
- [ ] 앱에서 `__panelBridge.updateData("world", {...})`를 콘솔로 시도하면 403이 난다
- [ ] 바쁜 스레드를 despawn시켜도(엔진이 `result.threads.despawn` 반환) 고아 PID가 `data/.runtime/subagent-procs.json`에 남지 않는다
- [ ] **기존 페르소나 세션이 무영향이다** — 채팅·패널·모달이 평소대로 동작

- [ ] **Step 5: 결과를 기록하고 커밋한다**

돌리지 못한 항목은 `HANDOVER.md` §4에 등재한다.

```bash
git add scripts/fixtures/app-mode-stub HANDOVER.md
git commit -m "test(app-mode): 스텁 월드 픽스처 + 라이브 스모크 체크리스트"
```

---

## Self-Review

**스펙 커버리지:**

| 스펙 절 | 구현 Task |
|---|---|
| §4.1 렌더 정책 (1회 마운트) | Task 12 |
| §4.3 브리지·챗 강등 | Task 12, 13 |
| §4.4 정적 서빙 | Task 2 |
| §5.1 엔진 계약·호출 경로 | Task 3 |
| §5.2 액션 4개 | Task 3 (+ Task 16 스텁이 실제 구현 예시) |
| §5.4 계층 관측·`since` | Task 3 (`observe` opts), Task 8 (`lastObservedAt`) |
| §5.5 2층 락 | Task 3 |
| §5.6 키 있는 의도 큐 | Task 16 스텁 엔진 + Task 4 `THREAD_ID_RE`(dot 금지) |
| §6 역할/스레드·하위호환·정체성 | Task 4, 6, 7 |
| §6.4 라이브 레지스트리 | Task 5 |
| §7.0 틱 순서 | Task 8 |
| §7.1 틱 예산 | Task 8 (+ Task 14 UI) |
| §7.2 상태 기반 리셋·프리워밍·지터 | Task 8, 9 |
| §8.2 메인 깨우기 | Task 10 (브리핑) — 계약은 역할 지침(Task 16 픽스처) |
| §8.3 큐 우회 | Task 10 |
| §9 단일 writer 강제 | Task 11 |
| §10 데이터 모델 | Task 1, 4, 5 |
| §12 검증 | Task 15, 16 |

**타입 일관성 확인:** `AppModeConfig`(Task 1) → `ThreadLoopDeps.app`(Task 8) → `session-instance`(Task 10) 일치. `ThreadSpawnRequest`(Task 3) → `applyThreadOps`(Task 5) → `SubAgentManager.applyOps`(Task 7) 일치. `RoleDef`(Task 4) → `loopThreads()`(Task 7) → `ThreadLoopDeps.loopThreads`(Task 8) 일치.

**알려진 위험:** Task 10의 `readLayoutJson`/`hasSessionClients`, Task 9의 프로세스 종료 메서드 이름은 실제 파일을 읽고 맞춰야 한다 — 각 Step에 grep 명령을 적어 두었다.
