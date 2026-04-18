# 엔진 스크립트 & 데이터 아키텍처

## 엔진 스크립트 인터페이스

### 파일 위치

`tools/engine.js` — 페르소나/세션 디렉토리 내. 세션 생성 시 자동 복사, 양방향 싱크 지원.

### 기본 구조

```javascript
// tools/engine.js — 액션 디스패처 패턴
const ACTIONS = {
  // 각 액션은 (context, args) → { variables?, data?, result? } 를 반환
  advance_time(ctx, args) { /* ... */ },
  use_item(ctx, args) { /* ... */ },
};

module.exports = async function(context, args) {
  // context.variables  — variables.json 내용 (읽기용 사본, 직접 수정 불가)
  // context.data       — 커스텀 데이터 파일들 { inventory: {...}, world: {...} }
  //                      (키는 파일명에서 .json 제거)
  // context.sessionDir — 세션 디렉토리 절대 경로 (직접 파일 I/O 가능)

  const { action, ...params } = args;
  const handler = ACTIONS[action];
  if (!handler) {
    return { result: { success: false, message: `알 수 없는 액션: ${action}` } };
  }
  return handler(context, params);
};
```

### 반환값

| 필드 | 타입 | 설명 |
|------|------|------|
| `variables` | `Record<string, any>` | `variables.json`에 shallow merge. 생략 가능. |
| `data` | `Record<string, Record<string, any>>` | 파일명(확장자 포함) → 패치 객체. 각 파일에 shallow merge. 생략 가능. |
| `result` | `any` | 호출자(패널/AI)에 그대로 전달되는 임의 데이터. 생략 가능. |

```javascript
return {
  variables: { hp: newHp, gold: newGold },
  data: { "inventory.json": { items: updatedItems } },
  result: { success: true, damage: 12, crit: true }
};
```

`variables`나 `data`가 있으면 서버가 파일에 반영 후 패널이 자동 재렌더링된다.

### 주의사항

- `context.variables`와 `context.data`는 **읽기용 사본**. 직접 수정해도 파일에 반영되지 않는다. 반드시 `return`으로 반환.
- `data` 반환의 키는 **확장자 포함** (예: `"world.json"`, `"inventory.json"`).
- `session.json`, `layout.json` 등 시스템 파일은 수정 불가.
- 실행 제한 시간: **10초**. 초과 시 에러.
- 서버 프로세스 내에서 실행되므로 무한루프 주의.

---

## 액션 디스패처 설계 패턴

### 단일 엔진에 모든 액션 통합 (권장)

기능별로 `attack.js`, `craft.js` 등 분리하기보다, **하나의 `engine.js`에 액션 디스패처**를 두는 것이 좋다. 규칙이 한 곳에 모이므로 액션 간 부수 효과를 일관되게 처리할 수 있다.

### 액션 조합 패턴

액션 안에서 다른 액션을 호출하여 복합 효과를 구성한다:

```javascript
move(ctx, args) {
  const { destination } = args;
  const travelHours = ctx.data.world?.travelTimes?.[destination] || 1;
  // 이동 → 시간도 경과 (액션 조합)
  const timeResult = ACTIONS.advance_time(ctx, { hours: travelHours });
  return {
    variables: { ...timeResult.variables, location: destination },
    result: { success: true, destination, travelHours },
  };
},
```

### 규칙을 데이터에 정의

엔진 코드에 "회복포션은 HP +50"을 하드코딩하지 않고, 데이터 파일에서 읽는다:

```javascript
// items.json 에 효과 정의
// { "effects": { "회복포션": { "hp": 50 }, "해독제": { "poison": -1 } } }

use_item(ctx, args) {
  const { item, quantity = 1 } = args;
  const effects = ctx.data.items?.effects?.[item] || {};
  const vars = {};
  for (const [stat, delta] of Object.entries(effects)) {
    const max = ctx.variables[`${stat}_max`] || Infinity;
    vars[stat] = Math.min(max, (ctx.variables[stat] || 0) + delta);
  }
  // ... 인벤토리 차감 로직 ...
  return { variables: vars, data: { "inventory.json": { items: inv } }, result: { success: true, item, effects: vars } };
},
```

