# 제안서: 패널 액션 시스템

## 배경

현재 AI 선택지의 `actions`는 `run_tool("engine", ...)`을 직접 호출한다. 이 방식의 문제:

1. **패널 연출 스킵** — 엔진만 호출하므로 패널의 애니메이션, 일별 시뮬레이션, 결과 카드 등 UI 연출이 전부 빠진다
2. **인터페이스 혼재** — 일부 조작은 엔진 액션(advance_slot), 일부는 패널 직접 변수 수정(schedule 설정). AI가 어떤 것을 써야 하는지 판단하기 어렵다
3. **패널 내부 구조 의존** — AI가 DOM 셀렉터나 패널 내부 로직을 알아야 하는 구조는 비현실적

## 목표

- **단일 인터페이스**: AI가 참조하는 액션 체계를 패널 액션으로 통일
- **연출 보존**: 선택지로 트리거해도 패널의 전체 UI 플로우가 동일하게 실행
- **선언적 설계**: 패널 디자인 타임에 외부 노출 액션을 명시적으로 선언

## 아키텍처

```
[기존]
AI 선택지 → run_tool("engine", action) → 엔진 직접 실행 (패널 연출 없음)
패널 버튼 → runTool("engine", action) → 애니메이션 → queueEvent → sendMessage

[변경 후]
AI 선택지 → panelAction("advance", "advance_slot") → 프론트엔드
  → 패널 모달 오픈 → 등록된 핸들러 실행
    → 내부적으로 runTool + 애니메이션 + queueEvent + sendMessage

패널 버튼 → 동일한 핸들러 실행 (변경 없음)
```

- **엔진 액션 = 내부 전용**: 패널이 내부적으로 호출하는 구현 디테일. AI에 직접 노출하지 않음
- **패널 액션 = 외부 인터페이스**: AI 선택지가 참조하는 유일한 액션 체계

## 구현 상세

### 1. 패널 액션 선언 (패널 HTML)

각 패널이 외부에서 호출 가능한 액션을 선언한다.

**방법 A: HTML 태그 (정적 선언)**
```html
<!-- 08-advance.html -->
<panel-actions>
[
  {
    "id": "advance_slot",
    "label": "스케줄 진행",
    "description": "현재 슬롯의 활동을 실행한다 (일별 시뮬레이션 애니메이션 포함)",
    "available_when": "turn_phase === 'executing' && current_slot < 3"
  }
]
</panel-actions>
```

**방법 B: JS 등록 (동적 선언)**
```js
__panelBridge.registerAction('advance_slot', {
  label: '스케줄 진행',
  description: '현재 슬롯의 활동을 실행한다',
  available_when: () => d.turn_phase === 'executing' && d.current_slot < 3,
  handler: async (params) => {
    advBtn.click(); // 기존 버튼 클릭 로직 재사용
  }
});
```

**권장: 방법 A + B 병행**
- `<panel-actions>` 태그로 메타데이터(id, label, description, available_when) 선언 — 패널 로드 전에도 파싱 가능
- `registerAction()`으로 런타임 핸들러 등록 — 패널 렌더링 후 DOM 참조 가능

### 2. 패널별 액션 목록 (초기 대상)

#### 08-advance.html (스케줄 진행)
```json
[
  {
    "id": "advance_slot",
    "label": "스케줄 진행",
    "description": "현재 슬롯의 활동을 실행한다 (일별 시뮬레이션 애니메이션 포함)",
    "available_when": "turn_phase === 'executing' && current_slot < 3"
  }
]
```
핸들러: 기존 `advBtn` 클릭 핸들러와 동일한 로직

#### 03-schedule.html (스케줄 설정)
```json
[
  {
    "id": "confirm_schedule",
    "label": "스케줄 확정",
    "description": "3슬롯 스케줄을 설정하고 확정한다. 실행 페이즈로 전환됨",
    "params": {
      "schedule_1": "활동 ID (상순)",
      "schedule_2": "활동 ID (중순)",
      "schedule_3": "활동 ID (하순)"
    },
    "available_when": "turn_phase === 'setup'"
  }
]
```
핸들러: params로 schedule_1/2/3 설정 → 기존 확정 버튼 로직 실행

#### 인벤토리 패널 (아이템)
```json
[
  {
    "id": "buy_item",
    "label": "아이템 구매",
    "description": "상점에서 아이템을 구매한다",
    "params": {
      "item_id": "아이템 ID",
      "qty": "수량 (기본 1)"
    },
    "available_when": "true"
  },
  {
    "id": "equip",
    "label": "장비 장착",
    "description": "아이템을 장착한다",
    "params": {
      "item_id": "아이템 ID"
    },
    "available_when": "true"
  }
]
```

### 3. 프론트엔드 수집 및 노출

#### 패널 로더 (`panel-engine` 또는 프론트엔드 패널 매니저)
1. 패널 HTML 로드 시 `<panel-actions>` 태그 파싱
2. 모든 패널의 액션을 중앙 레지스트리에 수집
3. 변수 변경 시 `available_when` 조건 재평가

#### `[AVAILABLE]` 헤더 생성
AI에게 메시지 전송 시, 현재 조건을 만족하는 패널 액션만 `[AVAILABLE]` 헤더로 포함:

