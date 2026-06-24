# 서브에이전트 대화 모달 패널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 상주 서브에이전트와 OOC 양방향으로 직접 대화하고, 메인↔서브 자율 트래픽까지 한 transcript에서 보는 메신저형 공용 모달을 추가한다.

**Architecture:** `SubAgentInstance`가 provider 프로세스의 `message` 이벤트를 구독해 최종 텍스트만 경량 누적기로 캡처하고 `subagents/{name}/transcript.jsonl`에 append + `subagent:message` WS 푸시. 디스패치에 origin 태그를 달아 사용자 직접 메시지(`operator`)는 OOC 마커로 서브의 대화체 응답을 유도한다. 신규 React 모달이 서브 목록 + transcript + 입력을 메신저형으로 렌더한다.

**Tech Stack:** Next.js 15 (App Router) + React 19 + TypeScript (strict), 커스텀 `server.ts` + WebSocket, file-based `data/`. tsx 런타임(`npm run dev`).

## Global Constraints

- **테스트 프레임워크 없음** (CLAUDE.md). 검증 게이트 = `npx tsc --noEmit` 그린. 순수 로직(Task 1)은 임시 `tsx` 스크립트로 실행 검증 후 삭제(커밋 안 함). UI/런타임은 사용자 라이브 스모크(이 plan 끝의 체크리스트)로 위임.
- **`next build` / `npm run build` 금지** — 라이브 `.next`가 깨진다. 타입 검증은 `npx tsc --noEmit`만.
- **경로에 공백** (`C:\repository\claude bridge`) — 셸 명령에서 따옴표 필수. Windows 환경.
- **Single-user 서비스** — 인증/userId 없음. `getSessionInstance(id)`로 활성 세션 접근.
- 커밋은 브랜치 `feat/subagent-chat-modal`에서. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 사용자 커뮤니케이션은 한국어. 코드 주석은 주변 코드 스타일(영문/한글 혼용) 따름.
- provider 5종 공통 `message` 이벤트 형태(스펙 §설계 참조): 비-Claude=`{type:"assistant",subtype:"text_delta",message:{content:string}}`, Claude=`{type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}}` 또는 `{type:"assistant",message:{content:[{type:"text",text}]}}`, 공통 종료=`{type:"result"}`(Claude는 `result.result`/`.text` 폴백).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/subagent-transcript.ts` (신규) | 순수 모듈: `TranscriptEntry` 타입, 메시지→텍스트 누적 reducer, transcript 파일 append/tail-read, 경로 계산 |
| `src/lib/subagent-instance.ts` (수정) | `message` 구독→reducer→`appendTranscript`(파일+WS), `dispatch(task,origin)`+OOC 마커, `recordReport`, `readTranscript`, role preamble OOC 라인 |
| `src/lib/subagent-manager.ts` (수정) | broadcast 콜백 주입/전달, `dispatch(name,task,origin)`, `recordReport(name,summary)`, `listDetailed()`, `readTranscript(name,n)` |
| `src/lib/session-instance.ts` (수정) | 매니저 생성 시 broadcast 주입, auto/hook 디스패치에 origin 전달 |
| `src/lib/session-manager.ts` (수정) | publish gitignore + 세션 생성 strip에 `transcript.jsonl` 추가 |
| `src/app/api/sessions/[id]/subagents/route.ts` (신규) | GET 서브 목록 |
| `src/app/api/sessions/[id]/subagents/[name]/message/route.ts` (신규) | POST 사용자 직접 입력 |
| `src/app/api/sessions/[id]/subagents/[name]/transcript/route.ts` (신규) | GET transcript tail |
| `src/app/api/sessions/[id]/events/route.ts` (수정) | `[SUB:name]` 헤더 파싱→`recordReport` |
| `src/components/SubAgentChatModal.tsx` (신규) | 메신저형 모달 UI |
| `src/components/StatusBar.tsx` (수정) | 도구 메뉴 "서브에이전트" 항목 + 안읽음 배지 |
| `src/app/chat/[sessionId]/page.tsx` (수정) | 모달 마운트, `subagent:message` WS 핸들러, unread 상태 |

---

## Task 1: 순수 transcript 모듈 (`subagent-transcript.ts`)

**Files:**
- Create: `src/lib/subagent-transcript.ts`
- Test(임시): `tmp-check-subagent-transcript.mts` (repo 루트, 검증 후 삭제 — 커밋 안 함)

**Interfaces:**
- Produces:
  - `type TranscriptDir = "in" | "out"`
  - `type TranscriptKind = "dispatch" | "response" | "report"`
  - `type TranscriptOrigin = "operator" | "auto" | "hook" | "delegate"`
  - `interface TranscriptEntry { ts: string; dir: TranscriptDir; kind: TranscriptKind; origin?: TranscriptOrigin; text: string }`
  - `interface SubTextState { buf: string; sawDelta: boolean }`
  - `function newSubTextState(): SubTextState`
  - `function reduceSubMessage(state: SubTextState, msg: Record<string, unknown>): { state: SubTextState; final?: string }`
  - `function transcriptPath(sessionDir: string, name: string): string`
  - `function appendTranscriptLine(sessionDir: string, name: string, entry: TranscriptEntry): void`
  - `function readTranscriptTail(sessionDir: string, name: string, n: number): TranscriptEntry[]`

- [ ] **Step 1: 임시 검증 스크립트 작성 (실패 확인용)**

Create `tmp-check-subagent-transcript.mts`:

```ts
import assert from "node:assert";
import { newSubTextState, reduceSubMessage } from "./src/lib/subagent-transcript";