새 아이템 추가 시 코드 수정 없이 `items.json`만 편집하면 된다.

### 반환 구조 문서화 (엔진-패널 계약)

**반드시 코드 상단 주석에 액션별 result 필드를 문서화하라.**

패널에서 엔진 결과를 참조할 때 추측하면 안 된다. flat인지 nested인지 엔진마다 다르다:

```javascript
// flat — result.damage로 접근
result: { success: true, damage: 12, crit: true }

// nested — result.economy.name으로 접근
result: { success: true, economy: { name: '회복포션', price: 50, newBalance: 450 } }
```

**원칙:**
- 엔진의 반환 구조를 코드 상단 주석에 문서화하라
- 패널 작성/수정 시 엔진의 해당 액션 코드를 **먼저** 읽어라
- `queueEvent` 헤더에 쓸 필드도 엔진 반환값에서 **정확한 경로**로 참조하라

### 호출 방법

**패널에서:**
```javascript
const res = await __panelBridge.runTool('engine', {
  action: 'attack', target: 'goblin'
});
```

**AI(MCP)에서:**
```
run_tool("engine", { action: "advance_time", hours: 2 })
```

**체이닝 호출(MCP):**
```
run_tool("engine", { chain: [
  { tool: "engine", args: { action: "advance_time", hours: 1 } },
  { tool: "engine", args: { action: "check_unlocks" } }
] })
```

### 엔진 액션 분리: 행동 처리 vs 시간 진행

복잡한 턴 시스템에서는 하나의 "턴 진행" 액션을 두 개로 분리하는 것이 좋다:

- **행동 액션** (예: `advance_slot`): 활동 처리, 스탯 변화, 이벤트 — 즉시 실행
- **전환 액션** (예: `turn_transition`): 시간 진행, 해금, 계절 이벤트, 생일 — turnEnd 후 실행

행동 액션은 `pending_transition: true`를 반환하여 패널에게 "후처리가 필요하다"는 신호를 보낸다. 전환 액션은 `needs_narration: true/false`를 반환하여 AI 서사가 필요한지 판단한다.

```javascript
// 행동 액션 — 활동만 처리, 월 진행 안 함
advance_slot(ctx) {
  // ... 활동 처리 ...
  return { result: { ..., pending_transition: nextSlot === 3 } };
}

// 전환 액션 — 월 진행, 해금, 이벤트
turn_transition(ctx) {
  const ms = advanceMonth(v, ...);
  const needs_narration = !!(ms.birthday || ms.stress_event || ms.seasonal_event || ...);
  return { result: { success: true, needs_narration, month_summary: ms, popups } };
}
```

이 분리로 패널은 Phase 1 (행동 서사) → Phase 2 (전환 서사)의 2-Phase 턴을 오케스트레이션할 수 있다.

### 개별 스크립트가 유용한 경우

모든 것을 engine.js에 넣을 필요는 없다. **게임 상태와 무관한 유틸리티**는 별도 파일로:
- 랜덤 이벤트 생성기 (`random-event.js`)
- 데이터 마이그레이션/정리 스크립트
- 외부 API 호출 래퍼

기준: 규칙 기반 상태 변이 로직 → 엔진, 상태 무관 유틸리티 → 개별 스크립트.

---

## 데이터 파일 설계

### variables.json vs 커스텀 데이터

| | `variables.json` | 커스텀 `*.json` |
|---|---|---|
| 용도 | 매 턴 변하는 동적 상태 | 정적/반정적 구조 데이터 |
| 템플릿 접근 | `{{변수명}}` (루트) | `{{파일명.키}}` (네임스페이스) |
| 변경 API | `updateVariables(patch)` | `updateData(fileName, patch)` |
| 예시 | hp, gold, location, mood, stress | inventory, world, items, npcs, quests |

