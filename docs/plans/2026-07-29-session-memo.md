# 세션 메모 (Session Memo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로비 사이드바 세션 카드에 세션별 한 줄 메모(수동 + AI 자동 + 최근 발화 폴백)를 표시하고 로비/채팅 양쪽에서 편집할 수 있게 한다.

**Architecture:** `session.json`에 `memo`(수동)/`autoMemo`(AI)/`autoMemoAt`/`memoAuto`(옵트아웃) 필드를 추가하고 기존 `patchSessionMeta`(tmp+rename 원자 쓰기)로 갱신한다. 자동 갱신은 `session-instance.ts`가 비-OOC assistant 턴 종료마다 카운터를 올리다 10턴째에 `queueEvent("[MEMO] …")`로 다음 유저 턴에 지시 헤더를 병합하고, 세션 AI가 신규 MCP 도구 `bridge_set_session_memo`를 호출해 `autoMemo`를 채운다. 표시 우선순위는 `memo → autoMemo → 최근 유저 발화 프리뷰`.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind 3, `@modelcontextprotocol/sdk` (MCP 서버는 `.mjs` + zod).

## Global Constraints

- 스펙 원본: `docs/specs/2026-07-29-session-memo-design.md`
- TypeScript strict — `any` 금지. `npm run typecheck`는 매 태스크 끝에 통과해야 한다.
- 자동 요약 간격 = **10턴**, 요약 길이 지시 = **25자 이내**, 서버측 하드 클램프 = **200자**.
- 자동 요약 기본값 = **ON** (`memoAuto` 미설정 = true).
- `memo`(수동)는 자동 갱신이 **절대** 덮어쓰지 않는다.
- UI 문자열·주석은 한국어. 코드 식별자는 영어.
- 저장소 경로에 공백이 있으므로 셸 명령의 경로는 항상 따옴표로 감싼다.
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- 테스트 프레임워크 없음. 순수 함수는 `node:test` + `npx tsx --test <파일>`로 직접 실행한다.

## File Structure

| 파일 | 책임 |
|------|------|
| `src/lib/session-memo.ts` (신규) | 메모 순수 로직: 발화 프리뷰 추출, 길이 클램프. 파일 I/O 없음 → 단위 테스트 가능 |
| `src/lib/session-memo.test.ts` (신규) | 위 순수 함수 테스트 |
| `src/lib/session-manager.ts` | `SessionMeta`/`SessionInfo` 필드, `setSessionMemo`/`setSessionAutoMemo`/`setSessionMemoAuto`, `listSessions`의 프리뷰 주입 |
| `src/app/api/sessions/[id]/memo/route.ts` (신규) | 얇은 PATCH 라우트 |
| `src/lib/session-instance.ts` | `runSessionMemoTick()` + `[MEMO]` 싱글턴 프리픽스 + 호출 배선 |
| `src/mcp/claude-play-mcp-server.mjs` | `bridge_set_session_memo` 도구 |
| `src/components/SessionCard.tsx` | 메모 줄 + 인라인 편집 |
| `src/app/page.tsx` | 로비 상태/저장 핸들러 |
| `src/components/StatusBar.tsx` | 채팅 헤더 메모 칩 + 팝오버 |
| `src/app/chat/[sessionId]/page.tsx` | 메모 상태 + StatusBar 배선 |
| `src/app/api/sessions/[id]/open/route.ts` | open 응답에 `memo` 포함 |
| `docs/data-model.md`, `docs/api-routes.md`, `HANDOVER.md` | 문서 반영 |

---

### Task 1: 메모 순수 로직 (`session-memo.ts`)