// 1) 비-Claude text_delta 누적 후 result flush
let s = newSubTextState();
s = reduceSubMessage(s, { type: "assistant", subtype: "text_delta", message: { content: "안녕" } }).state;
s = reduceSubMessage(s, { type: "assistant", subtype: "text_delta", message: { content: "하세요" } }).state;
let r = reduceSubMessage(s, { type: "result" });
assert.equal(r.final, "안녕하세요", "non-claude delta accumulate");

// 2) Claude stream_event 델타 + 최종 assistant(이중계수 방지) → 한 번만
s = newSubTextState();
s = reduceSubMessage(s, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }).state;
s = reduceSubMessage(s, { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } }).state; // sawDelta=true라 무시
r = reduceSubMessage(s, { type: "result" });
assert.equal(r.final, "Hi", "claude stream delta, no double count");

// 3) Claude 비스트리밍(델타 없음) → assistant content 배열에서 수집
s = newSubTextState();
s = reduceSubMessage(s, { type: "assistant", message: { content: [{ type: "text", text: "fallback" }] } }).state;
r = reduceSubMessage(s, { type: "result" });
assert.equal(r.final, "fallback", "claude non-streaming text");

// 4) 텍스트 없는 도구 전용 턴 → final undefined
s = newSubTextState();
r = reduceSubMessage(s, { type: "result", result: "" });
assert.equal(r.final, undefined, "tool-only turn yields no entry");

// 5) Claude result.result 폴백
s = newSubTextState();
r = reduceSubMessage(s, { type: "result", result: "from-result" });
assert.equal(r.final, "from-result", "result.result fallback");

console.log("ALL PASS");
```

- [ ] **Step 2: 스크립트 실행해 실패 확인**

Run: `npx tsx "tmp-check-subagent-transcript.mts"`
Expected: FAIL — `Cannot find module './src/lib/subagent-transcript'` (아직 미작성).

- [ ] **Step 3: `subagent-transcript.ts` 구현**

Create `src/lib/subagent-transcript.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

export type TranscriptDir = "in" | "out";
export type TranscriptKind = "dispatch" | "response" | "report";
export type TranscriptOrigin = "operator" | "auto" | "hook" | "delegate";

export interface TranscriptEntry {
  ts: string;
  dir: TranscriptDir;
  kind: TranscriptKind;
  origin?: TranscriptOrigin;
  text: string;
}

/** Per-turn text accumulator state for one sub-agent's provider stream. */
export interface SubTextState {
  buf: string;
  sawDelta: boolean;
}

export function newSubTextState(): SubTextState {
  return { buf: "", sawDelta: false };
}

/**
 * Pure reducer: fold one provider `message` event into the text accumulator.
 * Returns the next state, and (only on a turn-ending `result`) the final text
 * to record — or `undefined` when the turn produced no user-visible text
 * (e.g. tool-only turn). Provider shapes (verified against session-instance
 * bindProcessEvents):
 *  - non-Claude: { type:"assistant", subtype:"text_delta", message:{content:string} }
 *  - Claude stream: { type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}} }
 *  - Claude non-stream: { type:"assistant", message:{content:[{type:"text", text}]} }
 *  - end: { type:"result" }  (Claude carries final text in result.result / result.text)
 * The `sawDelta` guard prevents double-counting Claude's streamed deltas and
 * its trailing cumulative assistant message.
 */
export function reduceSubMessage(
  state: SubTextState,
  msg: Record<string, unknown>,
): { state: SubTextState; final?: string } {
  const am = msg.message as Record<string, unknown> | undefined;

  // 1) non-Claude unified delta
  if (msg.type === "assistant" && msg.subtype === "text_delta") {
    if (typeof am?.content === "string") {
      return { state: { buf: state.buf + am.content, sawDelta: true } };
    }
    return { state };
  }

  // 2) Claude streaming delta
  if (msg.type === "stream_event") {
    const ev = msg.event as Record<string, unknown> | undefined;
    const delta = ev?.delta as Record<string, unknown> | undefined;
    if (ev?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return { state: { buf: state.buf + delta.text, sawDelta: true } };
    }
    return { state };
  }

  // 3) Claude non-streaming text — only when no stream deltas arrived this turn
  if (msg.type === "assistant" && !state.sawDelta && am) {
    let add = "";
    if (typeof am.content === "string") {
      add = am.content;
    } else if (Array.isArray(am.content)) {
      for (const b of am.content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string") add += b.text;
      }
    }
    return { state: { buf: state.buf + add, sawDelta: state.sawDelta } };
  }

  // 4) turn end → flush
  if (msg.type === "result") {
    const r = msg.result as Record<string, unknown> | string | undefined;
    const fromResult = typeof r === "string" ? r : typeof r?.text === "string" ? (r.text as string) : "";
    const final = state.buf.trim() || fromResult.trim();
    return { state: newSubTextState(), final: final || undefined };
  }

  return { state };
}

