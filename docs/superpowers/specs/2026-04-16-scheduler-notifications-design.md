# Scheduler Notifications Design

**Date:** 2026-04-16
**Status:** Approved

## Summary

Pipeline scheduler의 틱 결과에 notification 배열을 포함시켜, 스케줄러가 진행 중간 또는 완료 시점에 클라이언트(UI)와 AI 세션에 메시지를 푸시할 수 있게 한다.

## Background

현재 `schedulerLoop`는 매 틱마다 `tools/pipeline`의 `scheduler_tick` 액션을 호출하고, 결과에서 `phase`, `stopped`, `completed` 등의 상태만 읽는다. 스케줄러가 작업 진행/완료를 외부에 알릴 수단이 없어, 유저나 AI가 스케줄러 상태를 능동적으로 조회해야만 한다.

## Design

### Notification Schema

`scheduler_tick` 도구 반환값에 `notifications` 배열을 추가한다. 각 항목은 독립적으로 대상과 전달 방식을 지정한다.

```typescript
interface SchedulerNotification {
  /** 알림 대상 */
  target: "client" | "ai";

  /** client target: WebSocket 이벤트 타입 (default: "scheduler:notify") */
  event?: string;
  /** client target: WebSocket payload (자유 형태) */
  payload?: unknown;

  /** ai target: 전달 방식 */
  mode?: "queue" | "send";
  // - "queue": queueEvent()에 쌓임. 다음 유저 메시지에 같이 전달됨.
  // - "send": AI에 직접 턴 트리거. 응답 중이면 완료 대기 후 전송.
  // default: "queue"

  /** ai target: AI에게 전달할 메시지 텍스트 (필수) */
  message?: string;
}
```

### 도구 스크립트 반환 예시

```javascript
// tools/pipeline.js — scheduler_tick 액션 결과
return {
  success: true,
  phase: "source",
  did_work: true,
  notifications: [
    // 클라이언트에 진행 상황 알림
    { target: "client", event: "scheduler:progress", payload: { step: 3, total: 10, label: "이미지 생성" } },
    // AI에 이벤트 큐 (다음 메시지에 같이 전달)
    { target: "ai", mode: "queue", message: "[SCHEDULER] 3/10 이미지 생성 완료" },
  ]
};

// 완료 시 AI 턴 자동 트리거
return {
  success: true,
  completed: true,
  notifications: [
    { target: "client", event: "scheduler:complete", payload: { label: "이미지 생성", elapsed: 192 } },
    { target: "ai", mode: "send", message: "[SCHEDULER_COMPLETE] 이미지 생성 파이프라인이 완료되었습니다. 결과를 확인하고 유저에게 알려주세요." },
  ]
};
```

### schedulerLoop 변경

`pipeline-scheduler.ts`의 `schedulerLoop`에서 매 틱 결과 처리 시:

```
틱 결과 수신
→ result.notifications 배열 확인 (없거나 빈 배열이면 스킵)
→ 각 notification에 대해:
   target === "client"
     → wsBroadcast(sessionId, { type: event || "scheduler:notify", ...payload })
   target === "ai", mode === "queue" (또는 미지정)
     → getSessionInstance(sessionId)?.queueEvent(message)
   target === "ai", mode === "send"
     → getSessionInstance(sessionId)?.sendMessage(message)
→ 다음 틱 계속 (또는 stopped/completed면 루프 종료)
```

알림 처리는 비동기이되, `mode: "send"`의 경우 `await`로 전송 완료를 기다린다. queue/client 알림은 fire-and-forget.

### SessionInstance.sendMessage() — 새 메서드

AI에게 서버 내부에서 직접 메시지를 보내 턴을 트리거하는 메서드.

**핵심: AI 응답 중이면 완료될 때까지 대기.**

