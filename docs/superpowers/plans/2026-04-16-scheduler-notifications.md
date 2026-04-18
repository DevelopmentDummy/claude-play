# Scheduler Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pipeline scheduler의 틱 결과에 포함된 notifications 배열을 처리하여 클라이언트(UI)와 AI 세션에 메시지를 푸시한다.

**Architecture:** `schedulerLoop`가 매 틱 결과에서 `notifications` 배열을 읽고, target/mode에 따라 `wsBroadcast` / `queueEvent` / `sendMessage`를 호출한다. `SessionInstance`에 `sendMessage()` 메서드를 추가하여 AI 턴을 서버 내부에서 트리거하되, AI 응답 중이면 완료를 대기한다.

**Tech Stack:** TypeScript, Node.js async/await, WebSocket (`wsBroadcast`)

**Spec:** `docs/superpowers/specs/2026-04-16-scheduler-notifications-design.md`

---

### Task 1: SessionInstance에 idle 대기 + sendMessage 추가

**Files:**
- Modify: `src/lib/session-instance.ts:198-210` (필드 추가)
- Modify: `src/lib/session-instance.ts:940-978` (processResult 끝)
- Modify: `src/lib/session-instance.ts:274-316` (queueEvent 근처에 sendMessage 추가)

- [ ] **Step 1: `_pendingTurn` 필드와 `idleResolvers` 추가**

`src/lib/session-instance.ts` — 기존 private 필드 선언부(line ~210 근처, `resultFinalizeTimer` 뒤)에 추가:

```typescript
  // Scheduler notification: track whether AI is mid-turn
  private _pendingTurn = false;
  private idleResolvers: Array<() => void> = [];
```

- [ ] **Step 2: `isBusy()`, `waitForIdle()`, `sendMessage()` 메서드 추가**

`src/lib/session-instance.ts` — `queueEvent` 메서드 뒤 (`flushEvents` 앞, line ~316 근처)에 추가:

```typescript
  /** Whether the AI is currently processing a turn (streaming, tool use, etc.) */
  isBusy(): boolean {
    return this._pendingTurn;
  }

  /** Wait until AI finishes current turn. Resolves immediately if idle. */
  waitForIdle(): Promise<void> {
    if (!this._pendingTurn) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  /** Send a message to AI from server-side, triggering a new turn.
   *  If AI is mid-turn, waits for completion first (up to 60s timeout). */
  async sendMessage(text: string): Promise<void> {
    if (!this.claude.isRunning()) {
      console.warn(`[session:${this.id}] sendMessage skipped — AI process not running`);
      return;
    }
    // Wait for idle with timeout
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[session:${this.id}] sendMessage waitForIdle timed out (60s), sending anyway`);
        resolve();
      }, 60_000);
      timer.unref?.();
      this.waitForIdle().then(() => { clearTimeout(timer); resolve(); });
    });
    await timeout;

    const eventHeaders = this.flushEvents();
    const hintSnapshot = this.buildHintSnapshot();
    const actionHistory = this.flushActions();
    const jsonLint = this.buildJsonLint();
    const parts = [eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
    this._pendingTurn = true;
    this.claude.send(parts.join("\n"));
  }
```

- [ ] **Step 3: `_pendingTurn = true` 설정 — 기존 `claude.send()` 호출 지점**

`src/lib/session-instance.ts` 에서 기존에 `this.claude.send()`를 호출하는 곳을 찾아 직전에 `this._pendingTurn = true;`를 설정해야 한다. `sendSlashCommand`에도 추가:

`sendSlashCommand` 메서드(line ~517):

```typescript
  sendSlashCommand(command: string): void {
    if (this._provider !== "claude") return;
    if (!this.claude.isRunning()) return;
    this.isSlashCommand = true;
    this._pendingTurn = true;
    this.claude.send(`/${command}`);
  }