export function transcriptPath(sessionDir: string, name: string): string {
  return path.join(sessionDir, "subagents", name, "transcript.jsonl");
}

/** Append one entry as a JSONL line. Best-effort (creates the dir if missing). */
export function appendTranscriptLine(sessionDir: string, name: string, entry: TranscriptEntry): void {
  const fp = transcriptPath(sessionDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}

/** Read the last `n` valid entries (malformed lines skipped). Returns [] if no file. */
export function readTranscriptTail(sessionDir: string, name: string, n: number): TranscriptEntry[] {
  const fp = transcriptPath(sessionDir, name);
  let raw: string;
  try {
    raw = fs.readFileSync(fp, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out: TranscriptEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
```

- [ ] **Step 4: 스크립트 재실행해 통과 확인**

Run: `npx tsx "tmp-check-subagent-transcript.mts"`
Expected: `ALL PASS`

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (신규 파일이 컴파일됨).

- [ ] **Step 6: 임시 스크립트 삭제 후 커밋**

```bash
rm "tmp-check-subagent-transcript.mts"
git add src/lib/subagent-transcript.ts
git commit -m "feat(subagent): pure transcript module (reducer + jsonl io)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `SubAgentInstance` 캡처 + transcript + origin/OOC + publish 안전

**Files:**
- Modify: `src/lib/subagent-instance.ts`
- Modify: `src/lib/session-manager.ts:718` (세션 생성 strip), `src/lib/session-manager.ts:1516-1519` (publish gitignore)

**Interfaces:**
- Consumes (Task 1): `newSubTextState`, `reduceSubMessage`, `appendTranscriptLine`, `readTranscriptTail`, `TranscriptEntry`, `TranscriptDir`, `TranscriptKind`, `TranscriptOrigin`.
- Produces (Task 3에서 사용):
  - `SubAgentInstance` 생성자 7번째 인자 `onTranscript?: (entry: TranscriptEntry) => void`
  - `dispatch(task: string, origin?: TranscriptOrigin): void`
  - `recordReport(summary: string): void`
  - `readTranscript(n: number): TranscriptEntry[]`

- [ ] **Step 1: import 추가**

`src/lib/subagent-instance.ts` 상단 import 블록(기존 `registerSubProc` import 아래)에 추가:

```ts
import {
  newSubTextState, reduceSubMessage, appendTranscriptLine, readTranscriptTail,
  type SubTextState, type TranscriptEntry, type TranscriptDir, type TranscriptKind, type TranscriptOrigin,
} from "./subagent-transcript";
```

- [ ] **Step 2: role preamble에 OOC 예외 라인 추가**

`buildSubSystemPrompt`의 `"You are NOT the narrator and you do NOT talk to the end user. ..."` 라인 **바로 다음**에 한 줄 추가:

```ts
    "You are NOT the narrator and you do NOT talk to the end user. The main narrator handles all user-facing prose.",
    "Exception: a message beginning with [OPERATOR] is the human operator talking to you directly, out of character. In that turn, reply to the operator concisely and conversationally. You MAY still use your tools and call report_to_main when you actually change state.",
```

- [ ] **Step 3: 필드 + 생성자 인자 + message 구독 추가**

`SubAgentInstance` 클래스 필드에 추가(기존 `private spawnInFlight = false;` 아래):

```ts
  /** Per-turn text accumulator for capturing the sub's final response text. */
  private textState: SubTextState = newSubTextState();
```

생성자 시그니처에 7번째 인자 추가:

```ts
  constructor(
    def: SubAgentDef,
    sessionDir: string,
    sessionId: string,
    provider: AIProvider,
    model?: string,
    effort?: string,
    private readonly onTranscript?: (entry: TranscriptEntry) => void,
  ) {
```

생성자 본문에서 기존 `this._process.on("exit", ...)` 블록 **다음**에 message 구독 추가:

```ts
    // Capture the sub's final response text per turn (turn-complete, not streamed).
    this._process.on("message", (d) => {
      const { state, final } = reduceSubMessage(this.textState, d as Record<string, unknown>);
      this.textState = state;
      if (final) this.appendTranscript({ dir: "out", kind: "response", text: final });
    });
```

- [ ] **Step 4: appendTranscript / recordReport / readTranscript 메서드 추가**

`destroy()` 메서드 **앞**에 추가:

```ts
  /** Append a transcript entry (best-effort file write) and push it over WS. */
  private appendTranscript(e: { dir: TranscriptDir; kind: TranscriptKind; origin?: TranscriptOrigin; text: string }): void {
    const entry: TranscriptEntry = { ts: new Date().toISOString(), ...e };
    try { appendTranscriptLine(this.sessionDir, this.name, entry); } catch { /* best-effort */ }
    try { this.onTranscript?.(entry); } catch { /* ignore */ }
  }

  /** Record a sub→main report summary into this sub's transcript. */
  recordReport(summary: string): void {
    this.appendTranscript({ dir: "out", kind: "report", text: summary });
  }

  /** Read the last `n` transcript entries for display. */
  readTranscript(n: number): TranscriptEntry[] {
    return readTranscriptTail(this.sessionDir, this.name, n);
  }
```

- [ ] **Step 5: `dispatch`에 origin + OOC 마커 + transcript 기록**

기존 `dispatch(task: string): void { ... }` 전체를 교체:

```ts
  dispatch(task: string, origin: TranscriptOrigin = "delegate"): void {
    if (this.destroyed) return;
    this.appendTranscript({ dir: "in", kind: "dispatch", origin, text: task });
    // Operator OOC messages get a marker so the sub replies conversationally (see preamble).
    const taskText = origin === "operator" ? `[OPERATOR]\n${task}` : task;
    this.start(); // no-op when already running or a handshake is in flight
    void this._process.waitForReady(20_000)
      .then((ready) => {
        if (this.destroyed) return;
        this.spawnInFlight = false;
        if (!ready || !this._process.isRunning()) {
          console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch skipped — provider not ready`);
          return;
        }
        let payload = taskText;
        if (!this.primed) {
          const role = buildSubSystemPrompt(this.def, this.readInstructions());
          payload = `${role}\n\n--- TASK ---\n${taskText}`;
          this.primed = true;
        }
        this._process.send(payload);
      })
      .catch((err) => console.warn(`[subagent:${this.sessionId}/${this.name}] dispatch failed:`, err));
  }