```
[AVAILABLE]
- advance.advance_slot: 스케줄 진행 (현재 슬롯 실행)
- inventory.buy_item(item_id, qty): 아이템 구매
- inventory.equip(item_id): 장비 장착
```

setup 페이즈일 때:
```
[AVAILABLE]
- schedule.confirm_schedule(schedule_1, schedule_2, schedule_3): 스케줄 확정
- inventory.buy_item(item_id, qty): 아이템 구매
```

### 4. 선택지 형식 변경

**기존 (엔진 직접 호출):**
```json
{"text": "다음 슬롯!", "actions": [
  {"tool": "engine", "action": "advance_slot"}
]}
```

**변경 후 (패널 액션):**
```json
{"text": "다음 슬롯!", "actions": [
  {"panel": "advance", "action": "advance_slot"}
]}
```

**params가 있는 경우:**
```json
{"text": "학교 다니면서 농장도 하자!", "actions": [
  {"panel": "schedule", "action": "confirm_schedule", "params": {
    "schedule_1": "private_school",
    "schedule_2": "job_farm",
    "schedule_3": "job_farm"
  }}
]}
```

**복합 액션:**
```json
{"text": "장비 사고 바로 출발!", "actions": [
  {"panel": "inventory", "action": "buy_item", "params": {"item_id": "leather_armor"}},
  {"panel": "advance", "action": "advance_slot"}
]}
```

### 5. 프론트엔드 실행 흐름

선택지 클릭 시:

```
1. actions 배열 순회
2. 각 action에 대해:
   a. panel 모달이 닫혀있으면 오픈 (DOM 생성 대기)
   b. 패널의 등록된 핸들러에 params 전달하여 실행
   c. 핸들러 완료 대기 (async)
   d. 핸들러 내부에서 queueEvent + sendMessage가 호출됨
3. 마지막 action의 sendMessage가 text를 포함하여 전송
```

**주의사항:**
- 패널 모달 오픈 후 DOM 렌더링 + `registerAction` 완료까지 대기 필요
- 복합 액션에서 중간 action이 sendMessage를 호출하면 다음 action 전에 AI 턴이 시작될 수 있음 → 복합 액션 시 중간 sendMessage 억제 옵션 필요할 수 있음

### 6. 기존 `run_tool` 직접 호출 폐기

- AI 선택지의 `actions`에서 `{"tool": "engine", ...}` 형식 제거
- `run_tool`은 패널 내부 전용 (`__panelBridge.runTool()`)으로만 사용
- CLAUDE.md와 공용 세션 가이드의 선택지 규칙 업데이트

## 마이그레이션

### 단계 1: 인프라
- [ ] `<panel-actions>` 파서 구현 (패널 로더에 추가)
- [ ] `__panelBridge.registerAction()` API 추가
- [ ] 패널 액션 중앙 레지스트리 구현
- [ ] `available_when` 조건 평가 엔진 (변수 기반 표현식)

### 단계 2: 선택지 실행
- [ ] 선택지 클릭 시 `panel` 타입 액션 처리 로직
- [ ] 패널 모달 자동 오픈 + DOM 준비 대기
- [ ] 핸들러 호출 + params 전달
- [ ] 복합 액션 시퀀스 처리

### 단계 3: `[AVAILABLE]` 헤더
- [ ] 변수 변경 시 available 액션 목록 재계산
- [ ] AI 메시지 전송 시 `[AVAILABLE]` 헤더 자동 삽입

### 단계 4: 패널 마이그레이션
- [ ] 08-advance.html — `advance_slot` 액션 선언 + 핸들러 등록
- [ ] 03-schedule.html — `confirm_schedule` 액션 선언 + 핸들러 등록
- [ ] 인벤토리 패널 — `buy_item`, `equip` 등 액션 선언
- [ ] 기타 패널 — 필요에 따라 추가

### 단계 5: AI 가이드 업데이트
- [ ] 공용 세션 가이드의 선택지 시스템 섹션 변경
- [ ] 각 페르소나 CLAUDE.md 업데이트
- [ ] `{"tool": ...}` 형식 → `{"panel": ...}` 형식으로 전환

## 미해결 사항

1. **복합 액션의 중간 sendMessage 문제**: 패널 핸들러가 내부적으로 sendMessage를 호출하면 AI 턴이 시작됨. 복합 액션에서 마지막 액션만 sendMessage하도록 억제 메커니즘이 필요한가?
2. **패널이 로드되지 않은 상태**: `<panel-actions>` 메타데이터는 패널 HTML에 있으므로, 패널이 아직 렌더링되지 않아도 available 목록은 구성 가능. 하지만 핸들러는 렌더링 후에만 등록됨 → 실행 시점에 모달 오픈 + 렌더링 대기 필요
3. **페르소나 공통 vs 페르소나별**: `<panel-actions>` 선언은 각 페르소나의 패널에 귀속. 공통 패널이 있다면 공통 액션 레지스트리 필요
4. **에러 핸들링**: 핸들러 실패 시 선택지 상태 롤백? 사용자에게 에러 표시?