**Files:**
- Create: `src/lib/session-memo.ts`
- Test: `src/lib/session-memo.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `MEMO_MAX_LEN: 200`
  - `clampMemo(input: unknown): string` — 문자열 아니면 `""`, `trim()` 후 200자 자름
  - `extractLastUserPreview(raw: string, maxLen?: number): string | undefined` — `chat-history.json` 원문(JSON 문자열)에서 마지막 `role === "user"` 메시지 1줄 추출. 기본 `maxLen = 60`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/session-memo.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMemo, extractLastUserPreview, MEMO_MAX_LEN } from "./session-memo";

test("clampMemo: 앞뒤 공백을 제거한다", () => {
  assert.equal(clampMemo("  배신 루트  "), "배신 루트");
});

test("clampMemo: 문자열이 아니면 빈 문자열", () => {
  assert.equal(clampMemo(null), "");
  assert.equal(clampMemo(42), "");
  assert.equal(clampMemo(undefined), "");
});

test("clampMemo: MEMO_MAX_LEN으로 자른다", () => {
  const out = clampMemo("가".repeat(500));
  assert.equal(out.length, MEMO_MAX_LEN);
});

test("extractLastUserPreview: 배열 형식 history에서 마지막 user 발화를 뽑는다", () => {
  const raw = JSON.stringify([
    { role: "user", content: "첫 발화" },
    { role: "assistant", content: "응답" },
    { role: "user", content: "마지막 발화" },
    { role: "assistant", content: "응답2" },
  ]);
  assert.equal(extractLastUserPreview(raw), "마지막 발화");
});

test("extractLastUserPreview: {messages:[…]} 형식도 지원한다", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "래핑된 발화" }] });
  assert.equal(extractLastUserPreview(raw), "래핑된 발화");
});

test("extractLastUserPreview: 개행/연속 공백을 한 줄로 접는다", () => {
  const raw = JSON.stringify([{ role: "user", content: "첫 줄\n\n둘째   줄" }]);
  assert.equal(extractLastUserPreview(raw), "첫 줄 둘째 줄");
});

test("extractLastUserPreview: maxLen 초과 시 말줄임표를 붙인다", () => {
  const raw = JSON.stringify([{ role: "user", content: "가".repeat(80) }]);
  const out = extractLastUserPreview(raw, 60);
  assert.equal(out, "가".repeat(60) + "…");
});

test("extractLastUserPreview: 이벤트 헤더 줄은 건너뛴다", () => {
  const raw = JSON.stringify([
    { role: "user", content: "진짜 발화" },
    { role: "user", content: "[MEMO] 지금까지의 전개를 요약하세요" },
  ]);
  assert.equal(extractLastUserPreview(raw), "진짜 발화");
});

test("extractLastUserPreview: 파싱 실패하면 undefined", () => {
  assert.equal(extractLastUserPreview("{깨진 json"), undefined);
});

test("extractLastUserPreview: user 발화가 없으면 undefined", () => {
  const raw = JSON.stringify([{ role: "assistant", content: "혼잣말" }]);
  assert.equal(extractLastUserPreview(raw), undefined);
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npx tsx --test "src/lib/session-memo.test.ts"`
Expected: FAIL — `Cannot find module './session-memo'`

- [ ] **Step 3: 최소 구현 작성**

`src/lib/session-memo.ts`:

```ts
/** 세션 메모의 순수 로직. 파일 I/O 없이 문자열만 다룬다. */

/** session.json에 저장되는 메모 최대 길이(문자). */
export const MEMO_MAX_LEN = 200;

/** 이벤트 헤더 줄(`[MEMO] …`, `[TIME] …`)은 유저가 친 말이 아니므로 프리뷰에서 제외한다. */
const EVENT_HEADER = /^\[[A-Z_]+\]/;

/** 임의 입력을 저장 가능한 메모 문자열로 정규화한다. */
export function clampMemo(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, MEMO_MAX_LEN);
}

/**
 * chat-history.json 원문에서 마지막 유저 발화를 한 줄로 뽑는다.
 * 수동/자동 메모가 둘 다 없을 때 세션 카드에 띄우는 최후 폴백.
 */
export function extractLastUserPreview(raw: string, maxLen = 60): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const msgs = Array.isArray(parsed)
    ? parsed
    : (parsed as { messages?: unknown; history?: unknown })?.messages
      ?? (parsed as { history?: unknown })?.history;
  if (!Array.isArray(msgs)) return undefined;

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    const oneLine = m.content.replace(/\s+/g, " ").trim();
    if (!oneLine || EVENT_HEADER.test(oneLine)) continue;
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
  }
  return undefined;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --test "src/lib/session-memo.test.ts"`
Expected: PASS — 10 tests

- [ ] **Step 5: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/lib/session-memo.ts src/lib/session-memo.test.ts
git commit -m "feat(memo): 세션 메모 순수 로직 + 테스트

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: session-manager 필드 · setter · 프리뷰 주입

**Files:**
- Modify: `src/lib/session-manager.ts` (`SessionInfo` ~102-112, `SessionMeta` ~154-165, `listSessions` ~729-765, setter는 ~850 이후 append)