```

- [ ] **Step 6: publish 안전 — `transcript.jsonl`을 strip + gitignore에 추가**

`src/lib/session-manager.ts` 세션 생성 strip 조건(현 라인 718 부근):

```ts
            if (file.startsWith(".resume") || file === "sub.log" || file === "history.json" || file === "transcript.jsonl") {
```

같은 파일 publish `.gitignore` 생성 목록(현 라인 1516-1519 부근), `subagents/*/history.json` 줄 **다음**에 추가:

```ts
      "subagents/*/history.json",
      "subagents/*/transcript.jsonl",
```

- [ ] **Step 7: 타입 체크 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

> 참고: 이 시점에서 `subagent-manager.ts`는 아직 `new SubAgentInstance(...)`를 6인자로 호출한다. 7번째 인자가 optional이므로 tsc는 그린이다(다음 태스크에서 배선).

```bash
git add src/lib/subagent-instance.ts src/lib/session-manager.ts
git commit -m "feat(subagent): capture turn-complete response into transcript + OOC dispatch origin

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `SubAgentManager` + `SessionInstance` 배선

**Files:**
- Modify: `src/lib/subagent-manager.ts`
- Modify: `src/lib/session-instance.ts:307` (매니저 생성), `:780` (hook dispatch), `:805` (auto dispatch)

**Interfaces:**
- Consumes (Task 2): `SubAgentInstance` 생성자 7번째 인자 `onTranscript`, `dispatch(task, origin)`, `recordReport(summary)`, `readTranscript(n)`.
- Produces (Task 4에서 사용):
  - `SubAgentManager` 생성자 3번째 인자 `broadcast?: (event: string, data: unknown) => void`
  - `dispatch(name: string, task: string, origin?: TranscriptOrigin): boolean`
  - `recordReport(name: string, summary: string): boolean`
  - `listDetailed(): Array<{ name: string; role: string; provider: AIProvider; model?: string; running: boolean }>`
  - `readTranscript(name: string, n: number): TranscriptEntry[]`

- [ ] **Step 1: import 추가 (`subagent-manager.ts`)**

기존 import 블록에 추가:

```ts
import type { TranscriptEntry, TranscriptOrigin } from "./subagent-transcript";
```

- [ ] **Step 2: 생성자에 broadcast 콜백 추가**

```ts
export class SubAgentManager {
  private readonly sessionId: string;
  private readonly getDir: () => string | null;
  private readonly broadcast?: (event: string, data: unknown) => void;
  private subs = new Map<string, SubAgentInstance>();
  private defs = new Map<string, SubAgentDef>();

  constructor(
    sessionId: string,
    getDir: () => string | null,
    broadcast?: (event: string, data: unknown) => void,
  ) {
    this.sessionId = sessionId;
    this.getDir = getDir;
    this.broadcast = broadcast;
  }
```

- [ ] **Step 3: 인스턴스 생성 시 onTranscript 주입**

`spawnAll`의 `inst = new SubAgentInstance(def, dir, this.sessionId, subProvider, subModel, subEffort);` 줄을 교체:

```ts
        const subName = def.name;
        inst = new SubAgentInstance(
          def, dir, this.sessionId, subProvider, subModel, subEffort,
          (entry) => this.broadcast?.("subagent:message", { name: subName, entry }),
        );
```

- [ ] **Step 4: `dispatch` origin 파라미터 추가**

기존 `dispatch(name: string, task: string): boolean { ... }` 교체:

```ts
  /** Route a task to a named sub. Returns false if unknown/undeclared. */
  dispatch(name: string, task: string, origin: TranscriptOrigin = "delegate"): boolean {
    const inst = this.subs.get(name);
    if (!inst) {
      console.warn(`[subagent-manager:${this.sessionId}] dispatch to unknown sub "${name}"`);
      return false;
    }
    inst.dispatch(task, origin);
    return true;
  }
```

- [ ] **Step 5: `recordReport` / `listDetailed` / `readTranscript` 추가**

`has(name)` 메서드 **앞**에 추가:

```ts
  /** Record a sub→main report into the named sub's transcript. Returns false if unknown. */
  recordReport(name: string, summary: string): boolean {
    const inst = this.subs.get(name);
    if (!inst) return false;
    inst.recordReport(summary);
    return true;
  }

  /** Detailed list for the chat modal sidebar. */
  listDetailed(): Array<{ name: string; role: string; provider: AIProvider; model?: string; running: boolean }> {
    return [...this.subs.values()].map((s) => ({
      name: s.name,
      role: s.def.role,
      provider: s.provider,
      model: s.model,
      running: s.isRunning(),
    }));
  }

  /** Tail of a named sub's transcript. Returns [] if unknown. */
  readTranscript(name: string, n: number): TranscriptEntry[] {
    const inst = this.subs.get(name);
    return inst ? inst.readTranscript(n) : [];
  }
```

- [ ] **Step 6: `SessionInstance`에서 broadcast 주입 + origin 전달**

`src/lib/session-instance.ts:307`:

```ts
    this.subAgents = new SubAgentManager(id, () => this.getDir(), (ev, data) => this.broadcast(ev, data));
```

hook dispatch (현 라인 780 부근) — `this.subAgents.dispatch(to, task);` 교체:

```ts
                  const ok = this.subAgents.dispatch(to, task, "hook");
```

auto-trigger dispatch (현 라인 805 부근) — `this.subAgents.dispatch(def.name, ...);` 교체:

```ts
        this.subAgents.dispatch(def.name, `${task}\n\n[직전 메인 응답]\n${excerpt}`, "auto");
```

- [ ] **Step 7: 타입 체크 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

```bash
git add src/lib/subagent-manager.ts src/lib/session-instance.ts
git commit -m "feat(subagent): wire transcript broadcast + dispatch origin tagging

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 백엔드 라우트 (목록 / 직접입력 / transcript / report 기록)

**Files:**
- Create: `src/app/api/sessions/[id]/subagents/route.ts`
- Create: `src/app/api/sessions/[id]/subagents/[name]/message/route.ts`
- Create: `src/app/api/sessions/[id]/subagents/[name]/transcript/route.ts`
- Modify: `src/app/api/sessions/[id]/events/route.ts`

**Interfaces:**
- Consumes (Task 3): `instance.subAgents.listDetailed()`, `.dispatch(name, text, "operator")`, `.readTranscript(name, n)`, `.recordReport(name, summary)`.
- Produces (Task 5/6에서 fetch):
  - `GET /api/sessions/[id]/subagents` → `{ subs: Array<{name,role,provider,model,running}> }`
  - `POST /api/sessions/[id]/subagents/[name]/message` body `{text}` → `{ ok: true }`
  - `GET /api/sessions/[id]/subagents/[name]/transcript?n=200` → `{ entries: TranscriptEntry[] }`

- [ ] **Step 1: 목록 라우트**

Create `src/app/api/sessions/[id]/subagents/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });
  return NextResponse.json({ subs: instance.subAgents.listDetailed() });
}
```

- [ ] **Step 2: 직접입력 라우트**

Create `src/app/api/sessions/[id]/subagents/[name]/message/route.ts`:

```ts
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
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });

  const ok = instance.subAgents.dispatch(name, text, "operator");
  if (!ok) return NextResponse.json({ error: `Unknown or undeclared sub-agent "${name}"` }, { status: 404 });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: transcript 라우트**

