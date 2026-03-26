# Action History System Design

## Purpose

AI가 사용자가 어떤 tool 액션을 활용하고 있는지 자동으로 인지하여, 더 적절한 선택지(choice + actions)를 생성할 수 있도록 한다. 현재 AI는 패널 코드를 직접 읽거나 지시문에 명시하지 않으면 어떤 액션이 사용 가능하고 실제로 사용되고 있는지 알 방법이 없다.

## Scope

- **추적 대상**: Tool 실행만 (커스텀 tool JS 파일 실행)
- **제외**: Variable patch, modal 열기/닫기, layout 변경, data file patch, 이벤트 큐잉 등
- **제외**: AI가 MCP `run_tool`을 통해 스스로 실행한 tool — 피드백 루프 방지. 프론트엔드(선택지 액션, panelBridge) 경유 실행만 기록

## Design

### Delivery

기존 이벤트 큐와 동일한 패턴으로, 다음 사용자 메시지에 텍스트로 prepend한다.

최종 메시지 조립 순서:
```
{event queue headers}
{action history}
{user message}
```

Note: hint rules는 MCP 서버의 `run_tool` 응답에만 포함되며 채팅 전송 흐름과는 무관하다.

### Record Format

각 액션은 한 줄로 기록된다:

```
[ACTION_LOG] tool=inventory, action=buy, args={item:"apple"}
```

복수 액션이 쌓인 경우 줄바꿈으로 연결:

```
[ACTION_LOG] tool=inventory, action=buy, args={item:"apple"}
[ACTION_LOG] tool=inventory, action=sell, args={item:"sword"}
```

### Curation: Blacklist via `noActionLog` Flag

기본적으로 모든 tool 실행이 기록된다 (블랙리스트 방식).

Tool이 실행 결과에서 `noActionLog: true`를 반환하면 해당 실행은 기록에서 제외된다:

```javascript
// tool JS file example
module.exports = async (context, args) => {
  if (args.action === 'background-tick') {
    return { noActionLog: true, variables: { ... } };
  }
  return { variables: { ... } };
};
```

같은 tool이라도 action에 따라 기록 여부를 동적으로 결정할 수 있다.

Note: `silent`는 WebSocket 메시지에서 "히스토리 미기록" 의미로 이미 사용 중이므로 `noActionLog`를 사용한다.

### Storage

이벤트 큐(`pending-events.json`)와 동일한 패턴으로 `pending-actions.json` 파일에 누적한다.

```json
[
  { "tool": "inventory", "action": "buy", "args": { "item": "apple" } },
  { "tool": "combat", "action": "attack", "args": { "target": "goblin" } }
]
```

메시지 전송 시 flush되어 비워진다.

`pending-actions.json`은 시스템 파일이므로 기존 `SYSTEM_JSON` 제외 목록에 추가해야 한다:
- `src/lib/panel-engine.ts` — `SYSTEM_JSON` set (watcher 트리거 방지)
- `src/lib/session-manager.ts` — `SYNC_SKIP` set (페르소나 sync 방지)
- `src/app/api/sessions/[id]/tools/[name]/route.ts` — `SYSTEM_JSON` set (커스텀 데이터로 로드 방지)

## Implementation Points

### 1. SessionInstance 확장

`src/lib/session-instance.ts`에 기존 이벤트 큐 메서드와 대칭적으로 추가:

- `queueAction(record: ActionRecord): void` — `pending-actions.json`에 액션 추가
- `flushActions(): string` — 파일 읽고 비우고, `[ACTION_LOG]` 포맷 문자열 반환
- `getPendingActions(): ActionRecord[]` — 현재 대기 중인 액션 조회

```typescript
interface ActionRecord {
  tool: string;
  action: string;
  args?: Record<string, unknown>;
}
```

### 2. Tool 실행 API 연동

`src/app/api/sessions/[id]/tools/[name]/route.ts`에서:

1. Tool 실행 완료 후 결과 확인
2. `result.noActionLog !== true`이면 `instance.queueAction({ tool, action, args })` 호출
3. 기존 동작(variable merge, data merge, hint 처리 등)은 그대로 유지

MCP `run_tool` 경유 요청은 기록하지 않는다. MCP 요청은 `x-bridge-token` 헤더로 식별 가능하므로, 이를 이용해 AI 자체 실행을 필터링한다.

### 3. 채팅 전송 시 조립

두 개의 전송 경로 모두 수정 필요:

**HTTP**: `src/app/api/chat/send/route.ts`
**WebSocket**: `src/lib/ws-server.ts` (`chat:send` 핸들러)

기존 `flushEvents()` 호출 위치 옆에서 `flushActions()`도 호출:

```typescript
const eventHeaders = isOOC ? "" : instance.flushEvents();
const actionHistory = isOOC ? "" : instance.flushActions();

const parts = [eventHeaders, actionHistory, text].filter(Boolean);
const aiText = parts.join('\n');
instance.send(aiText);
```

WebSocket의 `silent` 전송(히스토리 미기록)에서도 action history는 flush한다 — AI에게 액션 컨텍스트는 전달되어야 하므로.

### 4. OOC 메시지 처리

OOC(Out Of Character) 메시지일 때는 이벤트 큐와 마찬가지로 action history를 flush하지 않는다. 다음 일반 메시지까지 유지.

### 5. SYSTEM_JSON 등록

`pending-actions.json`을 아래 세 곳의 제외 목록에 추가:

- `src/lib/panel-engine.ts` → `SYSTEM_JSON`
- `src/lib/session-manager.ts` → `SYNC_SKIP`
- `src/app/api/sessions/[id]/tools/[name]/route.ts` → `SYSTEM_JSON`

## What This Does NOT Cover

- Variable patch, modal, layout 변경 등 tool 실행 외의 액션 추적
- 액션 히스토리의 영구 저장 (flush되면 사라짐)
- AI 응답 내 액션 히스토리 참조/요약 기능
- AI 자체의 MCP tool 실행 기록 (의도적 제외)
