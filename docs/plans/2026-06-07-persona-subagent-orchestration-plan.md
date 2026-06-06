# 페르소나 서브에이전트 오케스트레이션 구현 플랜 (v1: 코어 백본)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 페르소나 세션이 메인 서사 인스턴스 1개 + 빌더에서 정의한 상주(always-on) 전문화 서브 인스턴스 N개를 갖고, 훅 자동/메인 명시 위임으로 서브에 작업을 디스패치하며, 서브가 상태를 직접 액추에이트하고 결과 요약을 비동기 이벤트 큐로 다음 유저 턴에 합류시킨다.

**Architecture:** 부모 소유 모델 — `SessionInstance`가 `SubAgentManager`를 보유하고, 매니저가 `subagents.json` 매니페스트를 읽어 서브별 `SubAgentInstance`(경량 AIProcess 래퍼, PanelEngine 없음)를 spawn/관리한다. 서브는 세션 dir를 cwd로 공유하고 기존 MCP 툴셋으로 상태를 변경하며, `report_to_main` MCP 툴로 `[SUB:name]` 헤더를 메인 이벤트 큐(`pending-events.json`)에 적재한다. 디스패치는 `on-assistant.js`의 `dispatch[]`(코어 처리) 또는 메인의 `bridge_delegate` MCP 툴 → 신규 dispatch 라우트로 들어온다.

**Tech Stack:** TypeScript(strict), Next.js 15 App Router, 커스텀 `server.ts`, EventEmitter 기반 provider 프로세스(`claude -p` 등), 파일 기반 상태(`data/sessions/`), MCP(`claude-play-mcp-server.mjs`).

**테스트 주의:** 이 repo는 테스트 프레임워크가 없다(CLAUDE.md). 따라서 각 태스크의 검증은 **(1) `npx tsc --noEmit` 그린 → (2) 해당되면 작은 node 스모크 스크립트 → (3) 커밋**으로 한다. 통합 검증은 마지막에 dev 서버 수동 스모크로 한다. `npm run build`는 라이브 `.next`를 건드리므로 최종 단계에서만 실행한다.

**브랜치:** 작업은 `feat/persona-subagent-orchestration`(스펙 커밋이 이미 올라간 브랜치)에서 진행한다.

**참조 스펙:** [docs/specs/2026-06-07-persona-subagent-orchestration-design.md](../specs/2026-06-07-persona-subagent-orchestration-design.md)

---

## 파일 구조 (생성/수정 맵)

**신규 파일**
- `src/lib/ai-process-factory.ts` — `AIProcess` 타입 + `createProcess()` 추출 (순환참조 차단)
- `src/lib/subagent-manifest.ts` — 매니페스트 타입·로더·검증
- `src/lib/subagent-instance.ts` — 서브 1개 런타임 (경량 프로세스 래퍼)
- `src/lib/subagent-manager.ts` — 세션당 서브 spawn/생존/정리/라우팅
- `src/lib/subagent-registry.ts` — 서브 PID 영속화(고아 reap)
- `src/app/api/sessions/[id]/subagents/[name]/dispatch/route.ts` — 디스패치 진입 라우트

**수정 파일**
- `src/lib/session-instance.ts` — factory import 변경; `subManager` 보유; `runAssistantHooks`에 `dispatch[]` 처리; `destroy()`에 서브 연쇄 정리
- `src/app/api/sessions/[id]/open/route.ts` — 메인 spawn 직후 서브 spawn 트리거
- `src/lib/session-state.ts` — per-file async 뮤텍스로 mutate 직렬화
- `src/mcp/claude-play-mcp-server.mjs` — `bridge_delegate` + `report_to_main` 툴
- `src/lib/session-manager.ts` — create/mirror SKIP_FILES에 서브 산출물 규칙 추가
- `data/personas/*/.gitignore` 템플릿 생성 로직 (publish 제외) — 해당 위치 확인 후 `subagents/*/history.json` 류 추가
- `docs/session-lifecycle.md`, `docs/architecture.md`, `docs/data-model.md`, `docs/change-propagation.md`

---

## Phase A — 기반

### Task 1: 프로세스 팩토리 추출 (`ai-process-factory.ts`)

서브가 `createProcess`를 재사용하되 `session-instance.ts` ↔ `subagent-*` 순환참조를 피하기 위해 팩토리를 별도 모듈로 옮긴다.

**Files:**
- Create: `src/lib/ai-process-factory.ts`
- Modify: `src/lib/session-instance.ts:156` (타입), `src/lib/session-instance.ts:169-175` (함수)

- [ ] **Step 1: 팩토리 모듈 생성**

`src/lib/ai-process-factory.ts`:
```typescript
import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { GeminiProcess } from "./gemini-process";
import { KimiProcess } from "./kimi-process";
import { AntigravityProcess } from "./antigravity-process";
import { AIProvider } from "./ai-provider";

/** Union of all provider process classes. All share the same EventEmitter shape
 *  (message/status/error/sessionId/exit). */
export type AIProcess =
  | ClaudeProcess
  | CodexProcess
  | GeminiProcess
  | KimiProcess
  | AntigravityProcess;

/** Construct a provider-specific process. Provider is locked at session/sub creation. */
export function createProcess(provider: AIProvider): AIProcess {
  if (provider === "codex") return new CodexProcess();
  if (provider === "gemini") return new GeminiProcess();
  if (provider === "kimi") return new KimiProcess();
  if (provider === "antigravity") return new AntigravityProcess();
  return new ClaudeProcess();
}
```

- [ ] **Step 2: session-instance.ts에서 기존 정의 제거하고 import로 교체**

`src/lib/session-instance.ts`에서 기존 import 블록 부근(파일 상단 import들 사이)에 추가:
```typescript
import { AIProcess, createProcess } from "./ai-process-factory";
```
그리고 기존 `export type AIProcess = ...`(line 156 부근)과 `function createProcess(...)`(line 169-175)를 **삭제**한다. (기존에 `AIProcess`를 다른 파일이 `session-instance`에서 import 중이면, 하위호환을 위해 `export { AIProcess, createProcess } from "./ai-process-factory";` 재export 한 줄을 남긴다.)

