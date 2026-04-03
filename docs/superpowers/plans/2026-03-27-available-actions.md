# Available Actions 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진 액션의 `meta` 메타데이터를 기반으로 현재 사용 가능한 액션 목록을 `[AVAILABLE]` 헤더로 AI에게 전달하여, AI 선택지의 액션 정확도를 높인다.

**Architecture:** engine.js 디스패처가 매 실행 후 `_available_actions`를 결과에 첨부 → tools route가 프론트엔드에 전달 → handleChoice가 마지막 결과를 캡처하여 `[AVAILABLE]` 이벤트 헤더 생성 → 다음 사용자 메시지에 prepend.

**Tech Stack:** Next.js API route (TypeScript), React (ChatInput.tsx), session-shared.md (AI 프롬프트)

**Spec:** `docs/superpowers/specs/2026-03-27-available-actions-design.md`

---

### Task 1: tools route에 `_available_actions` 전달 추가

**Files:**
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts:101-105,186`

- [ ] **Step 1: result 타입에 `_available_actions` 추가 + 반환문 수정**

engine.js 디스패처는 `_available_actions`를 반환값 최상위에 첨부한다 (`variables`, `data`, `result`와 같은 레벨).

`route.ts:101-105`의 기존 타입 어서션에 `_available_actions` 추가:

```typescript
const result = await Promise.race([resultPromise, timeoutPromise]) as {
  variables?: Record<string, unknown>;
  data?: Record<string, Record<string, unknown>>;
  result?: unknown;
  _available_actions?: Array<{ action: string; label: string; args_hint: string | null }>;
} | undefined;
```

`route.ts:186`의 반환문 수정:

```typescript
return NextResponse.json({
  ok: true,
  result: result?.result ?? null,
  _available_actions: result?._available_actions ?? null,
});
```

engine.js가 `_available_actions`를 첨부하지 않으면 `null` — 레거시 호환.

- [ ] **Step 2: 수동 검증**

dev 서버에서 기존 세션 tool 실행이 정상 동작하는지 확인. `_available_actions: null`이 응답에 포함되는지 브라우저 DevTools Network 탭에서 확인.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/tools/[name]/route.ts
git commit -m "feat: forward _available_actions from tool results to frontend"
```

---

### Task 2: 프론트엔드 handleChoice에서 `[AVAILABLE]` 헤더 생성

**Files:**
- Modify: `src/components/ChatInput.tsx:160-194`

- [ ] **Step 1: handleChoice 루프에서 `_available_actions` 캡처 및 헤더 생성**

`handleChoice` 함수를 수정:

```typescript
const handleChoice = useCallback(async (choice: Choice) => {
  if (!choice.actions?.length || !sessionId) {
    onSend(choice.text);
    return;
  }
  setChoiceBusy(true);
  try {
    let lastAvailable: Array<{ action: string; label: string; args_hint: string | null }> | null = null;

    for (const act of choice.actions) {
      const toolRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(act.tool)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { action: act.action, ...(act.args || {}) } }),
      });
      if (!toolRes.ok) {
        const err = await toolRes.json().catch(() => ({ error: "Action failed" }));
        throw new Error(err.error || `Action ${act.action} failed`);
      }
      const toolData = await toolRes.json();
      const hint = toolData.result?.hints?.narrative || toolData.result?.hints?.summary || "completed";
      const header = `[${act.action}] ${hint}`;
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ header }),
      });

      // Capture latest _available_actions (last result wins)
      if (toolData._available_actions?.length) {
        lastAvailable = toolData._available_actions;
      }
    }

    // Queue [AVAILABLE] header if present
    if (lastAvailable && lastAvailable.length > 0) {
      const parts = lastAvailable.map((a: { action: string; label: string; args_hint: string | null }) =>
        a.args_hint ? `${a.action}(${a.label} ${a.args_hint})` : `${a.action}(${a.label})`
      );
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ header: `[AVAILABLE] ${parts.join(", ")}` }),
      });
    }

    onSend(choice.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Action failed";
    console.error("[choice action]", msg);
    showToast(msg, 4000);
  } finally {
    setChoiceBusy(false);
  }
}, [onSend, sessionId]);
```

- [ ] **Step 2: 수동 검증**

meta가 등록된 engine.js가 있는 페르소나에서 선택지 클릭 후:
1. DevTools Network에서 tools 응답에 `_available_actions` 배열 확인
2. events 요청에 `[AVAILABLE] ...` 헤더가 포함되는지 확인
3. 다음 AI 응답의 선택지가 목록 내 액션만 포함하는지 확인

meta 미등록 페르소나에서는 `_available_actions: null` → `[AVAILABLE]` 헤더 없음 → 기존 동작 유지 확인.

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatInput.tsx
git commit -m "feat: generate [AVAILABLE] header from tool _available_actions"
```

---

### Task 3: session-shared.md 업데이트

**Files:**
- Modify: `session-shared.md:274-277` (액션 선택 원칙 섹션)

- [ ] **Step 1: 액션 선택 원칙에 `[AVAILABLE]` 가이드 추가**

`session-shared.md`의 "액션 선택 원칙" 섹션(274행 부근)을 아래 내용으로 **전체 교체**:

```markdown
**액션 선택 원칙:**
- 사용자 메시지에 `[AVAILABLE]` 헤더가 포함되어 있으면, 현재 실행 가능한 외부 노출 액션 목록이다. 선택지에는 이 목록에 있는 액션만 포함하라. 목록에 없는 액션을 선택지에 넣지 마라. `[AVAILABLE]`은 액션 선택의 최우선 기준이다 — `[STATE]`나 `[ACTION_LOG]`에서 추론한 액션이라도 `[AVAILABLE]`에 없으면 선택지에 넣지 마라.
- `[AVAILABLE]` 헤더가 없으면 기존 방식대로 `[STATE]`와 `[ACTION_LOG]`를 참고하여 판단하라.
- 사용자 메시지에 `[ACTION_LOG]`가 포함되어 있으면, 사용자가 UI 패널에서 실행한 엔진 액션 히스토리다. 이를 참고하여 사용자가 자주 사용하는 액션 패턴을 파악하고, 선택지에 적절한 액션을 제안하라.
- 선택지에 넣는 액션은 **패널 버튼이 실제로 호출하는 액션명과 동일해야 한다.** `[ACTION_LOG]`에 기록된 액션명을 그대로 따라가라. 내부 전용 액션이나 유사하지만 다른 액션을 넣지 마라.
- 페이즈 전환, 턴 진행, 구매/판매 등 반복적으로 사용되는 엔진 액션은 선택지에 적극적으로 포함하여 사용자의 패널 조작 부담을 줄여라.
```

- [ ] **Step 2: Commit**

```bash
git add session-shared.md
git commit -m "docs: add [AVAILABLE] header rules to session-shared action guidelines"
```
