# 액션 가용성 시스템 설계

## 목표

엔진 액션에 선택적 메타데이터(`meta`)를 등록하여, 현재 상태에서 사용 가능한 외부 노출 액션 목록을 AI에게 `[AVAILABLE]` 헤더로 전달한다. AI는 선택지에 이 목록의 액션만 포함한다. 레거시 완전 호환.

## 핵심 정의

- **`choiceable: true`**: 사용자가 UI 패널 컨트롤(버튼, 메뉴 등)에서 직접 호출할 수 있는 외부 노출 액션. AI 선택지에도 포함 가능.
- **`choiceable: false` 또는 meta 미등록**: 내부 전용 액션. AI가 `run_tool`로 직접 호출은 가능하나 선택지에는 포함하지 않음.

## 데이터 흐름

```
engine.js (meta 등록)
  → 디스패처가 _available_actions 첨부
  → tools route가 응답에 포함
  → 프론트엔드 handleChoice가 캡처
  → [AVAILABLE] 이벤트 헤더로 적재
  → 다음 사용자 메시지에 prepend
  → AI가 선택지 구성 시 참조
```

`_available_actions`는 **프론트엔드 전용** 소비 데이터다. MCP `run_tool` 경로로는 전달되지 않으며, 전달할 필요도 없다 — AI가 `run_tool`을 직접 호출할 때는 이미 스스로 액션을 선택한 것이므로 가용 목록이 불필요하다. AI는 다음 사용자 메시지의 `[AVAILABLE]` 헤더를 통해 최신 가용 액션을 확인한다.

## 1. engine.js 메타데이터 구조

```javascript
// 외부 노출 액션 — meta 등록
ACTIONS.buy = function(ctx, args) { ... };
ACTIONS.buy.meta = {
  label: '교역품 구매',
  choiceable: true,
  available: function(v) {
    return !v.in_combat;
  },
  args_hint: '{goods_id, qty}'
};

// 내부 전용 액션 — meta 없음 (레거시)
ACTIONS.combat_resolve_enemies = function(ctx, args) { ... };
```

### meta 스키마

| 필드 | 타입 | meta 존재 시 필수 | 설명 |
|------|------|-------------------|------|
| `label` | `string` | O | 사람 읽기용 이름 (예: "교역품 구매") |
| `choiceable` | `boolean` | O | `true` = 외부 노출, `false` = 내부 전용 |
| `available` | `(v) => boolean` | X | 현재 variables 기준 실행 가능 여부. 미등록 시 항상 available |
| `args_hint` | `string` | X | 파라미터 키 목록, 컴팩트 형식 (예: `'{goods_id, qty}'`). 헤더에 그대로 출력됨 |

### 레거시 규칙

- meta 미등록 → 내부 전용 → `_available_actions`에 포함 안 됨
- `meta.choiceable: false` → 동일하게 제외
- `meta.choiceable: true` + available 미등록 → 항상 사용 가능
- `meta.choiceable: true` + available 등록 → 함수 평가 결과에 따라 포함/제외

## 2. 엔진 디스패처 확장

모든 액션 실행 후 결과에 `_available_actions`를 자동 첨부:

```javascript
// engine.js module.exports 끝, return 직전
const mergedVars = { ...ctx.variables, ...(handlerResult.variables || {}) };
const available = [];
for (const [name, fn] of Object.entries(ACTIONS)) {
  const meta = fn.meta;
  if (!meta || !meta.choiceable) continue;
  try {
    if (meta.available && !meta.available(mergedVars)) continue;
  } catch (e) {
    // available() 함수 오류 시 해당 액션 제외 (보수적)
    continue;
  }
  available.push({
    action: name,
    label: meta.label,
    args_hint: meta.args_hint || null
  });
}
handlerResult._available_actions = available;
```

이 코드는 각 페르소나의 `engine.js` 디스패처에 추가한다. 공용 인프라 변경이 아닌 페르소나별 작업이지만, 패턴은 동일하다.

## 3. tools route 확장