- [ ] **Step 3: 재export 사용처 확인**

Run: `grep -rn "from \"./session-instance\"" src | grep -i "AIProcess\|createProcess"`
Expected: 결과가 있으면 Step 2의 재export 라인을 유지, 없으면 불필요.

- [ ] **Step 4: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS (에러 0). 순환참조/누락 import 없음 확인.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/ai-process-factory.ts src/lib/session-instance.ts
git commit -m "refactor(process): extract AIProcess/createProcess to ai-process-factory"
```

---

### Task 2: 매니페스트 타입·로더·검증 (`subagent-manifest.ts`)

**Files:**
- Create: `src/lib/subagent-manifest.ts`

- [ ] **Step 1: 모듈 생성**

`src/lib/subagent-manifest.ts`:
```typescript
import * as fs from "fs";
import * as path from "path";
import { AIProvider } from "./ai-provider";

export const MAX_SUBAGENTS = Number(process.env.SUBAGENT_MAX) > 0
  ? Number(process.env.SUBAGENT_MAX)
  : 6;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROVIDERS: AIProvider[] = ["claude", "codex", "gemini", "kimi", "antigravity"];

export interface SubAgentDef {
  name: string;                          // [a-z0-9-], unique, used as dir name
  role: string;                          // human description
  provider: AIProvider;                  // penta-runtime
  model?: string;                        // provider model id (optional → provider default)
  effort?: string;                       // claude/codex effort (optional)
  instructions: string;                  // relative path under subagents/{name}/, e.g. "instructions.md"
  delegable: boolean;                    // callable via bridge_delegate
  autoTrigger: "onAssistantTurn" | "none";
  autoTriggerTask?: string;              // default task when autoTrigger === "onAssistantTurn"
  emitSummary: boolean;                  // sub should report_to_main on completion
  writes?: string[];                     // advisory only in v1 (doc), not enforced
}

export interface SubAgentManifest {
  version: number;
  subagents: SubAgentDef[];
}

const EMPTY: SubAgentManifest = { version: 1, subagents: [] };

/** Read + validate subagents.json from a dir. Returns EMPTY when absent.
 *  Throws Error with a readable message on a malformed/invalid manifest. */