```typescript
// SessionInstance에 추가할 필드
private idleResolvers: Array<() => void> = [];

/** AI가 현재 턴을 처리 중인지 여부.
 *  텍스트 스트리밍뿐 아니라 도구 호출 중(텍스트 없이 실행 중)도 포함. */
private _pendingTurn = false;  // claude.send() 시 true, processResult() 시 false

isBusy(): boolean {
  return this._pendingTurn;
}

/** AI 응답 완료까지 대기. 이미 idle이면 즉시 resolve. */
waitForIdle(): Promise<void> {
  if (!this.isBusy()) return Promise.resolve();
  return new Promise(resolve => this.idleResolvers.push(resolve));
}

/** 서버 내부에서 AI에게 메시지를 보내 새 턴을 시작한다.
 *  AI가 응답 중이면 완료될 때까지 대기 후 전송. */
async sendMessage(text: string): Promise<void> {
  await this.waitForIdle();
  const eventHeaders = this.flushEvents();
  const hintSnapshot = this.buildHintSnapshot();
  const actionHistory = this.flushActions();
  const jsonLint = this.buildJsonLint();
  const parts = [eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
  this.claude.send(parts.join("\n"));
}
```

`_pendingTurn` 상태 관리 및 idleResolvers flush:

```typescript
// claude.send() 호출 전에 (ws-server의 chat:send 및 sendMessage 내부)
this._pendingTurn = true;

// processResult() 마지막에 추가
this._pendingTurn = false;
for (const resolve of this.idleResolvers.splice(0)) resolve();
```

### 에러 처리

- notification 처리 중 에러는 로그만 남기고 루프를 중단하지 않는다.
- `sendMessage`에서 AI 프로세스가 죽어있으면 (`isRunning() === false`) 경고 로그 후 스킵.
- `waitForIdle`에 타임아웃(60초)을 걸어 무한 대기 방지. 타임아웃 시 경고 로그 후 전송 시도.

### 변경 파일 목록

| 파일 | 변경 내용 |
|------|-----------|
| `src/lib/pipeline-scheduler.ts` | `schedulerLoop`에서 틱 결과의 `notifications` 배열 처리 |
| `src/lib/session-instance.ts` | `sendMessage()`, `waitForIdle()`, `isBusy()`, `idleResolvers` 추가. `processResult()` 끝에서 resolver flush |
| `data/skills/scheduler-registration/SKILL.md` | notifications 스키마 및 도구 스크립트 반환 가이드 추가 |
| `builder-primer.yaml` | 스케줄러 notification 관련 빌더 가이던스 추가 |
| `panel-spec.md` | 스케줄러 notification WebSocket 이벤트 명세 추가 |

### 변경하지 않는 것

- `ws-server.ts` — 기존 `wsBroadcast` 그대로 사용
- `session-registry.ts` — 기존 `getSessionInstance` 그대로 사용
- 스케줄러 등록/시작/정지 API — 변경 없음
- 세션당 스케줄러 1개, `tools/pipeline` 고정 — 유지

### 문서 업데이트 상세

#### scheduler-registration SKILL.md

스케줄러 등록 스킬에 notifications 가이드 추가:
- `scheduler_tick` 반환값의 `notifications` 배열 스키마
- target별 동작 설명 (client → wsBroadcast, ai/queue → queueEvent, ai/send → sendMessage)
- 실제 도구 스크립트 예시 (진행 중 알림, 완료 알림, 에러 알림)
- 빌더가 페르소나 설계 시 어떤 이벤트에 어떤 알림을 넣을지 결정하도록 안내

#### builder-primer.yaml

기존 스케줄러 가이던스에 notification 관련 항목 추가:
- 스케줄러 틱 반환값에 notifications를 포함하여 클라이언트/AI에 진행 상황을 알릴 수 있음
- AI 알림의 queue/send 모드 차이와 선택 기준 안내

#### panel-spec.md

WebSocket 이벤트 섹션에 스케줄러 관련 이벤트 추가:
- `scheduler:notify` — 기본 스케줄러 알림 이벤트
- `scheduler:progress` — 진행 상황 알림 (예시)
- `scheduler:complete` — 완료 알림 (예시)
- 프론트엔드에서 이 이벤트들을 수신하여 토스트/패널 업데이트에 활용하는 방법