**Interfaces:**
- Consumes: Task 1의 `clampMemo`, `extractLastUserPreview`, `MEMO_MAX_LEN`
- Produces:
  - `SessionInfo`에 `memo?: string`, `autoMemo?: string`, `autoMemoAt?: string`, `memoAuto?: boolean`, `memoFallback?: string`
  - `setSessionMemo(id: string, memo: string): void`
  - `setSessionAutoMemo(id: string, text: string): void`
  - `setSessionMemoAuto(id: string, enabled: boolean): void`
  - `getSessionMemoState(id: string): { memo?: string; autoMemo?: string; autoMemoAt?: string; memoAuto?: boolean }`

- [ ] **Step 1: import 추가**

`src/lib/session-manager.ts` 상단 import 블록(기존 `import { SYSTEM_JSON, mutateSessionJsonSync } from "./session-state";` 아래)에 추가:

```ts
import { clampMemo, extractLastUserPreview } from "./session-memo";
```

- [ ] **Step 2: 타입 필드 추가**

`SessionMeta` 인터페이스(현 154-165행)에 추가:

```ts
  /** 사용자가 직접 쓴 메모. 자동 갱신이 절대 덮어쓰지 않는다. */
  memo?: string;
  /** 세션 AI가 주기적으로 갱신하는 한 줄 요약. */
  autoMemo?: string;
  /** autoMemo 갱신 시각(ISO). */
  autoMemoAt?: string;
  /** 자동 요약 옵트아웃. 미설정 = 켜짐. */
  memoAuto?: boolean;
```

`SessionInfo` 인터페이스(현 102-112행)에 추가:

```ts
  memo?: string;
  autoMemo?: string;
  autoMemoAt?: string;
  memoAuto?: boolean;
  /** 메모가 하나도 없을 때 카드에 띄울 최근 유저 발화 1줄. */
  memoFallback?: string;
```

- [ ] **Step 3: `listSessions`에 프리뷰 주입**

현 `listSessions()`는 `chat-history.json`을 `statSync`로만 만진다(745-752행). 같은 블록에서 내용을 한 번 읽어 프리뷰까지 뽑도록 바꾼다. 기존:

```ts
          const historyPath = path.join(dir, d.name, "chat-history.json");
          let lastActivity = new Date(meta.createdAt).getTime();
          try {
            if (fs.existsSync(historyPath)) {
              lastActivity = fs.statSync(historyPath).mtimeMs;
            }
          } catch { /* ignore */ }
```

를 다음으로 교체:

```ts
          const historyPath = path.join(dir, d.name, "chat-history.json");
          let lastActivity = new Date(meta.createdAt).getTime();
          let memoFallback: string | undefined;
          try {
            if (fs.existsSync(historyPath)) {
              lastActivity = fs.statSync(historyPath).mtimeMs;
              // 메모가 둘 다 없을 때만 폴백 프리뷰를 계산한다(불필요한 파일 읽기 회피).
              if (!meta.memo && !meta.autoMemo) {
                memoFallback = extractLastUserPreview(fs.readFileSync(historyPath, "utf-8"));
              }
            }
          } catch { /* ignore */ }
```

그리고 `acc.push({...})`에 스프레드를 추가:

```ts
            ...(memoFallback ? { memoFallback } : {}),
```

- [ ] **Step 4: setter 추가**

`getAntigravityCascadeId` 메서드(현 853행) 바로 아래에 추가:

```ts
  /** 사용자가 쓴 메모를 저장한다. 빈 문자열이면 필드를 지운다. */
  setSessionMemo(id: string, memo: string): void {
    const value = clampMemo(memo);
    this.patchSessionMeta(id, (m) => {
      if (value) m.memo = value;
      else delete m.memo;
    });
  }

  /** 세션 AI가 쓴 자동 요약을 저장한다. 수동 memo는 건드리지 않는다. */
  setSessionAutoMemo(id: string, text: string): void {
    const value = clampMemo(text);
    this.patchSessionMeta(id, (m) => {
      if (value) {
        m.autoMemo = value;
        m.autoMemoAt = new Date().toISOString();
      } else {
        delete m.autoMemo;
        delete m.autoMemoAt;
      }
    });
  }

  /** 자동 요약 on/off. */
  setSessionMemoAuto(id: string, enabled: boolean): void {
    this.patchSessionMeta(id, (m) => {
      if (enabled) delete m.memoAuto;
      else m.memoAuto = false;
    });
  }

  /** 메모 관련 필드만 읽어 반환한다(라우트 응답용). */
  getSessionMemoState(id: string): { memo?: string; autoMemo?: string; autoMemoAt?: string; memoAuto?: boolean } {
    const meta = this.readSessionMeta(id);
    if (!meta) return {};
    return {
      ...(meta.memo ? { memo: meta.memo } : {}),
      ...(meta.autoMemo ? { autoMemo: meta.autoMemo } : {}),
      ...(meta.autoMemoAt ? { autoMemoAt: meta.autoMemoAt } : {}),
      ...(meta.memoAuto === false ? { memoAuto: false } : {}),
    };
  }
```