export function loadSubAgentManifest(dir: string): SubAgentManifest {
  const fp = path.join(dir, "subagents.json");
  if (!fs.existsSync(fp)) return EMPTY;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch (err) {
    throw new Error(`subagents.json parse error: ${(err as Error).message}`);
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): SubAgentManifest {
  if (!raw || typeof raw !== "object") throw new Error("subagents.json: root must be an object");
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.subagents) ? obj.subagents : [];
  if (list.length > MAX_SUBAGENTS) {
    throw new Error(`subagents.json: too many subagents (${list.length} > cap ${MAX_SUBAGENTS})`);
  }
  const seen = new Set<string>();
  const subagents: SubAgentDef[] = list.map((entry, i) => {
    const e = (entry || {}) as Record<string, unknown>;
    const name = String(e.name ?? "");
    if (!NAME_RE.test(name)) throw new Error(`subagents[${i}]: invalid name "${name}" (expect ${NAME_RE})`);
    if (seen.has(name)) throw new Error(`subagents[${i}]: duplicate name "${name}"`);
    seen.add(name);
    const provider = String(e.provider ?? "claude") as AIProvider;
    if (!PROVIDERS.includes(provider)) throw new Error(`subagents[${i}]: invalid provider "${provider}"`);
    const autoTrigger = e.autoTrigger === "onAssistantTurn" ? "onAssistantTurn" : "none";
    return {
      name,
      role: String(e.role ?? ""),
      provider,
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
  });
  return { version: typeof obj.version === "number" ? obj.version : 1, subagents };
}
```

- [ ] **Step 2: 스모크 스크립트로 검증**

`scratch/smoke-manifest.mjs` 임시 생성 후 실행:
```javascript
// scratch/smoke-manifest.mjs
import { validateManifest } from "../src/lib/subagent-manifest.ts"; // run via tsx
const ok = validateManifest({ version: 1, subagents: [
  { name: "panel-updater", role: "x", provider: "claude", instructions: "instructions.md" },
]});
console.log("ok:", JSON.stringify(ok.subagents[0]));
try { validateManifest({ subagents: [{ name: "Bad Name", provider: "claude" }] }); console.error("FAIL: should have thrown"); }
catch (e) { console.log("rejected as expected:", e.message); }
```
Run: `npx tsx scratch/smoke-manifest.mjs`
Expected: 첫 줄 `ok: {...delegable:true,autoTrigger:"none"...}`, 둘째 줄 `rejected as expected: subagents[0]: invalid name "Bad Name" ...`

- [ ] **Step 3: tsc 검증 + 스모크 정리**

Run: `npx tsc --noEmit` → PASS. 그 후 `rm scratch/smoke-manifest.mjs`.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/subagent-manifest.ts
git commit -m "feat(subagents): manifest types, loader and validation"
```

---

## Phase B — 런타임

### Task 3: 동시성 — per-file mutate 뮤텍스 (`session-state.ts`)

메인 훅(`mutateSessionJsonSync`)과 서브가 트리거한 라우트 쓰기(`mutateSessionJson`)가 **같은 서버 프로세스 안에서** 동일 파일을 동시 read-modify-write 하면 lost update가 난다. 파일 경로별 async 직렬화 게이트를 추가한다.

**Files:**
- Modify: `src/lib/session-state.ts:124-186` (mutate helpers 부근)

- [ ] **Step 1: per-path 큐 추가**

`src/lib/session-state.ts`의 `atomicWriteJsonSync` 정의 위(또는 mutate 함수들 위)에 추가:
```typescript
/** Serialize read-modify-write per file path within this process. Concurrent
 *  mutateSessionJson(Sync) calls to the same file would otherwise interleave
 *  (read-read-write-write → lost update). Now-resident main + N sub-agents all
 *  funnel variable writes through the one server process, so an in-process gate
 *  is sufficient. */
const _mutateChains = new Map<string, Promise<unknown>>();

function runExclusive<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = _mutateChains.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  // Keep the chain alive but don't leak rejections into the next link.
  _mutateChains.set(key, next.catch(() => undefined));
  // Best-effort cleanup when this is the tail.
  next.finally(() => {
    if (_mutateChains.get(key) === next.catch(() => undefined)) _mutateChains.delete(key);
  }).catch(() => undefined);
  return next;
}
```
(파일 상단에 `import * as path from "path";`가 이미 있는지 확인 — 없으면 추가.)

- [ ] **Step 2: async mutate를 게이트로 감싸기**

기존 `mutateSessionJson`(line 173-186)의 본문을 `runExclusive`로 감싼다:
```typescript
export async function mutateSessionJson(
  filePath: string,
  transform: (current: Dict) => Dict,
): Promise<PatchResult> {
  return runExclusive(filePath, async () => {
    const p = prepareMutation(filePath, transform);
    if (!p.ok) return { ok: false, error: p.error } as PatchResult;
    try {
      await retryOnWindowsLock(() => atomicWriteJsonSync(filePath, p.next));
    } catch (err) {
      return { ok: false, error: err } as PatchResult;
    }
    return { ok: true, value: p.next } as PatchResult;
  });
}
```

- [ ] **Step 3: sync mutate는 그대로 두되 주석 추가**

`mutateSessionJsonSync`(line 157-170)는 동기 경로(훅)에서 호출되어 await가 불가하므로 게이트를 적용하지 않는다. 단 `atomicWriteJsonSync`의 tmp 이름이 `process.pid` + 시퀀스라 동시 쓰기 충돌은 없고, 마지막 writer가 이긴다. 함수 위에 주석으로 명시:
```typescript
// NOTE: sync variant is used inside hook execution where awaiting is not possible.
// It is atomic (tmp+rename) but not serialized against concurrent async mutates of
// the same file — last writer wins. Hooks and routes mutate disjoint keys in practice;
// if a hook and a sub contend on the same key, prefer routing the hook write through
// the async path. (v1 accepts last-writer-wins for the sync hook path.)
```

- [ ] **Step 4: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-state.ts
git commit -m "fix(state): serialize per-file async json mutations (multi-writer safety)"
```

---

### Task 4: 서브 PID 레지스트리 (`subagent-registry.ts`)

agy PID 레지스트리 패턴을 재사용해 서브 PID를 `data/.runtime/subagent-procs.json`에 영속화하고, dev 재시작 시 고아를 reap한다.

**Files:**
- Create: `src/lib/subagent-registry.ts`

- [ ] **Step 1: 모듈 생성**

`src/lib/subagent-registry.ts`:
```typescript
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { getDataDir } from "./data-dir";

interface ProcEntry { pid: number; sessionId: string; name: string; startedAt: string; }

function regPath(): string {
  const dir = path.join(getDataDir(), ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "subagent-procs.json");
}

function read(): ProcEntry[] {
  try {
    const raw = fs.readFileSync(regPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function write(entries: ProcEntry[]): void {
  try { fs.writeFileSync(regPath(), JSON.stringify(entries), "utf-8"); } catch { /* ignore */ }
}

export function registerSubProc(pid: number, sessionId: string, name: string): void {
  const entries = read().filter(e => e.pid !== pid);
  // ISO timestamp is fine here — this runs in the main server process (not a workflow).
  entries.push({ pid, sessionId, name, startedAt: new Date().toISOString() });
  write(entries);
}

export function unregisterSubProc(pid: number): void {
  write(read().filter(e => e.pid !== pid));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    else process.kill(pid);
  } catch { /* already gone */ }
}

/** On server boot: kill any sub-agent PIDs that survived a previous server (orphans)
 *  and clear the registry. Live-checks each PID so we never kill a reused PID we know
 *  nothing about — only ones still recorded. */
export function reapOrphanSubProcs(): void {
  const entries = read();
  for (const e of entries) {
    if (isAlive(e.pid)) {
      console.log(`[subagent-registry] reaping orphan pid=${e.pid} (${e.sessionId}/${e.name})`);
      killPid(e.pid);
    }
  }
  write([]);
}
```

- [ ] **Step 2: 부팅 시 reap 호출 연결**

`server.ts`에서 서버 부팅 초기화 구간(다른 init 호출들 부근)에 추가. 먼저 위치 확인:
Run: `grep -n "destroyAllInstances\|reapOrphan\|killAgyForDir\|getDataDir" server.ts`
그 부근(서버 listen 직전 또는 init 함수 내부)에:
```typescript
import { reapOrphanSubProcs } from "./src/lib/subagent-registry";
// ... during startup init:
reapOrphanSubProcs();
```

- [ ] **Step 3: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/subagent-registry.ts server.ts
git commit -m "feat(subagents): persistent PID registry with boot-time orphan reaping"
```

---

### Task 5: `SubAgentInstance` (경량 런타임)

서브 1개 = AIProcess + 자기 resume id + 요약 보고. PanelEngine 없음. 메인 server 프로세스 안에서 산다.

**Files:**
- Create: `src/lib/subagent-instance.ts`

- [ ] **Step 1: 클래스 생성**

`src/lib/subagent-instance.ts`:
```typescript
import * as fs from "fs";
import * as path from "path";
import { AIProcess, createProcess } from "./ai-process-factory";
import { SubAgentDef } from "./subagent-manifest";
import { registerSubProc, unregisterSubProc } from "./subagent-registry";

/** System-prompt preamble prepended to every sub-agent's instructions. Establishes
 *  the sub's contract: it actuates shared state, never talks to the end user, and
 *  reports a concise summary back to the main narrator via the report_to_main tool. */
function buildSubSystemPrompt(def: SubAgentDef, instructions: string): string {
  return [
    `You are "${def.name}", a specialized background sub-agent for a roleplay session.`,
    `Your role: ${def.role}`,
    "You are NOT the narrator and you do NOT talk to the end user. The main narrator handles all user-facing prose.",
    "You operate on the SHARED session directory: read/write panel variables and data files using the MCP tools available to you (run_tool and the session's custom tools).",
    def.emitSummary
      ? `When you finish a task, call the MCP tool report_to_main with { from: "${def.name}", summary: "<one or two concise sentences of what changed>" } so the narrator learns what happened on its next turn. Do NOT write user-facing narrative.`
      : "Do not emit user-facing narrative.",
    "Keep your own text responses terse. The real work happens through tool calls.",
    "",
    "--- ROLE INSTRUCTIONS ---",
    instructions,
  ].join("\n");
}

export class SubAgentInstance {
  readonly name: string;
  readonly def: SubAgentDef;
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private _process: AIProcess;
  private resumeId: string | null = null;
  private destroyed = false;
  private pid: number | null = null;

  constructor(def: SubAgentDef, sessionDir: string, sessionId: string) {
    this.def = def;
    this.name = def.name;
    this.sessionDir = sessionDir;
    this.sessionId = sessionId;
    this._process = createProcess(def.provider);
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

  private subDir(): string { return path.join(this.sessionDir, "subagents", this.name); }
  private resumePath(): string { return path.join(this.subDir(), ".resume"); }

  private readInstructions(): string {
    const fp = path.join(this.subDir(), this.def.instructions);
    try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
  }

  isRunning(): boolean { return this._process.isRunning(); }

  /** Spawn the sub's provider process in the shared session dir. Idempotent: no-op if running. */
  start(): void {
    if (this.destroyed || this._process.isRunning()) return;
    fs.mkdirSync(this.subDir(), { recursive: true });
    // Resume previous provider session id when available (intra-session continuity across restart).
    try {
      if (!this.resumeId && fs.existsSync(this.resumePath())) {
        this.resumeId = fs.readFileSync(this.resumePath(), "utf-8").trim() || null;
      }
    } catch { /* ignore */ }
    const systemPrompt = buildSubSystemPrompt(this.def, this.readInstructions());
    // ClaudeProcess.spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions=true)
    // All provider processes share the same spawn surface (see ai-process-factory union).
    this._process.spawn(
      this.sessionDir,
      this.resumeId ?? undefined,
      this.def.model,
      systemPrompt,
      this.def.effort,
    );
    this.pid = (this._process as unknown as { proc?: { pid?: number } }).proc?.pid ?? null;
    if (this.pid) registerSubProc(this.pid, this.sessionId, this.name);
    console.log(`[subagent:${this.sessionId}/${this.name}] started pid=${this.pid} provider=${this.def.provider}`);
  }

  /** Dispatch a task to the sub. Spawns lazily if not yet running. Async-safe fire-and-forget. */
  dispatch(task: string): void {
    if (this.destroyed) return;
    if (!this._process.isRunning()) this.start();
    if (!this._process.isRunning()) {
      console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch skipped — not running`);
      return;
    }
    this._process.send(task);
  }

  destroy(): void {
    this.destroyed = true;
    try { this._process.kill(); } catch { /* ignore */ }
    try { this._process.removeAllListeners(); } catch { /* ignore */ }
    if (this.pid) unregisterSubProc(this.pid);
  }
}
```

- [ ] **Step 2: provider spawn 시그니처 호환 확인**

각 provider 프로세스의 `spawn` 시그니처가 `(cwd, resumeId?, model?, appendSystemPrompt?, effort?, ...)` 형태로 호환되는지 확인(특히 Antigravity는 PowerShell spawn이라 인자 다룸이 다를 수 있음):
Run: `grep -n "spawn(" src/lib/claude-process.ts src/lib/codex-process.ts src/lib/gemini-process.ts src/lib/kimi-process.ts src/lib/antigravity-process.ts | grep -v "child_process\|require\|import"`
Expected: claude/codex/gemini/kimi는 동일 형태. **Antigravity가 다르면**: v1에서는 매니페스트 검증 시 서브 provider를 `claude|codex|gemini|kimi`로 제한하고 antigravity 서브는 후속으로 미룬다 — Task 2의 `PROVIDERS`에서 antigravity를 빼고, 에러 메시지에 "antigravity sub-agents not supported in v1" 명시. (메인은 antigravity 가능, 서브만 제한.)

- [ ] **Step 3: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS. (Step 2 결과에 따라 PROVIDERS 조정 후 재실행.)

- [ ] **Step 4: 커밋**

```bash
git add src/lib/subagent-instance.ts src/lib/subagent-manifest.ts
git commit -m "feat(subagents): SubAgentInstance lightweight runtime"
```

---

### Task 6: `SubAgentManager`

부모 `SessionInstance`에 종속. 매니페스트 로드 → 서브 spawn/라우팅/정리.

**Files:**
- Create: `src/lib/subagent-manager.ts`

- [ ] **Step 1: 클래스 생성**

`src/lib/subagent-manager.ts`:
```typescript
import { SubAgentInstance } from "./subagent-instance";
import { loadSubAgentManifest, SubAgentDef } from "./subagent-manifest";

