# Action History System Design

## Purpose

AI가 사용자가 어떤 tool 액션을 활용하고 있는지 자동으로 인지하여, 더 적절한 선택지(choice + actions)를 생성할 수 있도록 한다. 현재 AI는 패널 코드를 직접 읽거나 지시문에 명시하지 않으면 어떤 액션이 사용 가능하고 실제로 사용되고 있는지 알 방법이 없다.

## Scope

- **추적 대상**: Tool 실행만 (커스텀 tool JS 파일 실행)
- **제외**: Variable patch, modal 열기/닫기, layout 변경, data file patch, 이벤트 큐잉 등

## Design

### Delivery

기존 이벤트 큐와 동일한 패턴으로, 다음 사용자 메시지에 텍스트로 prepend한다.

최종 메시지 조립 순서:
```
{event queue headers}
{hint rules}
{action history}
{user message}
```

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

### Curation: Blacklist via `silent` Flag

기본적으로 모든 tool 실행이 기록된다 (블랙리스트 방식).

Tool이 실행 결과에서 `silent: true`를 반환하면 해당 실행은 기록에서 제외된다:

```javascript
// tool JS file example
module.exports = async (context, args) => {
  if (args.action === 'background-tick') {
    return { silent: true, variables: { ... } };
  }
  return { variables: { ... } };
};
```

같은 tool이라도 action에 따라 기록 여부를 동적으로 결정할 수 있다.

### Storage

이벤트 큐(`pending-events.json`)와 동일한 패턴으로 `pending-actions.json` 파일에 누적한다.

```json
[
  { "tool": "inventory", "action": "buy", "args": { "item": "apple" } },
  { "tool": "combat", "action": "attack", "args": { "target": "goblin" } }
]
```

메시지 전송 시 flush되어 비워진다.

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
2. `result.silent !== true`이면 `instance.queueAction({ tool, action, args })` 호출
3. 기존 동작(variable merge, data merge, hint 처리 등)은 그대로 유지

### 3. 채팅 전송 시 조립

`src/lib/session-instance.ts`의 메시지 전송 로직과 `src/app/api/chat/send/route.ts`, `src/lib/ws-server.ts`에서:

기존 `flushEvents()` 호출 위치 옆에서 `flushActions()`도 호출하여 메시지를 조립한다.

```
const eventHeaders = instance.flushEvents();
const actionHistory = instance.flushActions();
const hintRules = instance.getHintRules();  // 기존 hint rules

// 조립
const parts = [eventHeaders, hintRules, actionHistory, text].filter(Boolean);
const aiText = parts.join('\n');
```

(실제 조립 순서와 기존 hint rules 처리 로직은 구현 시 현재 코드에 맞춰 조정)

### 4. OOC 메시지 처리

OOC(Out Of Character) 메시지일 때는 이벤트 큐와 마찬가지로 action history를 flush하지 않는다. 다음 일반 메시지까지 유지.

## What This Does NOT Cover

- Variable patch, modal, layout 변경 등 tool 실행 외의 액션 추적
- 액션 히스토리의 영구 저장 (flush되면 사라짐)
- AI 응답 내 액션 히스토리 참조/요약 기능