- [ ] **Step 5: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/lib/session-manager.ts
git commit -m "feat(memo): session.json 메모 필드 + setter + 폴백 프리뷰

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: PATCH `/api/sessions/[id]/memo` 라우트

**Files:**
- Create: `src/app/api/sessions/[id]/memo/route.ts`

**Interfaces:**
- Consumes: Task 2의 `setSessionMemo` / `setSessionAutoMemo` / `setSessionMemoAuto` / `getSessionMemoState`
- Produces: `PATCH /api/sessions/{id}/memo` — body `{ memo }` | `{ autoMemo }` | `{ memoAuto }`, 응답 `{ memo?, autoMemo?, autoMemoAt?, memoAuto? }`

- [ ] **Step 1: 라우트 작성**

기존 라우트 스타일(`src/app/api/sessions/[id]/options/route.ts`)을 따라 얇게 유지한다:

```ts
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** 세션 메모 갱신. memo=사용자 수동, autoMemo=세션 AI 자동, memoAuto=자동 요약 on/off. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const hasMemo = "memo" in body;
  const hasAuto = "autoMemo" in body;
  const hasToggle = "memoAuto" in body;

  if (hasMemo && hasAuto) {
    return NextResponse.json({ error: "memo와 autoMemo는 동시에 보낼 수 없습니다" }, { status: 400 });
  }
  if (!hasMemo && !hasAuto && !hasToggle) {
    return NextResponse.json({ error: "memo, autoMemo, memoAuto 중 하나가 필요합니다" }, { status: 400 });
  }

  const { sessions } = getServices();
  if (!sessions.getSessionInfo(id)) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  if (hasMemo) {
    if (typeof body.memo !== "string") {
      return NextResponse.json({ error: "memo must be a string" }, { status: 400 });
    }
    sessions.setSessionMemo(id, body.memo);
  }
  if (hasAuto) {
    if (typeof body.autoMemo !== "string") {
      return NextResponse.json({ error: "autoMemo must be a string" }, { status: 400 });
    }
    sessions.setSessionAutoMemo(id, body.autoMemo);
  }
  if (hasToggle) {
    if (typeof body.memoAuto !== "boolean") {
      return NextResponse.json({ error: "memoAuto must be a boolean" }, { status: 400 });
    }
    sessions.setSessionMemoAuto(id, body.memoAuto);
  }

  // patchSessionMeta는 쓰기 실패를 삼키므로 재조회로 확인한다.
  return NextResponse.json(sessions.getSessionMemoState(id));
}
```

- [ ] **Step 2: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 3: 라이브 확인**

dev 서버가 떠 있다면(`npm run dev`, port 3340) 실제 세션 id 하나로:

```bash
curl -s -X PATCH "http://localhost:3340/api/sessions/<SESSION_ID>/memo" \
  -H "Content-Type: application/json" -H "x-bridge-token: $ADMIN_TOKEN" \
  -d '{"memo":"스모크 테스트"}'
```

Expected: `{"memo":"스모크 테스트"}`. `ADMIN_PASSWORD`가 설정된 환경이라 토큰 없이 호출하면 401이 정상 — 그 경우 이 단계는 건너뛰고 Task 7의 UI 스모크에서 확인한다.

- [ ] **Step 4: 커밋**

```bash
git add "src/app/api/sessions/[id]/memo/route.ts"
git commit -m "feat(memo): PATCH /api/sessions/[id]/memo 라우트

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 자동 갱신 틱 (`session-instance.ts`)

**Files:**
- Modify: `src/lib/session-instance.ts` (`REPLACE_ONLY_PREFIXES` ~66, `runStyleCheckHook` 뒤에 신규 메서드, 호출부 ~1656)

**Interfaces:**
- Consumes: 기존 `queueEvent()`, `mutateSessionJsonSync`, `this.getDir()`
- Produces: `runSessionMemoTick(): void` — 부작용은 `variables.json` 카운터 증분 + `pending-events.json` 헤더 큐잉

- [ ] **Step 1: `[MEMO]`를 싱글턴 프리픽스로 등록**

`REPLACE_ONLY_PREFIXES` Set(현 66-70행)에 항목 추가:

```ts
  "[MEMO]",