/** Owns the sub-agent instances for one session. Created and held by the parent
 *  SessionInstance; lifecycle is tied to the parent (spawnAll on open, destroyAll
 *  on parent destroy). */
export class SubAgentManager {
  private readonly sessionId: string;
  private readonly getDir: () => string | null;
  private subs = new Map<string, SubAgentInstance>();
  private defs = new Map<string, SubAgentDef>();

  constructor(sessionId: string, getDir: () => string | null) {
    this.sessionId = sessionId;
    this.getDir = getDir;
  }

  /** Read the manifest and spawn every declared sub-agent. Safe to call again
   *  (re-open) — already-running subs are left as-is. Manifest errors are logged,
   *  never thrown into the open flow. */
  spawnAll(): void {
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
      if (!inst) {
        inst = new SubAgentInstance(def, dir, this.sessionId);
        this.subs.set(def.name, inst);
      }
      try { inst.start(); } catch (err) {
        console.error(`[subagent-manager:${this.sessionId}] start ${def.name} failed:`, err);
      }
    }
  }

  /** Route a task to a named sub. Returns false if unknown/undeclared. */
  dispatch(name: string, task: string): boolean {
    const inst = this.subs.get(name);
    if (!inst) {
      console.warn(`[subagent-manager:${this.sessionId}] dispatch to unknown sub "${name}"`);
      return false;
    }
    inst.dispatch(task);
    return true;
  }

  /** Defs whose autoTrigger === "onAssistantTurn" (with their default task). */
  autoTriggerDefs(): SubAgentDef[] {
    return [...this.defs.values()].filter(d => d.autoTrigger === "onAssistantTurn");
  }

  has(name: string): boolean { return this.subs.has(name); }
  list(): string[] { return [...this.subs.keys()]; }

  destroyAll(): void {
    for (const inst of this.subs.values()) {
      try { inst.destroy(); } catch { /* ignore */ }
    }
    this.subs.clear();
    this.defs.clear();
  }
}
```

- [ ] **Step 2: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add src/lib/subagent-manager.ts
git commit -m "feat(subagents): SubAgentManager (spawn/route/lifecycle)"
```