`src/app/api/sessions/[id]/tools/[name]/route.ts`에서 `_available_actions`를 응답에 포함:

```typescript
// 기존 반환 타입에 추가
interface AvailableAction {
  action: string;
  label: string;
  args_hint: string | null;
}

return NextResponse.json({
  ok: true,
  result: toolResult?.result ?? null,
  _available_actions: toolResult?._available_actions as AvailableAction[] ?? null
});
```

게임 로직의 `result`와 시스템 메타데이터를 분리하여 전달.

## 4. 프론트엔드 `[AVAILABLE]` 헤더 생성

`ChatInput.tsx`의 `handleChoice`에서 마지막 tool 실행 결과의 `_available_actions`를 캡처하여 이벤트 헤더로 적재:

```typescript
// handleChoice 내부
let lastAvailable: AvailableAction[] | null = null;

for (const act of choice.actions) {
  const toolRes = await fetch(`/api/sessions/${sessionId}/tools/${act.tool}`, {
    method: 'POST',
    body: JSON.stringify({ args: { action: act.action, ...act.args } })
  });
  const toolData = await toolRes.json();
  // ... 기존 hint 추출 및 이벤트 헤더 로직 ...

  // 매 실행마다 갱신 — 루프 종료 시 마지막 결과가 남음
  if (toolData._available_actions?.length) {
    lastAvailable = toolData._available_actions;
  }
}

// 루프 종료 후: [AVAILABLE] 헤더 적재
if (lastAvailable && lastAvailable.length > 0) {
  const parts = lastAvailable.map(a =>
    a.args_hint ? `${a.action}(${a.label} ${a.args_hint})` : `${a.action}(${a.label})`
  );
  const header = `[AVAILABLE] ${parts.join(', ')}`;
  await fetch(`/api/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ header })
  });
}

onSend(choice.text);
```

출력 형식:
```
[AVAILABLE] travel(여행 출발), buy(교역품 구매 {goods_id, qty}), sell(교역품 판매 {goods_id, qty}), scout_market(시세 조사), dawn_phase(아침으로)
```

- `_available_actions`가 비어있거나 없으면 `[AVAILABLE]` 헤더 생략 (레거시 호환)
- `args_hint`는 meta에 등록된 컴팩트 형식 그대로 출력

## 5. session-shared.md 업데이트

"액션 선택 원칙" 섹션에 추가:

```
- 사용자 메시지에 `[AVAILABLE]` 헤더가 포함되어 있으면,
  현재 실행 가능한 외부 노출 액션 목록이다.
  선택지에는 이 목록에 있는 액션만 포함하라.
  목록에 없는 액션을 선택지에 넣지 마라.
  `[AVAILABLE]`은 액션 선택의 최우선 기준이다 —
  `[STATE]`나 `[ACTION_LOG]`에서 추론한 액션이라도
  `[AVAILABLE]`에 없으면 선택지에 넣지 마라.
- `[AVAILABLE]` 헤더가 없으면 기존 방식대로
  `[STATE]`와 `[ACTION_LOG]`를 참고하여 판단하라.
```

## 6. 구현 범위

### 이번 작업 (공용 인프라)

1. tools route에 `_available_actions` 전달 추가 + `AvailableAction` 타입 정의
2. 프론트엔드 `handleChoice`에서 `_available_actions` 캡처 → `[AVAILABLE]` 헤더 생성
3. `session-shared.md` 업데이트

### 각 페르소나 세션 (별도)

- 해당 페르소나의 `engine.js` 디스패처에 `_available_actions` 첨부 로직 추가
- 각 액션에 `meta` 등록 (선택적, 점진적)
- meta가 없는 액션은 기존대로 동작

## 7. 향후 확장 가능성

- 프론트엔드 패널에서 `_available_actions`를 읽어 버튼 활성/비활성 제어
- `meta.cost`, `meta.cooldown` 등 필드 추가
- `meta.category` (`'trade'` | `'combat'` | `'interaction'`)로 선택지 분류