Create `src/app/api/sessions/[id]/subagents/[name]/transcript/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id: rawId, name: rawName } = await params;
  const id = decodeURIComponent(rawId);
  const name = decodeURIComponent(rawName);
  const nParam = Number(req.nextUrl.searchParams.get("n"));
  const n = Number.isFinite(nParam) && nParam > 0 ? Math.min(nParam, 1000) : 200;

  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });

  return NextResponse.json({ entries: instance.subAgents.readTranscript(name, n) });
}
```

- [ ] **Step 4: events 라우트에서 `[SUB:]` → recordReport**

`src/app/api/sessions/[id]/events/route.ts`의 `instance.queueEvent(header.trim());` **다음**에 추가:

```ts
  instance.queueEvent(header.trim());
  // Mirror sub→main reports into the originating sub's transcript (does not affect queueing).
  const subMatch = /^\[SUB:([^\]]+)\]\s*([\s\S]*)$/.exec(header.trim());
  if (subMatch) {
    instance.subAgents.recordReport(subMatch[1].trim(), subMatch[2].trim());
  }
```

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 6: (선택) 런타임 스모크**

dev 서버가 떠 있고 서브 1개 세션이 활성이면(없으면 이 단계 건너뛰고 Task 끝의 라이브 스모크에서 확인):