```

이유: 유저가 오래 자리를 비워 임계를 여러 번 넘겨도 헤더가 쌓이지 않고 최신 1개만 남는다.

- [ ] **Step 2: 틱 메서드 추가**

`runStyleCheckHook()` 메서드가 끝나는 지점 바로 뒤에 추가:

```ts
  /**
   * 세션 메모 자동 갱신 틱. 비-OOC assistant 턴 종료마다 호출된다.
   *
   * 코어가 카운터를 관리하고(variables.json `__session_memo_counter`),
   * MEMO_INTERVAL_TURNS 턴마다 다음 유저 턴에 병합될 [MEMO] 지시 헤더를 큐잉한다.
   * 실제 요약은 세션 AI가 bridge_set_session_memo MCP 도구로 저장한다 —
   * 별도 LLM 스폰이 없어 추가 비용이 도구 호출 1건 수준이다.
   *
   * 옵트아웃: session.json `memoAuto: false`.
   */
  runSessionMemoTick(): void {
    const dir = this.getDir();
    if (!dir) return;

    // 옵트아웃 확인 — 꺼져 있으면 카운터도 올리지 않는다.
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf-8")) as { memoAuto?: boolean };
      if (meta.memoAuto === false) return;
    } catch {
      return;
    }

    try {
      const varsPath = path.join(dir, "variables.json");
      let counter = 0;
      const cr = mutateSessionJsonSync(varsPath, (current) => {
        counter = (Number(current.__session_memo_counter) || 0) + 1;
        return { ...current, __session_memo_counter: counter };
      });
      // variables.json을 읽지 못하면 카운터 증분이 실패하므로 이번 틱은 건너뛴다
      // (쓰기 무결성: 못 읽은 상태로 덮어쓰지 않는다 — style-check와 같은 규칙).
      if (!cr.ok) return;
      if (counter % MEMO_INTERVAL_TURNS !== 0) return;

      this.queueEvent(
        "[MEMO] 지금까지의 전개를 25자 이내 한 줄로 요약해 bridge_set_session_memo 도구로 저장하세요. 응답 본문에서는 이 지시를 언급하지 마세요."
      );
    } catch (err) {
      console.error("[session-memo] tick error:", err);
    }
  }
```

- [ ] **Step 3: 간격 상수 추가**

`REPLACE_ONLY_PREFIXES` 선언 근처(파일 상단 상수 블록)에 추가:

```ts
/** 세션 메모 자동 요약 주기(비-OOC assistant 턴 수). */
const MEMO_INTERVAL_TURNS = 10;
```

- [ ] **Step 4: 호출 배선**

현 1652-1657행의 블록을 다음으로 바꾼다:

```ts
      if (!isOOC) {
        const lastAsst = [...this.chatHistory].reverse().find(m => m.role === "assistant");
        if (lastAsst && typeof lastAsst.content === "string" && lastAsst.content) {
          this.runAssistantHooks(lastAsst.content);
          this.runStyleCheckHook();
          this.runSessionMemoTick();
        }
      }
```

- [ ] **Step 5: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "feat(memo): 10턴마다 자동 요약 지시를 큐잉하는 메모 틱

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: MCP 도구 `bridge_set_session_memo`

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs` (`bridge_status` 등록부 ~345 이후 아무 곳)

**Interfaces:**
- Consumes: Task 3의 `PATCH /api/sessions/{id}/memo`, 기존 헬퍼 `requestJson` / `ok` / `fail` / `pickString` / `sessionId` / `mode`
- Produces: MCP 도구 `bridge_set_session_memo({ memo: string })`

- [ ] **Step 1: 도구 등록**

`bridge_status` 등록 블록 바로 뒤에 추가:

```js
server.registerTool(
  "bridge_set_session_memo",
  {
    description:
      "Save a one-line memo describing the current state of this session. Shown on the lobby session card so the user can tell sessions of the same persona apart. Keep it under 25 characters, in the user's language, and describe the situation — not the last line of dialogue. This never overwrites the user's own manual memo.",
    inputSchema: {
      memo: z.string(),
    },
  },
  async ({ memo }) => {
    if (mode !== "session" || !sessionId) {
      return fail(new Error("bridge_set_session_memo is only available in session mode"));
    }
    try {
      const data = await requestJson(
        "PATCH",
        `/api/sessions/${encodeURIComponent(sessionId)}/memo`,
        { autoMemo: pickString(memo) || "" }
      );
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);
```

- [ ] **Step 2: `requestJson` 시그니처 확인**

Run: `grep -n "async function requestJson" -A 12 "src/mcp/claude-play-mcp-server.mjs"`
Expected: `(method, route, body)` 형태 — 세 번째 인자가 body가 아니라면 위 호출을 실제 시그니처에 맞춘다.

- [ ] **Step 3: 정적 검사**

Run: `npm run check:static`
Expected: 통과 (MCP `.mjs`는 tsc 대상이 아니므로 이 게이트로 확인한다)

- [ ] **Step 4: 커밋**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "feat(memo): bridge_set_session_memo MCP 도구

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 로비 세션 카드 — 메모 줄 + 인라인 편집

**Files:**
- Modify: `src/components/SessionCard.tsx`
- Modify: `src/app/page.tsx` (`Session` 인터페이스 ~41-50, `SessionCard` 사용부 ~310-327)

**Interfaces:**
- Consumes: Task 3의 PATCH 라우트, Task 2가 API 응답에 실어 보내는 `memo`/`autoMemo`/`memoFallback`
- Produces: `SessionCardProps`에 `memo?: string`, `autoMemo?: string`, `memoFallback?: string`, `onMemoSave: (memo: string) => Promise<boolean>`

- [ ] **Step 1: SessionCard props 확장**

`SessionCardProps`에 추가:

```ts
  memo?: string;
  autoMemo?: string;
  memoFallback?: string;
  onMemoSave: (memo: string) => Promise<boolean>;
```

컴포넌트 시그니처 구조분해에도 `memo, autoMemo, memoFallback, onMemoSave`를 추가한다.

- [ ] **Step 2: 편집 상태 추가**

`confirmDelete` state 선언 아래에 추가:

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // 표시 우선순위: 수동 메모 → AI 자동 메모 → 최근 발화 프리뷰
  const shownMemo = memo || autoMemo || memoFallback || "";
  const isManual = !!memo;

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(memo || "");
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next === (memo || "")) return;
    await onMemoSave(next);
  };
```

- [ ] **Step 3: 메모 줄 렌더**

카드 본문의 메타 줄(`<div className="text-[10px] text-text-mute mt-0.5 …">…</div>`)을 닫은 직후, 같은 `flex-1 min-w-0` 컨테이너 안에 추가:

```tsx
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
            maxLength={200}
            placeholder="메모 입력…"
            className="mt-0.5 w-full bg-transparent border-b border-plum-hairline outline-none
              text-[10px] text-text placeholder:text-text-mute/60 py-0.5"
          />
        ) : shownMemo ? (
          <div
            title={shownMemo}
            className={`text-[10px] mt-0.5 truncate ${isManual ? "text-text-dim" : "text-text-mute italic"}`}
          >
            {shownMemo}
          </div>
        ) : null}
```

- [ ] **Step 4: 편집 버튼 추가**

기존 삭제 버튼(`absolute top-1.5 right-1.5 …`)을 그대로 두고, 그 왼쪽에 편집 버튼을 추가한다. 삭제 확인 상태(`confirmDelete`)일 때는 겹치므로 숨긴다:

```tsx
      {!confirmDelete && (
        <button
          onClick={startEdit}
          aria-label="메모 편집"
          title="메모 편집"
          className="absolute top-1.5 right-8 w-6 h-6 flex items-center justify-center rounded-md cursor-pointer
            text-[11px] text-text-dim/40 opacity-0 md:group-hover:opacity-100
            hover:text-text hover:bg-white/5 transition-all duration-fast"
        >
          ✎
        </button>
      )}
```

- [ ] **Step 5: 로비 배선**

`src/app/page.tsx`의 `Session` 인터페이스에 추가:

```ts
  memo?: string;
  autoMemo?: string;
  memoFallback?: string;