```

참고: `ws-server.ts`의 `chat:send`에서 호출하는 `instance.claude.send()`도 `_pendingTurn`을 설정해야 한다. 이를 위해 SessionInstance에 public wrapper를 만든다:

```typescript
  /** Send raw text to the AI process, marking turn as pending. */
  sendToAI(text: string): void {
    this._pendingTurn = true;
    this.claude.send(text);
  }
```

- [ ] **Step 4: `processResult()` 끝에서 idle resolver flush**

`src/lib/session-instance.ts` — `processResult()` 메서드 마지막, `this.broadcast("claude:messageId", ...)` 뒤에 추가:

```typescript
    // Flush idle waiters (scheduler sendMessage)
    this._pendingTurn = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
```

- [ ] **Step 5: `cancelStreaming()` 에서도 idle resolver flush**

`cancelStreaming()` 메서드(line ~534) 마지막에도 추가하여, AI 응답이 취소된 경우에도 대기 중인 sendMessage가 풀리도록 한다:

```typescript
    // Flush idle waiters
    this._pendingTurn = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
```

- [ ] **Step 6: ws-server.ts에서 기존 `instance.claude.send()` → `instance.sendToAI()` 변경**

`src/lib/ws-server.ts` — `chat:send` 핸들러(line ~292, ~313)에서 `instance.claude.send(parts.join("\n"))` 을 `instance.sendToAI(parts.join("\n"))` 로 변경. 두 곳 모두(silent 모드, 일반 모드).

- [ ] **Step 7: 빌드 확인**

Run: `cd "/c/repository/claude bridge" && npm run build`
Expected: 빌드 성공, 타입 에러 없음

- [ ] **Step 8: 커밋**

```bash
git add src/lib/session-instance.ts src/lib/ws-server.ts
git commit -m "feat: SessionInstance.sendMessage() — AI 턴 대기 후 서버 내부 메시지 전송"
```

---

### Task 2: schedulerLoop에서 notifications 처리

**Files:**
- Modify: `src/lib/pipeline-scheduler.ts:1-10` (import 추가)
- Modify: `src/lib/pipeline-scheduler.ts:81-99` (schedulerLoop 내부)

- [ ] **Step 1: import 추가**

`src/lib/pipeline-scheduler.ts` 상단에 추가:

```typescript
import { getSessionInstance } from "./session-registry";
import { wsBroadcast } from "./ws-server";
```

- [ ] **Step 2: notification 처리 함수 추가**

`schedulerLoop` 함수 앞에 추가:

```typescript
interface SchedulerNotification {
  target: "client" | "ai";
  event?: string;
  payload?: unknown;
  mode?: "queue" | "send";
  message?: string;
}

async function processNotifications(sessionId: string, notifications: unknown): Promise<void> {
  if (!Array.isArray(notifications) || notifications.length === 0) return;

  for (const notif of notifications as SchedulerNotification[]) {
    try {
      if (notif.target === "client") {
        const eventType = notif.event || "scheduler:notify";
        wsBroadcast(eventType, notif.payload ?? {}, { sessionId });
      } else if (notif.target === "ai" && notif.message) {
        const instance = getSessionInstance(sessionId);
        if (!instance) {
          console.warn(`[scheduler:${sessionId}] notification skipped — no active instance`);
          continue;
        }
        if (notif.mode === "send") {
          await instance.sendMessage(notif.message);
        } else {
          // default: queue
          instance.queueEvent(notif.message);
        }
      }
    } catch (err) {
      console.error(`[scheduler:${sessionId}] notification error:`, err);
    }
  }
}
```

- [ ] **Step 3: schedulerLoop 틱 처리에 notifications 호출 추가**

`src/lib/pipeline-scheduler.ts` — `schedulerLoop` 함수 내부, phase 업데이트 후 / break 체크 전에 notification 처리를 삽입:

기존 코드:
```typescript
      const phase = typeof result.phase === "string" ? result.phase : "idle";
      handle.phase = phase === "source" || phase === "teacher" ? phase : "idle";

      if (result.stopped === true || result.completed === true) {
        break;
      }