Run: `curl -s "http://localhost:3340/api/sessions/<활성세션id>/subagents"`
Expected: `{"subs":[{"name":"...","role":"...","provider":"...","running":true}]}` 형태.

- [ ] **Step 7: 커밋**

```bash
git add "src/app/api/sessions/[id]/subagents/route.ts" "src/app/api/sessions/[id]/subagents/[name]/message/route.ts" "src/app/api/sessions/[id]/subagents/[name]/transcript/route.ts" "src/app/api/sessions/[id]/events/route.ts"
git commit -m "feat(subagent): routes for list/direct-message/transcript + report mirroring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 메신저형 모달 컴포넌트 (`SubAgentChatModal.tsx`)

> UI 작업이므로 구현 시작 시 `/frontend-design` 스킬을 먼저 참고할 것(CLAUDE.md 규약). 아래 코드는 동작하는 베이스라인이며 디자인 디테일은 프로젝트 토큰(`var(--surface)`, `var(--accent)` 등)을 따른다.

**Files:**
- Create: `src/components/SubAgentChatModal.tsx`

**Interfaces:**
- Consumes (Task 4): `GET /subagents`, `GET /subagents/[name]/transcript`, `POST /subagents/[name]/message`.
- Consumes (Task 1 타입): `TranscriptEntry` (props로 받는 라이브 엔트리).
- Produces (Task 6에서 사용):
  - `interface SubAgentChatModalProps { sessionId: string; open: boolean; onClose: () => void; liveEntry?: { name: string; entry: TranscriptEntry } | null; activeSubName: string | null; onActiveSubChange: (name: string) => void; }`
  - default export `SubAgentChatModal`

- [ ] **Step 1: 컴포넌트 작성**

Create `src/components/SubAgentChatModal.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { TranscriptEntry } from "@/lib/subagent-transcript";

interface SubInfo {
  name: string;
  role: string;
  provider: string;
  model?: string;
  running: boolean;
}

export interface SubAgentChatModalProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  /** Latest live transcript entry pushed over WS (Task 6 forwards subagent:message). */
  liveEntry?: { name: string; entry: TranscriptEntry } | null;
  /** Currently focused sub in the sidebar (lifted to page for unread tracking). */
  activeSubName: string | null;
  onActiveSubChange: (name: string) => void;
}