---

## Phase C — SessionInstance 통합

### Task 7: SessionInstance에 매니저 부착 + destroy 연쇄

**Files:**
- Modify: `src/lib/session-instance.ts` (constructor 281-308, destroy 1758-1770, 멤버 선언부)

- [ ] **Step 1: import + 멤버 추가**

import 블록에:
```typescript
import { SubAgentManager } from "./subagent-manager";
```
멤버 선언부(예: `readonly panels: PanelEngine;` 근처)에:
```typescript
readonly subAgents: SubAgentManager;
```

- [ ] **Step 2: constructor에서 초기화**

constructor 본문 `this.bindProcessEvents(this._process);` 직전에 추가:
```typescript
this.subAgents = new SubAgentManager(id, () => this.getDir());
```
(빌더 인스턴스는 `getDir()`가 persona dir를 가리키고 매니페스트가 보통 없으므로 `spawnAll`이 no-op가 된다 — 빌더에서는 서브를 spawn하지 않는다. 빌더 spawn은 Task 8에서 명시적으로 건너뛴다.)

- [ ] **Step 3: destroy에 연쇄 정리 추가**

`destroy()`(1758-1770) 본문 `this._process.kill();` **직전**에 추가:
```typescript
try { this.subAgents.destroyAll(); } catch (err) { console.error(`[session:${this.id}] subAgents.destroyAll failed:`, err); }
```

- [ ] **Step 4: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "feat(subagents): attach SubAgentManager to SessionInstance with destroy cascade"
```

---

### Task 8: 세션 open에서 서브 spawn

메인 프로세스가 spawn된 직후 서브를 spawn한다.

**Files:**
- Modify: `src/app/api/sessions/[id]/open/route.ts` (line 117 spawn 직후)

- [ ] **Step 1: spawn 직후 서브 트리거 추가**

`open/route.ts`에서 메인 `instance.claude.spawn(...)` 호출(line 117) 다음 줄에 추가:
```typescript
// Spawn always-on sub-agents declared in subagents.json (session mode only; builder has none).
if (!instance.isBuilder) {
  try { instance.subAgents.spawnAll(); }
  catch (err) { console.error(`[open:${id}] subAgents.spawnAll failed:`, err); }
}
```
주의: spawn 분기(line 100-118)는 "프로세스 미실행 OR 모델 변경 시"에만 실행된다. 재open(이미 실행 중) 시에도 서브를 보장하려면, 이 블록을 spawn 분기 **밖**(line 118 이후, 무조건 실행되는 위치)에 둔다. `spawnAll`은 이미 실행 중인 서브를 건너뛰므로 무조건 호출해도 안전(idempotent).

- [ ] **Step 2: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add "src/app/api/sessions/[id]/open/route.ts"
git commit -m "feat(subagents): spawn sub-agents on session open"
```

---

## Phase D — 디스패치 & 통신

### Task 9: 디스패치 라우트

`fire-ai` 라우트 패턴을 미러링.

**Files:**
- Create: `src/app/api/sessions/[id]/subagents/[name]/dispatch/route.ts`

- [ ] **Step 1: 라우트 생성**

`src/app/api/sessions/[id]/subagents/[name]/dispatch/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id: rawId, name: rawName } = await params;
  const id = decodeURIComponent(rawId);
  const name = decodeURIComponent(rawName);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const task = typeof body.task === "string" ? body.task : "";

  if (!task.trim()) return NextResponse.json({ error: "task is required" }, { status: 400 });

  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });

  const ok = instance.subAgents.dispatch(name, task);
  if (!ok) return NextResponse.json({ error: `Unknown or undeclared sub-agent "${name}"` }, { status: 404 });

  return NextResponse.json({ ok: true, dispatched: name });
}
```
(인증: 다른 `/api/sessions/[id]/*` 라우트와 동일하게 middleware의 `x-bridge-token`/쿠키 게이트가 적용된다 — 별도 처리 불필요. fire-ai 라우트와 동일 패턴인지 Step 2에서 확인.)

- [ ] **Step 2: fire-ai 라우트와 인증/형태 정합 확인**

Run: `cat "src/app/api/sessions/[id]/fire-ai/route.ts"`
Expected: import·params 분해·`getServices()`/`getSessionInstance` 사용 패턴이 위와 일치하는지 확인. fire-ai가 `getServices().sessions.getSessionInfo`로 세션 존재를 검증하면, 동일하게 추가하되 dispatch는 live instance가 필수이므로 `getSessionInstance` null 체크로 충분.