```

변경 후:
```typescript
      const phase = typeof result.phase === "string" ? result.phase : "idle";
      handle.phase = phase === "source" || phase === "teacher" ? phase : "idle";

      // Process notifications from tick result
      await processNotifications(handle.sessionId, result.notifications);

      if (result.stopped === true || result.completed === true) {
        break;
      }
```

이렇게 하면 `completed: true`로 루프가 끝나기 직전에도 마지막 notification이 처리된다.

- [ ] **Step 4: 빌드 확인**

Run: `cd "/c/repository/claude bridge" && npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add src/lib/pipeline-scheduler.ts
git commit -m "feat: schedulerLoop에서 틱 결과 notifications 배열 처리"
```

---

### Task 3: 문서 업데이트 — scheduler-registration SKILL.md

**Files:**
- Modify: `data/skills/scheduler-registration/SKILL.md`

- [ ] **Step 1: SKILL.md에 Notifications 섹션 추가**

`data/skills/scheduler-registration/SKILL.md` 끝 (`status/inspection views` 뒤)에 추가:

```markdown

## Scheduler Notifications

스케줄러의 `scheduler_tick` 반환값에 `notifications` 배열을 포함하면, 서버가 클라이언트(UI)와 AI 세션에 메시지를 자동으로 전달한다.

### Notification Schema

```javascript
// scheduler_tick 반환값 예시
return {
  success: true,
  phase: "source",
  did_work: true,
  notifications: [
    // 클라이언트(UI)에 알림 — wsBroadcast로 전달
    {
      target: "client",
      event: "scheduler:progress",     // WebSocket 이벤트 타입 (기본: "scheduler:notify")
      payload: { step: 3, total: 10 }  // 자유 형태
    },
    // AI에 이벤트 큐 — 다음 유저 메시지에 같이 전달
    {
      target: "ai",
      mode: "queue",                   // "queue" (기본) 또는 "send"
      message: "[SCHEDULER] 3/10 완료"
    },
    // AI에 직접 턴 트리거 — 응답 중이면 완료 대기 후 전송
    {
      target: "ai",
      mode: "send",
      message: "[SCHEDULER_COMPLETE] 작업이 완료되었습니다. 결과를 확인하고 유저에게 알려주세요."
    }
  ]
};
```

### target별 동작

| target | mode | 동작 |
|--------|------|------|
| `client` | — | `wsBroadcast(event, payload, { sessionId })` 호출. 해당 세션의 모든 클라이언트에 WebSocket 이벤트 전달 |
| `ai` | `queue` (기본) | `instance.queueEvent(message)` 호출. 이벤트 큐에 쌓이고, 다음 유저 메시지 전송 시 AI에 함께 전달 |
| `ai` | `send` | `instance.sendMessage(message)` 호출. AI에 직접 새 턴을 트리거. AI가 응답 중이면 완료 대기 후 전송 |

### 사용 가이드

- **진행 상황 알림**: `target: "client"` — 프론트엔드에서 토스트, 프로그레스 바, 패널 업데이트에 활용
- **AI에 중간 보고**: `target: "ai", mode: "queue"` — 급하지 않은 정보. 다음 대화 턴에 자연스럽게 포함
- **AI에 즉시 알림**: `target: "ai", mode: "send"` — 완료/에러 등 AI가 즉시 반응해야 하는 이벤트. 대화가 끊긴 상태에서도 AI 턴을 시작함
- 매 틱마다 0~N개 알림 가능. 완료 틱(`completed: true`)에도 알림이 처리된 후 루프가 종료됨
- notification 처리 중 에러는 로그만 남기고 스케줄러 루프는 중단하지 않음
```

- [ ] **Step 2: 커밋**

```bash
git add data/skills/scheduler-registration/SKILL.md
git commit -m "docs: scheduler-registration 스킬에 notifications 가이드 추가"
```

---

### Task 4: 문서 업데이트 — builder-primer.yaml

**Files:**
- Modify: `builder-primer.yaml`

- [ ] **Step 1: 스케줄러 가이던스에 notification 항목 추가**

`builder-primer.yaml` — 기존 스케줄러 가이던스의 마지막 항목 (line 37, `For persona builder guidance...` 뒤)에 추가:

```yaml
  - Scheduler ticks can return a `notifications` array to push messages to the client (UI) or AI session mid-run. Use `target: "client"` for WebSocket UI updates, `target: "ai", mode: "queue"` for non-urgent AI context, and `target: "ai", mode: "send"` for immediate AI turn triggers (e.g. completion events). Design which events warrant which notification target and mode as part of the scheduler spec.