### 시스템 예약 키 (`__` 접두사)

| 키 | 용도 |
|---|---|
| `__modals` | 모달/독 패널 on/off 상태 |
| `__popups` | 팝업 큐 (배열) |
| `__imageBase` | 이미지 서빙 경로 (자동 주입, 수정 불가) |
| `__adventure` | 모험 결과 데이터 (패널에서 읽어 표시) |
| `__values_prompt` | 가치관 선택 데이터 (패널에서 읽어 표시) |
| `__competition_pending` | 대회 결과 대기 데이터 |

`__` 접두사 변수는 MCP `run_tool` 스냅샷에서 제외된다. AI 힌트에 불필요한 시스템 데이터.

### 인벤토리 — 객체 vs 배열

```jsonc
// 단순 수량 관리: 객체가 편리
{ "items": { "회복포션": 3, "해독제": 1 } }

// 개별 속성이 다른 장비: 배열이 적합
{ "equipment": [
  { "name": "철검", "atk": 15, "durability": 80 },
  { "name": "가죽갑옷", "def": 8, "durability": 100 }
]}
```

### 정적 + 동적 분리

```jsonc
// world.json (반정적 — 세계관 정의)
{ "enemies": [{ "name": "고블린", "maxHp": 30, "hp": 30, "atk": 5 }] }

// variables.json (동적 — 현재 전투 상태)
{ "inCombat": true, "currentEnemy": "고블린" }
```

### 아이템 효과를 데이터로 정의

```jsonc
// items.json
{
  "effects": {
    "회복포션": { "hp": 50 },
    "해독제": { "poison": -1 },
    "체력물약": { "stamina": 20 }
  },
  "shop": [
    { "id": "회복포션", "price": 50, "description": "HP를 50 회복" },
    { "id": "해독제", "price": 30, "description": "독 상태 해제" }
  ]
}
```

### 제외 파일

다음 시스템 파일은 커스텀 데이터 로딩에서 자동 제외된다:
`variables.json`, `session.json`, `builder-session.json`, `comfyui-config.json`, `layout.json`, `chat-history.json`, `character-tags.json`

---

## hint-rules.json

MCP `run_tool` 응답에 포함되는 상태 스냅샷의 포맷 규칙. AI가 수치를 서사적으로 이해하도록 해석 힌트를 붙인다.

### 구조

```json
{
  "변수명": {
    "format": "{value}/{max}",
    "max_key": "변수명_max",
    "tier_mode": "percentage",
    "tiers": [
      { "max": 20, "hint": "위험!" },
      { "max": 50, "hint": "부상 상태" },
      { "max": 80, "hint": "양호" },
      { "max": 100, "hint": "건강" }
    ]
  }
}
```

### 필드 설명

| 필드 | 설명 |
|------|------|
| `format` | 표시 포맷. `{value}`, `{max}`, `{pct}` 플레이스홀더 지원 |
| `max_key` | `_max` 변수 참조 (percentage 계산용). 생략 가능. |
| `tier_mode` | `"percentage"` → 현재값/최대값 백분율로 티어 매칭. 생략 → 절대값 |
| `tiers` | 값 범위별 힌트 텍스트. `max` 이하일 때 해당 hint 적용. |

### 예시

```json
{
  "hp": {
    "format": "{value}/{max}",
    "max_key": "hp_max",
    "tier_mode": "percentage",
    "tiers": [
      { "max": 20, "hint": "위험!" },
      { "max": 50, "hint": "부상 상태" },
      { "max": 80, "hint": "양호" },
      { "max": 100, "hint": "건강" }
    ]
  },
  "gold": {
    "format": "{value}G",
    "tiers": [
      { "max": 100, "hint": "빈털터리" },
      { "max": 500, "hint": "간신히 생활 가능" },
      { "max": 1500, "hint": "여유 있는 편" },
      { "max": 5000, "hint": "꽤 부유함" },
      { "max": 99999, "hint": "대부호 수준" }
    ]
  },
  "weight": {
    "format": "{value}kg",
    "tiers": [
      { "max": 22, "hint": "너무 마른 편" },
      { "max": 35, "hint": "적당한 체형" },
      { "max": 55, "hint": "통통한 편" },
      { "max": 100, "hint": "비만" }
    ]
  }
}
```