- [ ] **Step 3: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add "src/app/api/sessions/[id]/subagents/[name]/dispatch/route.ts"
git commit -m "feat(subagents): dispatch route (POST .../subagents/[name]/dispatch)"
```

---

### Task 10: 훅 `dispatch[]` 처리 + 선언적 autoTrigger

`runAssistantHooks`에서 (a) 훅 반환 `dispatch[]`을 라우팅하고, (b) 매니페스트 `autoTrigger:"onAssistantTurn"` 서브를 자동 디스패치한다.

**Files:**
- Modify: `src/lib/session-instance.ts:695-766` (runAssistantHooks)

- [ ] **Step 1: 훅 결과 타입에 dispatch 추가**

`runAssistantHooks` 안에서 훅 반환값을 다루는 타입 캐스트 지점에 `dispatch?` 필드를 포함시킨다. fireAi 블록 바로 다음(레퍼런스 기준 line 762 직후, catch 직전)에 삽입:
```typescript
// Handle dispatch[] — route tasks to named sub-agents (hook-driven auto-dispatch).
const dispatchList = (result as { dispatch?: unknown }).dispatch;
if (Array.isArray(dispatchList)) {
  for (const item of dispatchList) {
    const d = (item || {}) as { to?: unknown; task?: unknown };
    const to = typeof d.to === "string" ? d.to : "";
    const task = typeof d.task === "string" ? d.task : "";
    if (to && task) {
      const ok = this.subAgents.dispatch(to, task);
      if (!ok) console.warn(`[session:${this.id}] on-assistant dispatch to unknown sub "${to}"`);
    }
  }
}
```

- [ ] **Step 2: 선언적 autoTrigger 디스패치**

같은 위치(Step 1 블록 다음)에, 훅이 명시 디스패치하지 않은 autoTrigger 서브를 기본 task로 디스패치. 단 훅 `dispatch[]`에서 이미 다룬 서브는 중복 방지:
```typescript
// Declarative auto-trigger: subs with autoTrigger "onAssistantTurn" fire each main turn,
// unless the hook already dispatched them explicitly this turn.
const explicitlyDispatched = new Set(
  Array.isArray(dispatchList)
    ? dispatchList.map(i => (i as { to?: string }).to).filter(Boolean) as string[]
    : []
);
for (const def of this.subAgents.autoTriggerDefs()) {
  if (explicitlyDispatched.has(def.name)) continue;
  const task = def.autoTriggerTask?.trim() || "최근 메인 턴을 반영해 네 담당 영역의 상태를 갱신하라.";
  this.subAgents.dispatch(def.name, `${task}\n\n[직전 메인 응답]\n${responseText}`);
}
```
주의: `runAssistantHooks`는 `hooks/on-assistant.js`가 없으면 일찍 return할 수 있다. autoTrigger는 훅 유무와 무관해야 하므로, autoTrigger 블록은 **훅 부재 early-return보다 앞**(또는 별도 무조건 실행 경로)에 있어야 한다. 구현 시 함수 구조를 확인해, 훅 require 실패/부재 시에도 autoTrigger 루프는 실행되도록 배치한다(예: 훅 처리 try/catch와 분리된 마지막 블록).

- [ ] **Step 3: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "feat(subagents): hook dispatch[] routing + declarative autoTrigger"
```

---

### Task 11: MCP 툴 — `bridge_delegate` + `report_to_main`

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs` (fire_ai 툴 등록부 근처, line 1355 부근)

- [ ] **Step 1: `bridge_delegate` 등록 (메인 → 서브 명시 위임)**

`fire_ai` `registerTool` 블록 다음에 추가:
```javascript
server.registerTool(
  "bridge_delegate",
  {
    description:
      "Delegate a task to a pre-configured sub-agent of THIS session (defined in subagents.json). " +
      "Fire-and-forget: the sub works in the background and reports a summary back into your next turn " +
      "via the event queue. Use for bookkeeping you don't want in your own context (panel variable updates, " +
      "flow control, lore consistency checks).",
    inputSchema: {
      to: z.string().min(1).describe("Sub-agent name as declared in subagents.json"),
      task: z.string().min(1).describe("The task instruction for the sub-agent"),
    },
  },
  async ({ to, task }) => {
    if (mode !== "session") return fail("bridge_delegate is only available in session mode");
    try {
      const data = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(to)}/dispatch`,
        { task },
      );
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);
```

- [ ] **Step 2: `report_to_main` 등록 (서브 → 메인 요약)**

이어서 추가:
```javascript
server.registerTool(
  "report_to_main",
  {
    description:
      "Report a concise summary of what you changed back to the main narrator. " +
      "Queues a [SUB:<from>] event that is delivered to the narrator on the next user turn. " +
      "Call this when you (a sub-agent) finish a task. Keep the summary to one or two sentences.",
    inputSchema: {
      from: z.string().min(1).describe("Your own sub-agent name (as in subagents.json)"),
      summary: z.string().min(1).describe("One or two concise sentences of what changed"),
    },
  },
  async ({ from, summary }) => {
    if (mode !== "session") return fail("report_to_main is only available in session mode");
    try {
      const header = `[SUB:${String(from).trim()}] ${String(summary).trim()}`;
      const data = await requestJson(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/events`,
        { header },
      );
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);
```
(주의: 두 툴 모두 세션 `.mcp.json`을 공유하므로 메인·서브 모두에 노출된다. `bridge_delegate`는 메인이, `report_to_main`은 서브가 쓴다 — 시스템 프롬프트/instructions가 각자 올바른 툴을 쓰도록 안내한다. `report_to_main`의 `from`은 인자로 받으므로 per-sub MCP env가 불필요하다.)

- [ ] **Step 3: 구문 검증**

Run: `node --check src/mcp/claude-play-mcp-server.mjs`
Expected: 출력 없음(구문 OK).

- [ ] **Step 4: 커밋**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat(subagents): bridge_delegate + report_to_main MCP tools"
```

---

## Phase E — 빌더 & 영속화

### Task 12: 세션 생성/미러에 서브 산출물 규칙

`subagents.json` + `subagents/*/instructions.md`는 페르소나→세션으로 복사돼야 하지만, 런타임 산출물(`history.json`·`.resume`·`sub.log`)은 복사/미러/publish에서 제외한다.

**Files:**
- Modify: `src/lib/session-manager.ts:560-591` (create SKIP), `:1693-1715` (mirror SKIP)

- [ ] **Step 1: create SKIP_FILES 확인 — subagents는 복사 허용**