export default function SubAgentChatModal({
  sessionId, open, onClose, liveEntry, activeSubName, onActiveSubChange,
}: SubAgentChatModalProps) {
  const [subs, setSubs] = useState<SubInfo[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEscapeKey(onClose, open);

  // Load sub list when opened.
  useEffect(() => {
    if (!open) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`)
      .then((r) => r.json())
      .then((d) => {
        const list: SubInfo[] = d.subs || [];
        setSubs(list);
        if (!activeSubName && list.length > 0) onActiveSubChange(list[0].name);
      })
      .catch(() => {});
  }, [open, sessionId, activeSubName, onActiveSubChange]);

  // Load transcript when the focused sub changes (or modal opens).
  useEffect(() => {
    if (!open || !activeSubName) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(activeSubName)}/transcript?n=200`)
      .then((r) => r.json())
      .then((d) => setEntries(d.entries || []))
      .catch(() => setEntries([]));
  }, [open, sessionId, activeSubName]);

  // Append live entries for the focused sub.
  useEffect(() => {
    if (!liveEntry || liveEntry.name !== activeSubName) return;
    setEntries((prev) => [...prev, liveEntry.entry]);
  }, [liveEntry, activeSubName]);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeSubName || sending) return;
    setSending(true);
    setInput("");
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(activeSubName)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch { /* ignore */ } finally {
      setSending(false);
    }
  }, [input, activeSubName, sending, sessionId]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[4px]" onClick={onClose} />
      <div
        className="relative z-[9999] w-full max-w-[900px] h-[80vh] flex rounded-2xl overflow-hidden border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
        style={{ backgroundColor: "var(--surface, rgb(15,15,26))" }}
      >
        {/* Sidebar */}
        <div className="w-[200px] shrink-0 border-r border-white/[0.06] flex flex-col">
          <div className="px-4 py-3 border-b border-white/[0.06] text-[12px] font-semibold uppercase tracking-wider"
               style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}>
            서브에이전트
          </div>
          <div className="flex-1 overflow-y-auto">
            {subs.length === 0 && (
              <div className="px-4 py-3 text-xs text-text-dim">등록된 서브가 없습니다.</div>
            )}
            {subs.map((s) => (
              <button
                key={s.name}
                onClick={() => onActiveSubChange(s.name)}
                className={`w-full text-left px-4 py-2.5 text-xs transition-colors ${
                  s.name === activeSubName ? "bg-white/[0.06] text-text" : "text-text-dim hover:bg-white/[0.03]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${s.running ? "bg-success" : "bg-error"}`} />
                  <span className="truncate font-medium">{s.name}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-text-dim/70 truncate">{s.provider}{s.model ? ` · ${s.model}` : ""}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Transcript + input */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <span className="text-sm font-medium truncate">{activeSubName || "—"}</span>
            <button onClick={onClose} aria-label="닫기" className="text-white/40 hover:text-white/80 p-1">✕</button>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
            {entries.map((e, i) => <TranscriptRow key={i} e={e} />)}
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-white/[0.06]">
            <input
              value={input}
              onChange={(ev) => setInput(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); void handleSend(); } }}
              placeholder={activeSubName ? `${activeSubName}에게 직접 말하기…` : "서브를 선택하세요"}
              disabled={!activeSubName || sending}
              className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text outline-none focus:border-accent/60"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || !activeSubName || sending}
              className="px-3 py-2 rounded-lg text-sm bg-accent/20 text-accent border border-accent/40 disabled:opacity-30"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TranscriptRow({ e }: { e: TranscriptEntry }) {
  // operator dispatch → right bubble; response → left bubble;
  // auto/hook/delegate dispatch → faint system line; report → →메인 chip.
  if (e.kind === "report") {
    return (
      <div className="text-[11px] text-amber-300/80 italic">→메인: {e.text}</div>
    );
  }
  if (e.kind === "dispatch" && e.origin !== "operator") {
    return (
      <div className="text-[11px] text-text-dim/60 italic truncate" title={e.text}>
        ⟳ {e.origin}: {e.text}
      </div>
    );
  }
  const isOperator = e.kind === "dispatch" && e.origin === "operator";
  return (
    <div className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
          isOperator ? "bg-accent/20 text-text" : "bg-white/[0.05] text-text"
        }`}
      >
        {e.text}
      </div>
    </div>
  );
}
```

> **Step 1 주의:** 텍스트는 plain 렌더(`whitespace-pre-wrap break-words`)로 둔다. 메인 채팅의 `tokenize`(`@/lib/inline-formatter`)는 RP 전용 판별 유니온(`kind`+`value`, bold/action=`*`)이라 terse한 서브 작업 텍스트엔 부적합하고 결합도만 높인다 — 인라인 포맷은 후속 옵션. `success`/`error`/`text-dim`/`accent`/`surface` Tailwind 토큰은 StatusBar 등에서 사용 중이라 존재한다(그대로 사용).

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음. (`tokenize` 반환 타입 불일치 시 위 주의대로 수정.)

- [ ] **Step 3: 커밋**

```bash
git add src/components/SubAgentChatModal.tsx
git commit -m "feat(subagent): messenger-style chat modal component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: StatusBar 통합 + 페이지 배선 (WS/unread/모달 마운트)

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx`

**Interfaces:**
- Consumes (Task 5): `SubAgentChatModal`, `SubAgentChatModalProps`.
- Consumes (Task 3/4): WS 이벤트 `subagent:message` → `{ name, entry }`.
- StatusBar 신규 props: `onSubAgents?: () => void`, `subAgentUnread?: number`.

- [ ] **Step 1: StatusBar에 props + 메뉴 항목 + 배지 추가**

`StatusBarProps`에 추가:

```ts
  /** Sub-agent chat modal */
  onSubAgents?: () => void;
  subAgentUnread?: number;
```

함수 파라미터 구조분해에 `onSubAgents, subAgentUnread,` 추가.

`hasDebugItems` 계산에 `onSubAgents` 포함:

```ts
  const hasDebugItems = onUsage || onCompact || onContext || onReinit || (!isBuilderMode && onSync) || onForceInputToggle || onSessionList || onSubAgents;
```

도구 드롭다운 메뉴에서 `{onSessionList && (...)}` 항목 **다음**에 추가:

```tsx
                {onSubAgents && (
                  <button
                    onClick={() => { onSubAgents(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    서브에이전트{subAgentUnread ? ` (${subAgentUnread})` : ""}
                  </button>
                )}
```

도구 버튼(☰, `ref={debugBtnRef}`)에 안읽음 점 배지 — 버튼을 감싸는 `<>` 안에서 버튼을 `relative`로 두고 배지 span 추가. 기존 버튼 `className`에 `relative` 추가하고 버튼 닫기 태그 바로 다음(같은 부모) 에 추가:

```tsx
            {!!subAgentUnread && subAgentUnread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-[9px] leading-[14px] text-center text-black font-bold pointer-events-none">
                {subAgentUnread > 9 ? "9+" : subAgentUnread}
              </span>
            )}
```

> 배지가 버튼 기준으로 위치하려면 버튼이 `relative`여야 한다. 도구 버튼 `className` 문자열 앞에 `relative `를 추가할 것. 배지 span은 그 버튼과 같은 부모(`<>` fragment) 안, 버튼 `</button>` 다음에 둔다.

- [ ] **Step 2: 페이지에 상태 + import 추가 (`chat/[sessionId]/page.tsx`)**

import 추가(다른 컴포넌트 import 근처):

```tsx
import SubAgentChatModal from "@/components/SubAgentChatModal";
import type { TranscriptEntry } from "@/lib/subagent-transcript";
```

상태 추가(`const [drawerOpen, setDrawerOpen] = useState(false);` 근처):

```tsx
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [activeSubName, setActiveSubName] = useState<string | null>(null);
  const [subLiveEntry, setSubLiveEntry] = useState<{ name: string; entry: TranscriptEntry } | null>(null);
  const [subUnread, setSubUnread] = useState<Record<string, number>>({});
```

- [ ] **Step 3: WS 핸들러 추가**

`useWebSocket`에 넘기는 `handlers` 객체에 `subagent:message` 추가(기존 `event:pending` 핸들러 근처). 모달 열림+해당 서브 포커스면 라이브 append, 아니면 unread++:

```tsx
        "subagent:message": (d) => {
          const { name, entry } = d as { name: string; entry: TranscriptEntry };
          setSubLiveEntry({ name, entry });
          const focused = subModalOpen && activeSubName === name;
          // Only sub-originated turns (responses/reports) count as unread, not our own dispatches.
          if (!focused && entry.dir === "out") {
            setSubUnread((prev) => ({ ...prev, [name]: (prev[name] || 0) + 1 }));
          }
        },
```

> `subModalOpen`/`activeSubName`을 핸들러에서 읽으므로, `useWebSocket`이 최신 클로저를 쓰는지 확인. `useWebSocket`은 내부에서 `handlersRef.current = handlers`로 매 렌더 최신화하므로(검증됨: `useWebSocket.ts:42-43`) 클로저는 항상 최신이다.

- [ ] **Step 4: 모달 열기 핸들러 + 마운트**

StatusBar에 props 전달(기존 `<StatusBar ... />`에 추가):

```tsx
        onSubAgents={() => setSubModalOpen(true)}
        subAgentUnread={Object.values(subUnread).reduce((a, b) => a + b, 0)}
```

JSX 트리(다른 모달들과 같은 레벨, 예: `<PanelDrawer .../>` 근처)에 모달 마운트:

```tsx
        <SubAgentChatModal
          sessionId={sessionId}
          open={subModalOpen}
          onClose={() => setSubModalOpen(false)}
          liveEntry={subLiveEntry}
          activeSubName={activeSubName}
          onActiveSubChange={(name) => {
            setActiveSubName(name);
            setSubUnread((prev) => ({ ...prev, [name]: 0 }));
          }}
        />
```

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/components/StatusBar.tsx "src/app/chat/[sessionId]/page.tsx"
git commit -m "feat(subagent): integrate chat modal into status bar + ws/unread wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 라이브 스모크 (사용자 실행 — 단일사용자 라이브 서비스)

`npx tsc --noEmit` 그린 확인 후, dev 서버(`npm run dev`, port 3340)에서:

1. 서브 1개 이상 정의된 페르소나로 세션 open → 상단 도구 메뉴(☰) → "서브에이전트" 클릭 → 모달 좌측에 서브 표시·running 점(초록) 확인.
2. 서브 선택 → 입력창에 직접 메시지 → 서브가 **대화체로 응답**(내 말풍선 우측, 서브 응답 좌측) + `data/sessions/{id}/subagents/{name}/transcript.jsonl`에 `dispatch(operator)` / `response` 라인 기록 확인.
3. 메인 채팅을 한 턴 진행 → autoTrigger/hook 서브가 있으면 모달 transcript에 옅은 `⟳ auto/hook` 시스템 라인으로 쌓이는지.
4. 서브가 상태 변경 후 `report_to_main` → 모달에 `→메인` 칩 + 메인 다음 턴에 `[SUB:]` 합류 동시 확인.
5. 모달 닫은 상태에서 서브가 응답/report → 도구 메뉴 "서브에이전트 (N)" 카운트 + ☰ 배지 증가 → 모달 열고 그 서브 포커스 시 0으로 클리어.
6. (v2.1 핀 사용 시) 세션과 다른 provider 서브(예: claude 세션 + gemini 서브)도 응답이 캡처되는지 — provider별 캡처 경로 검증.

이슈 발견 시 systematic-debugging으로 대응.

---

## Self-Review (작성자 체크 결과)

- **Spec 커버리지:** §1 데이터모델→Task1, §2 캡처→Task1+2, §3 origin/OOC→Task2+3, §4 라우트→Task4, §5 WS/배선→Task3+6, §6 UI→Task5+6, publish 안전→Task2, 알려진 한계(인터리브/무한증가/autoTrigger 노이즈)→설계대로 수용(tail 캡 N=200은 Task4 라우트·Task1 reader에 반영). 모든 섹션에 대응 태스크 존재.
- **Placeholder 스캔:** 없음(모든 코드 실체 포함). UI Task의 `tokenize` 필드명·Tailwind 토큰 확인 주의는 플레이스홀더가 아니라 검증 지시.
- **타입 일관성:** `TranscriptEntry`/`TranscriptOrigin`/`dispatch(name,task,origin)`/`recordReport`/`listDetailed`/`readTranscript` 시그니처가 Task1→2→3→4→5/6에서 일치. 생성자 7번째 인자 `onTranscript`는 optional이라 Task2 단독 커밋도 tsc 그린.