```

- [ ] **Step 2: 커밋**

```bash
git add builder-primer.yaml
git commit -m "docs: builder-primer에 스케줄러 notification 가이던스 추가"
```

---

### Task 5: 문서 업데이트 — panel-spec.md

**Files:**
- Modify: `panel-spec.md` (레이아웃 실시간 업데이트 섹션 뒤, line ~1413)

- [ ] **Step 1: 스케줄러 WebSocket 이벤트 섹션 추가**

`panel-spec.md` — `### 레이아웃 실시간 업데이트` 섹션 뒤 (`__panelBridge.updateLayout(patch)` 설명이 끝나는 곳)에 추가:

```markdown

### 스케줄러 알림 이벤트

Pipeline scheduler의 `scheduler_tick` 도구 반환값에 `notifications` 배열이 포함되면, 서버가 해당 세션의 클라이언트에 WebSocket 이벤트를 브로드캐스트한다.

기본 이벤트 타입은 `scheduler:notify`이며, 도구 스크립트가 `event` 필드로 커스텀 이벤트 타입을 지정할 수 있다.

**이벤트 예시:**

| 이벤트 타입 | 용도 | payload 예시 |
|-------------|------|-------------|
| `scheduler:notify` | 범용 알림 (기본값) | `{ message: "작업 완료" }` |
| `scheduler:progress` | 진행 상황 | `{ step: 3, total: 10, label: "이미지 생성" }` |
| `scheduler:complete` | 완료 알림 | `{ label: "파이프라인", elapsed: 192 }` |
| `scheduler:error` | 에러 알림 | `{ error: "API 타임아웃", phase: "source" }` |

이벤트 타입과 payload 구조는 도구 스크립트가 자유롭게 정의한다. 프론트엔드 패널은 `__panelBridge` 또는 WebSocket 리스너를 통해 이 이벤트를 수신하여 토스트, 프로그레스 바, 상태 패널 업데이트 등에 활용할 수 있다.

```javascript
// 프론트엔드 패널에서 수신 예시 (패널 HTML 내부)
__panelBridge.on("scheduler:progress", (data) => {
  updateProgressBar(data.step, data.total);
});
```
```

- [ ] **Step 2: 커밋**

```bash
git add panel-spec.md
git commit -m "docs: panel-spec에 스케줄러 알림 WebSocket 이벤트 명세 추가"
```

---

### Task 6: 통합 테스트 (수동)

- [ ] **Step 1: 빌드 확인**

Run: `cd "/c/repository/claude bridge" && npm run build`
Expected: 성공, 에러 없음

- [ ] **Step 2: 기능 시나리오 확인**

dev 서버를 띄우고 스케줄러가 등록된 페르소나에서:

1. 스케줄러 시작 후 도구 스크립트에서 `notifications: [{ target: "client", payload: { test: true } }]` 반환 → 브라우저 콘솔에서 WebSocket 이벤트 수신 확인
2. `notifications: [{ target: "ai", mode: "queue", message: "[TEST] queue notification" }]` 반환 → 다음 유저 메시지 전송 시 AI가 해당 이벤트를 인식하는지 확인
3. `notifications: [{ target: "ai", mode: "send", message: "[TEST] send notification" }]` 반환 → AI가 대화가 없는 상태에서 자동으로 응답을 시작하는지 확인
4. AI가 응답 중인 상태에서 `mode: "send"` 알림 → AI 응답 완료 후 새 턴이 트리거되는지 확인

- [ ] **Step 3: 최종 커밋 (필요 시)**

빌드/테스트 중 발견된 수정사항이 있으면 커밋.