create의 `SKIP_FILES`(560-591)에는 `subagents` / `subagents.json`을 **넣지 않는다**(복사돼야 함). `copyDirRecursive`가 `subagents/`를 통째로 복사하면 런타임 산출물도 같이 올 수 있으나, 페르소나 템플릿엔 보통 `instructions.md`만 있으므로 OK. 안전을 위해 복사 후 세션 dir에서 런타임 잔재를 청소하는 한 줄을 `createSession` 말미(line 653 부근)에 추가:
```typescript
// Strip any sub-agent runtime artifacts that leaked from the persona template.
try {
  const subRoot = path.join(sessionDir, "subagents");
  if (fs.existsSync(subRoot)) {
    for (const name of fs.readdirSync(subRoot)) {
      for (const junk of ["history.json", ".resume", "sub.log"]) {
        const fp = path.join(subRoot, name, junk);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
    }
  }
} catch { /* ignore */ }
```

- [ ] **Step 2: mirror SKIP_FILES에 런타임 잔재 추가**

`mirrorNewPersonaFiles`의 `SKIP_FILES`(1693-1715)에 추가 — `subagents.json`과 `instructions.md`는 additive mirror 되어야 하므로 `subagents` 디렉토리 자체는 SKIP하지 않되, 미러는 "페르소나에만 있고 세션에 없는 파일만 복사"이므로 런타임 파일(세션에서 생성)은 어차피 역방향이라 안전하다. 명시적 방어로 다음 항목만 추가:
```typescript
  "sub.log",
  ".resume",
```
(`history.json`은 메인 `chat-history.json`과 달리 서브용이지만, 미러는 페르소나→세션 단방향이고 페르소나엔 서브 history가 없으므로 추가 불필요. 단 publish 누출 방지는 Step 3에서 처리.)

- [ ] **Step 3: 페르소나 publish .gitignore에 런타임 산출물 추가**

페르소나 publish용 `.gitignore`를 생성/작성하는 지점을 찾는다:
Run: `grep -rn "gitignore" src/lib/*.ts | grep -i "persona\|publish\|write"`
그 생성 목록(chat-history.json·.claude/ 등과 같은 배열/문자열)에 추가:
```
subagents/*/history.json
subagents/*/.resume
subagents/*/sub.log
```

- [ ] **Step 4: tsc 검증**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-manager.ts
git commit -m "feat(subagents): copy manifest to sessions, exclude runtime artifacts from mirror/publish"
```

---

### Task 13: 빌더 통합 — 메타프롬프트 섹션 + `bridge_define_subagent`

빌더 AI가 서브를 정의(매니페스트 + instructions.md 작성)할 수 있게 한다.

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs` (builder 모드 툴 — `bridge_define_subagent`)
- Modify: 빌더 메타프롬프트 소스 (`builder-prompt.md` 위치 확인)

- [ ] **Step 1: `bridge_define_subagent` MCP 툴 (빌더 모드)**

`claude-play-mcp-server.mjs`에 추가. 빌더 모드에선 `sessionDir`가 persona dir이므로 매니페스트를 거기에 쓴다:
```javascript
server.registerTool(
  "bridge_define_subagent",
  {
    description:
      "[Builder mode] Define or update a specialized sub-agent for this persona. " +
      "Writes subagents.json (merging by name) and subagents/<name>/instructions.md in the persona dir. " +
      "Sub-agents run always-on alongside the main narrator at session time and handle delegated bookkeeping.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
      role: z.string().min(1),
      provider: z.enum(["claude", "codex", "gemini", "kimi"]).optional(),
      model: z.string().optional(),
      instructions: z.string().min(1).describe("Full system-prompt body for the sub (saved to instructions.md)"),
      delegable: z.boolean().optional(),
      autoTrigger: z.enum(["onAssistantTurn", "none"]).optional(),
      autoTriggerTask: z.string().optional(),
      emitSummary: z.boolean().optional(),
    },
  },
  async (input) => {
    if (mode !== "builder") return fail("bridge_define_subagent is only available in builder mode");
    try {
      const manifestPath = path.join(sessionDir, "subagents.json");
      let manifest = { version: 1, subagents: [] };
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch { /* reset on corrupt */ }
      }
      if (!Array.isArray(manifest.subagents)) manifest.subagents = [];
      const entry = {
        name: input.name,
        role: input.role,
        provider: input.provider || "claude",
        ...(input.model ? { model: input.model } : {}),
        instructions: "instructions.md",
        delegable: input.delegable !== false,
        autoTrigger: input.autoTrigger || "none",
        ...(input.autoTriggerTask ? { autoTriggerTask: input.autoTriggerTask } : {}),
        emitSummary: input.emitSummary !== false,
      };
      const idx = manifest.subagents.findIndex((s) => s && s.name === input.name);
      if (idx >= 0) manifest.subagents[idx] = { ...manifest.subagents[idx], ...entry };
      else manifest.subagents.push(entry);
      if (manifest.subagents.length > 6) {
        return fail(`Too many sub-agents (${manifest.subagents.length} > 6).`);
      }
      const subDir = path.join(sessionDir, "subagents", input.name);
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "instructions.md"), input.instructions, "utf-8");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
      return ok({ defined: input.name, total: manifest.subagents.length });
    } catch (error) {
      return fail(error);
    }
  }
);
```

- [ ] **Step 2: 빌더 메타프롬프트에 섹션 추가**

빌더 메타프롬프트 소스 위치 확인:
Run: `grep -rln "builder-prompt\|getBuilderPrompt\|buildBuilderSystemPrompt" src data`
찾은 `builder-prompt.md`(Handlebars 소스)에 "서브에이전트 정의" 섹션을 추가 — 빌더 AI에게: 페르소나에 흐름제어/패널부기/설정일관성 같은 반복 작업이 있으면 `bridge_define_subagent`로 전문 서브를 정의하라고 안내. 예시 한 단락 포함:
```markdown
## 서브에이전트(선택)
이 페르소나의 RP가 메인 서사 외에 반복적 부기(패널 변수 갱신·흐름 제어·설정 일관성 점검)를 요구한다면,
`bridge_define_subagent`로 전문 서브를 정의할 수 있다. 서브는 세션에서 메인과 함께 상주하며,
메인이 `bridge_delegate`로 위임하거나 autoTrigger로 매 턴 자동 실행된다. 서브는 상태를 직접 변경하고
`report_to_main`으로 변경 요약을 메인에 돌려준다. 저비용 모델(예: claude-haiku-4-5)을 권장한다.
```

- [ ] **Step 3: 구문/빌드 검증**