### 자동 포함 변수

공용 변수(`location`, `time`, `outfit`, `mood`, `weather` 등)는 hint-rules.json에 규칙이 없어도 자동으로 스냅샷에 포함된다. 규칙이 필요한 것은 수치형 변수 (게이지, 골드, 체중 등).

### `_passthrough` — 페르소나별 추가 변수

`variables.json`의 특정 변수를 `[STATE]` 라인에 그대로 노출하고 싶을 때 사용한다. hint-rules의 tier 규칙 없이 raw 값을 그대로 전달한다.

```json
{
  "_passthrough": ["current_year", "current_month", "age", "wish_text"]
}
```

→ `[STATE]` 출력: `..., current_year=4, current_month=9, age=13, wish_text=올리브가 ...`

### `_data_files` — 추가 데이터 파일 로딩

스냅샷 빌드 시 `variables.json` 외에 추가로 읽을 JSON 파일을 지정한다. 읽은 데이터는 `vars[파일명]`으로 접근 가능해져서, 스냅샷 빌드 로직에서 활용할 수 있다.

```json
{
  "_data_files": ["game-state"]
}
```

→ `game-state.json`을 읽어 `vars["game-state"]`에 머지. 예: `vars["game-state"].activity_stats`로 활동별 수행 기록 접근.

**용도 예시:**
- 활동 수행 기록(`activity_stats`)을 읽어 다음 슬롯의 `next_activity` 힌트 생성
- NPC 관계 데이터를 읽어 대화 힌트 생성
- 퀘스트 진행 상황을 스냅샷에 반영

**주의:** 파일명에서 `.json`은 생략 가능하다 (`"game-state"` = `"game-state.json"`).

### `hooks/on-message.js` — 동적 힌트 데이터 가공

hint-rules.json이 정적 규칙만 처리하므로, **조건부/계산 기반 힌트**가 필요하면 `hooks/on-message.js`를 작성한다. 매 사용자 메시지 전송 직전에 서버에서 자동 실행되어, `buildHintSnapshot()` 호출 전에 variables/data를 가공한다.

```javascript
// hooks/on-message.js
module.exports = function({ variables, data, sessionDir, message }) {
  const patch = {};
  // HP 비율을 계산하여 힌트용 파생 변수 생성
  const hpPct = variables.hp / (variables.hp_max || 1);
  patch._hp_danger = hpPct < 0.2 ? "critical" : hpPct < 0.5 ? "warning" : "safe";
  return { variables: patch };
};
```

- tools/engine.js와 같은 context 구조 (`{ variables, data, sessionDir }` + `message`)
- 반환: `{ variables?: patch, data?: { filename: patch } }` — shallow merge 적용
- `_` 접두사 관례로 파생 변수 구분 (예: `_hp_danger`, `_weather_mood`)
- 동기 실행이므로 I/O 최소화 (비동기 불가)

### 스냅샷 출력 예시

AI가 `run_tool` 결과로 받는 스냅샷:
```
hp: 25/40 (부상 상태)
gold: 805G (여유 있는 편)
stress: 4/110 (여유로운 상태)
location: 집
outfit: 원피스
mood: 매우 좋음
```

`[STATE]` 라인 예시 (chat send 시 자동 삽입):
```
[STATE] hp=25/40(hint: "부상 상태"), gold=805G(hint: "여유 있는 편"), ..., current_year=4, age=13, next_activity=job_bathhouse(통산3회, 최근:3년차 6월 하순)
```