```

`deleteSession` 함수 아래에 저장 핸들러 추가:

```tsx
  const saveMemo = useCallback(async (id: string, memo: string): Promise<boolean> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/memo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo }),
    });
    if (!res.ok) {
      showToast("메모 저장에 실패했습니다");
      return false;
    }
    const data = await res.json();
    // 낙관적 갱신 — 로비 전체 재조회는 하지 않는다.
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, memo: data.memo } : s)));
    return true;
  }, []);
```

`<SessionCard …>` 사용부에 props 추가:

```tsx
                memo={s.memo}
                autoMemo={s.autoMemo}
                memoFallback={s.memoFallback}
                onMemoSave={(memo) => saveMemo(s.id, memo)}
```

- [ ] **Step 6: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 7: 브라우저 스모크**

dev 서버(`npm run dev`) → `http://localhost:3340` 로비에서 확인:
1. 세션 카드 hover 시 `✎` 버튼이 나타난다
2. 클릭 → 인라인 입력창 → 텍스트 입력 → Enter → 메모 줄이 기본 색으로 표시된다
3. 카드 클릭이 세션 열기로 새지 않는다(편집 중 클릭)
4. 한글 입력 중 Enter가 조합을 확정할 뿐 저장하지 않는다
5. 하드 리프레시(Ctrl+Shift+R) 후에도 메모가 남아 있다

- [ ] **Step 8: 커밋**

```bash
git add src/components/SessionCard.tsx src/app/page.tsx
git commit -m "feat(memo): 로비 세션 카드 메모 줄 + 인라인 편집

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 채팅 헤더 메모 칩

**Files:**
- Modify: `src/components/StatusBar.tsx` (props ~7-54, 제목 렌더 ~153)
- Modify: `src/app/chat/[sessionId]/page.tsx` (상태 ~75, open 응답 처리 ~664, StatusBar 사용부 ~1085)
- Modify: `src/app/api/sessions/[id]/open/route.ts` (응답에 `memo` 추가)

**Interfaces:**
- Consumes: Task 3의 PATCH 라우트, Task 2의 `getSessionMemoState`
- Produces: `StatusBarProps`에 `memo?: string`, `onMemoSave?: (memo: string) => Promise<boolean>`

- [ ] **Step 1: open 응답에 메모 싣기**

`src/app/api/sessions/[id]/open/route.ts`에서 `NextResponse.json({...})`로 반환하는 객체에 추가:

```ts
    ...sessions.getSessionMemoState(id),
```

(`sessions`는 이미 `getServices()`로 확보돼 있다. 변수명이 다르면 해당 파일의 이름을 따른다.)

- [ ] **Step 2: StatusBar props 확장**

`StatusBarProps`에 추가:

```ts
  /** 세션 메모(수동). 채팅 헤더 칩으로 표시·편집한다. */
  memo?: string;
  onMemoSave?: (memo: string) => Promise<boolean>;
```

구조분해에도 `memo, onMemoSave` 추가.

- [ ] **Step 3: 칩 상태 + 렌더**

컴포넌트 상단 state 블록에 추가:

```tsx
  const [memoEditing, setMemoEditing] = useState(false);
  const [memoDraft, setMemoDraft] = useState("");
```

`<span className="font-medium text-[13px] min-w-0 truncate">{title}</span>` 바로 뒤에 추가:

```tsx
      {onMemoSave && (
        memoEditing ? (
          <input
            autoFocus
            value={memoDraft}
            onChange={(e) => setMemoDraft(e.target.value)}
            onBlur={async () => {
              setMemoEditing(false);
              if (memoDraft.trim() !== (memo || "")) await onMemoSave(memoDraft.trim());
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === "Escape") { e.preventDefault(); setMemoDraft(memo || ""); setMemoEditing(false); }
            }}
            maxLength={200}
            placeholder="메모…"
            className="hidden sm:block min-w-0 w-[180px] px-2 py-0.5 rounded-md text-[11px] text-text
              bg-transparent border border-border/60 outline-none focus:border-accent"
          />
        ) : (
          <button
            onClick={() => { setMemoDraft(memo || ""); setMemoEditing(true); }}
            title={memo || "세션 메모 추가"}
            aria-label="세션 메모"
            className="hidden sm:flex items-center gap-1 min-w-0 max-w-[200px] px-1.5 py-0.5 rounded-md
              text-[11px] text-text-mute border border-transparent cursor-pointer
              hover:border-border/60 hover:text-text-dim transition-all duration-fast"
          >
            <span className="shrink-0">✎</span>
            {memo && <span className="truncate">{memo}</span>}
          </button>
        )
      )}