Run: `node --check src/mcp/claude-play-mcp-server.mjs && npx tsc --noEmit`
Expected: 둘 다 PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git add <builder-prompt.md 경로>
git commit -m "feat(subagents): builder bridge_define_subagent tool + meta-prompt section"
```

---

## Phase F — 문서 & 통합 검증

### Task 14: 문서 갱신

**Files:**
- Modify: `docs/session-lifecycle.md`, `docs/architecture.md`, `docs/data-model.md`, `docs/change-propagation.md`

- [ ] **Step 1: session-lifecycle.md**

"Background AI (`fire_ai`)" 섹션 뒤에 "Sub-Agents (always-on)" 섹션 추가 — open 시 `subAgents.spawnAll()`, 디스패치 두 경로(on-assistant `dispatch[]` / `bridge_delegate`), `report_to_main`→events→다음 턴 합류, destroy 연쇄·PID reap을 3-5줄로 요약.

- [ ] **Step 2: architecture.md / data-model.md / change-propagation.md**

- architecture.md: Core Libraries에 `subagent-instance.ts`/`subagent-manager.ts`/`subagent-manifest.ts`/`subagent-registry.ts`/`ai-process-factory.ts` 한 줄씩.
- data-model.md: 세션 dir 트리에 `subagents.json` + `subagents/{name}/{instructions.md,history.json,.resume,sub.log}` 추가.
- change-propagation.md: "서브에이전트 추가/변경 시" 행 — 매니페스트·instructions·MCP 툴·SKIP 목록 동기화 안내.

- [ ] **Step 3: 커밋**

```bash
git add docs/session-lifecycle.md docs/architecture.md docs/data-model.md docs/change-propagation.md
git commit -m "docs(subagents): document always-on sub-agent runtime"
```

---

### Task 15: 통합 스모크 (dev 서버 수동)

**전제:** 다른 모든 태스크 완료, tsc 그린.

- [ ] **Step 1: 빌드 그린 확인**

Run: `npm run build`
Expected: TypeScript 체크 + Next 빌드 성공. (라이브 `.next` 갱신됨 — 끝나면 dev로 복귀.)

- [ ] **Step 2: 테스트 페르소나에 서브 1개 정의**

dev 서버(`npm run dev`)에서 빌더로 테스트 페르소나를 만들고, 빌더 AI에게 "패널 변수 부기용 서브 `panel-updater`를 claude-haiku-4-5로 autoTrigger onAssistantTurn으로 정의해줘"라고 지시 → `data/personas/<persona>/subagents.json` + `subagents/panel-updater/instructions.md` 생성 확인.

- [ ] **Step 3: 세션 생성·open → 서브 spawn 확인**

세션 생성 후 open. 확인:
- 콘솔에 `[subagent:<id>/panel-updater] started pid=...`
- `data/.runtime/subagent-procs.json`에 PID 엔트리
- `tasklist`(Windows)에 추가 claude 프로세스 1개

- [ ] **Step 4: 디스패치 → 액추에이트 → 합류 확인**

메인에 한 턴 보낸 뒤(autoTrigger 발동):
- `data/sessions/<id>/variables.json`이 서브에 의해 변경됨(서브 instructions에 변수 변경 지시 포함 시)
- `data/sessions/<id>/pending-events.json`에 `[SUB:panel-updater] ...` 헤더 적재
- 다음 유저 입력 시 메인 프롬프트 앞에 해당 헤더가 합류(`flushEvents`)되는지 `claude-stream.log`로 확인

- [ ] **Step 5: 정리·reap 확인**

브라우저 탭 닫고 grace(10분) 후 또는 `closeSessionInstance` 경로로 서브 프로세스 종료 확인. dev 서버 강제 재시작 후 `reapOrphanSubProcs`가 좀비를 정리하는지 콘솔 로그로 확인.

- [ ] **Step 6: 최종 커밋(스모크에서 발견한 수정 있으면)**

```bash
git add -A
git commit -m "fix(subagents): integration smoke fixes"
```

---

## Self-Review 체크 (작성자 기록)

- **Spec coverage:** 키스톤 1(always-on)=Task 5/8, 2(양방향 트리거)=Task 10/11, 3(직접 액추에이터)=Task 5 시스템프롬프트+기존 MCP 툴, 4(코어 백본 범위)=전체, 5(부모 소유)=Task 7, 6(순수 비동기)=기존 flushEvents 재사용(신규 작업 없음, 의도된 무변경), 7(선언적+훅)=Task 10/13. 동시성(스펙 4.1)=Task 3. 생성·미러·publish(스펙 6.1)=Task 12. 고아 reap=Task 4. 에러처리(스펙 6.2)=Task 5/6 try-catch + 기본 error listener. 검증(스펙 9)=Task 15. → 갭 없음.
- **Placeholder scan:** 신규 파일은 완전 코드. 수정은 실제 삽입 코드 제공. 빌더 메타프롬프트 경로/페르소나 .gitignore 생성 위치는 grep으로 먼저 확정(Task 12-3, 13-2) — 위치 미상이라 grep 지시. 그 외 TBD 없음.
- **Type consistency:** `AIProcess`/`createProcess`(factory) · `SubAgentDef`/`loadSubAgentManifest`/`MAX_SUBAGENTS`(manifest) · `SubAgentInstance.{start,dispatch,destroy,isRunning}` · `SubAgentManager.{spawnAll,dispatch,autoTriggerDefs,destroyAll,has,list}` · `instance.subAgents` · 라우트 body `{task}` · MCP `bridge_delegate{to,task}`/`report_to_main{from,summary}`/`bridge_define_subagent` · 훅 `dispatch:[{to,task}]` — 태스크 간 명칭 일치.
- **알려진 리스크:** (a) provider spawn 시그니처 비호환(특히 Antigravity) → Task 5-2에서 확인 후 서브 provider 제한. (b) `runAssistantHooks` 훅 부재 early-return과 autoTrigger 배치 → Task 10-2 주의 명시. (c) custom tool의 변수 쓰기가 `mutateSessionJson`을 안 거치면 뮤텍스 무력 → 구현 중 확인 권장.