```

- [ ] **Step 4: 채팅 페이지 배선**

`const [title, setTitle] = useState("");` 아래에 추가:

```tsx
  const [memo, setMemo] = useState("");
```

open 응답 처리부(`setTitle(data.displayName || …)` 근처)에 추가:

```tsx
      setMemo(typeof data.memo === "string" ? data.memo : "");
```

핸들러 추가(`handleBack` 등 다른 핸들러 근처):

```tsx
  const handleMemoSave = useCallback(async (next: string): Promise<boolean> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/memo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo: next }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setMemo(typeof data.memo === "string" ? data.memo : "");
    return true;
  }, [sessionId]);
```

`<StatusBar …>`에 props 추가:

```tsx
        memo={memo}
        onMemoSave={handleMemoSave}
```

- [ ] **Step 5: 타입 체크**

Run: `npm run typecheck`
Expected: 에러 없음

- [ ] **Step 6: 브라우저 스모크**

세션을 열고 확인:
1. 헤더 제목 옆에 `✎` 칩이 보인다
2. 클릭 → 입력 → Enter → 칩에 메모가 표시된다
3. 로비로 돌아가면 같은 메모가 카드에 뜬다
4. 창을 좁히면(`sm` 미만) 칩이 사라진다

- [ ] **Step 7: 커밋**

```bash
git add src/components/StatusBar.tsx "src/app/chat/[sessionId]/page.tsx" "src/app/api/sessions/[id]/open/route.ts"
git commit -m "feat(memo): 채팅 헤더 메모 칩

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 문서 반영 + 최종 게이트

**Files:**
- Modify: `docs/data-model.md` (session.json 필드 표)
- Modify: `docs/api-routes.md` (라우트 표)
- Modify: `docs/architecture.md` (MCP 도구 목록)
- Modify: `HANDOVER.md` (라이브 스모크 백로그)

- [ ] **Step 1: `docs/data-model.md`**

`session.json` 필드를 설명하는 표/목록에 4행 추가:

```markdown
| `memo` | string? | 사용자가 직접 쓴 한 줄 메모. 로비 카드 1순위 표시. 자동 갱신이 덮어쓰지 않음 |
| `autoMemo` | string? | 세션 AI가 10턴마다 갱신하는 한 줄 요약(`bridge_set_session_memo`) |
| `autoMemoAt` | string? | `autoMemo` 갱신 시각(ISO) |
| `memoAuto` | boolean? | 자동 요약 옵트아웃. 미설정 = 켜짐 |
```

- [ ] **Step 2: `docs/api-routes.md`**

세션 라우트 표에 1행 추가:

```markdown
| `PATCH` | `/api/sessions/[id]/memo` | 세션 메모 갱신 — `{memo}`(수동) / `{autoMemo}`(MCP) / `{memoAuto}`(자동 요약 on/off) |
```

- [ ] **Step 3: `docs/architecture.md`**

MCP 도구 목록에 `bridge_set_session_memo` 추가 — "세션 상황 한 줄 요약을 session.json `autoMemo`에 저장(로비 카드 표시용)".

- [ ] **Step 4: `HANDOVER.md`**

라이브 스모크 백로그 섹션에 항목 추가:

```markdown
- **세션 메모 자동 갱신** — 헤드리스로 검증 불가. 임의 세션에서 비-OOC 턴 10회 진행 후
  ① 11번째 유저 턴에 `[MEMO]` 헤더가 병합되는지 ② AI가 `bridge_set_session_memo`를 호출하는지
  ③ 로비 카드에 `autoMemo`가 흐린 이탤릭으로 뜨는지 ④ 수동 `memo`가 있는 세션에서 수동 메모가
  그대로 유지되는지 확인. 옵트아웃은 session.json에 `"memoAuto": false` 넣고 재확인.
```

- [ ] **Step 5: 전체 게이트**

Run: `npm run verify`
Expected: typecheck + lint:data + check:static + smoke 모두 통과

- [ ] **Step 6: 순수 로직 테스트 재실행**

Run: `npx tsx --test "src/lib/session-memo.test.ts"`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add docs/data-model.md docs/api-routes.md docs/architecture.md HANDOVER.md
git commit -m "docs(memo): 세션 메모 기능 문서 반영 + 라이브 스모크 백로그

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
