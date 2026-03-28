---
name: panel-design
description: 패널 생성, 수정, 레이아웃 설정, 커스텀 데이터 구조 설계, 엔진 스크립트 작성, 팝업 이펙트 등 패널 시스템 전반을 다룬다. 패널 HTML을 만들거나 고칠 때, variables.json이나 커스텀 데이터 구조를 설계할 때, layout.json을 변경할 때, tools/engine.js에 액션을 추가할 때, hint-rules.json을 작성할 때, 팝업 템플릿을 만들 때 반드시 이 스킬을 사용하라. "패널 만들어줘", "인벤토리 패널", "레이아웃 변경", "게이지 바", "엔진 액션 추가", "팝업", "dock 패널", "모달", "변수 추가", "상태 패널" 등의 키워드에 트리거된다.
allowed-tools: Read, Write, Edit, Bash
---

# 패널 시스템 — 제작 및 변경 가이드

## 아키텍처 핵심

패널 시스템은 **MVC 데이터 드리븐 구조**다:

```
[JSON 데이터] ←→ [패널 UI] (표시 + 조작)
     ↕
[AI 에이전트] + [엔진 스크립트]
```

- **Model** = `variables.json` + 커스텀 `*.json` (game-state.json, inventory.json 등)
- **View** = 패널 HTML (Handlebars 템플릿 + Shadow DOM CSS 격리)
- **Controller** = 엔진 스크립트 (`tools/engine.js`) + `__panelBridge` API

**핵심 원칙:**
- 패널은 자체 상태를 갖지 않는다 — 재렌더링되면 DOM이 초기화된다
- 유지해야 할 상태는 반드시 JSON 파일에 저장한다
- 규칙 기반 로직(데미지 계산, 아이템 효과)은 엔진에 위임한다
- AI는 서사를, 엔진은 판정을, 패널은 표시와 입력을 담당한다

---

## Shadow DOM 스크립트 환경

패널의 `<script>` 블록은 시스템이 `new Function("shadow", code)` 로 감싸서 실행한다. 따라서:

- **`shadow`가 자동 주입된다** — Shadow Root 참조. 별도 선언 불필요.
- **스코프가 자동 격리된다** — IIFE `(function(){ ... })()` 래핑 불필요.
- **`document.currentScript.getRootNode()` 불필요** — `shadow`가 이미 같은 역할.

```html
<!-- ✅ 올바른 패턴 -->
<script>
  shadow.querySelector('.btn')?.addEventListener('click', () => { ... });
  const items = shadow.querySelectorAll('.item');
</script>

<!-- ❌ 불필요한 패턴 (동작은 하지만 장황함) -->
<script>
(function() {
  const root = document.currentScript.getRootNode();
  root.querySelector('.btn')?.addEventListener('click', () => { ... });
})();
</script>
```

**`<script type="application/json">`은 실행되지 않는다** — Handlebars 데이터를 JS에 전달하는 용도.

---

## 패널 타입별 체크리스트

### 사이드바 패널 (left/right)
- [ ] `panels/{번호}-{이름}.html` 파일 생성
- [ ] `layout.json` → `panels.placement.{이름}` = `"left"` 또는 `"right"`

### 모달 패널
- [ ] `panels/{번호}-{이름}.html` 파일 생성
- [ ] `layout.json` → `panels.placement.{이름}` = `"modal"`
- [ ] `variables.json` → `__modals.{이름}` = `false` (초기값)
- [ ] 어딘가에 열기 버튼: `__panelBridge.openModal('{이름}', 'dismissible')`
- [ ] (선택) `layout.json` → `panels.modalGroups`에 그룹 등록 (상호 배타)
- [ ] (선택) `layout.json` → `panels.autoRefresh.{이름}` = `false` (복잡한 JS 상태 보존 시)

### 독 패널 (dock 계열)
- [ ] `panels/{번호}-{이름}.html` 파일 생성
- [ ] `layout.json` → `panels.placement.{이름}` = `"dock"` / `"dock-left"` / `"dock-right"`
- [ ] `variables.json` → `__modals.{이름}` = `false` (모달과 동일한 on/off)
- [ ] (선택) `layout.json` → `panels.dockWidth`, `panels.dockHeight` 크기 설정

### 인라인 패널
- [ ] `panels/{번호}-{이름}.html` 파일 생성 (placement 등록 **안 함**)
- [ ] AI 프롬프트에서 `$PANEL:이름$` 토큰 사용법 안내
- [ ] (선택) `session-instructions.md`에 인라인 패널 사용 지침 추가

### 팝업 이펙트
- [ ] `popups/{이름}.html` 파일 생성 (panels/ 아님)
- [ ] 트리거 코드: `showPopup('{이름}')` (패널) 또는 `__popups` (엔진)
- [ ] 팝업 전용 변수가 필요하면 `vars` 옵션으로 전달

---

## 패널 액션 시스템

패널이 외부에서 호출 가능한 액션을 제공할 때, **패널 액션**으로 선언한다. 패널 액션은:

- AI 선택지가 참조하는 유일한 액션 체계 — AI는 `{panel: "...", action: "..."}` 형식으로 선택지를 구성한다
- 패널 버튼과 선택지가 **동일한 실행 경로**를 공유한다 — 액션 핸들러가 primary 로직
- 실행 시 자동으로 히스토리에 기록되어 AI에게 `[ACTION_LOG]`로 전달된다
- `available_when` 조건에 따라 `[AVAILABLE]` 헤더로 AI에게 현재 가능한 액션이 알려진다

### `<panel-actions>` 메타데이터 선언

패널 HTML 최상단에 `<panel-actions>` 태그로 메타데이터를 선언한다. 이 태그는 패널 로드 전에도 파싱 가능하며, 핸들러 없이도 available 목록에 포함된다:

```html
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

<style>
  /* ... 패널 스타일 ... */
</style>
```

**필드:**
| 필드 | 필수 | 설명 |
|------|------|------|
| `id` | ✅ | 액션 식별자. `registerAction()`의 첫 번째 인자와 일치해야 함 |
| `label` | ✅ | AI에게 보여지는 짧은 설명 |
| `description` | ✅ | 액션의 상세 설명 |
| `params` | | 파라미터 맵 `{ "param_name": "설명" }`. AI가 선택지에 params를 넣을 수 있음 |
| `available_when` | | `variables.json` 변수를 참조하는 JS 표현식. 생략 시 항상 available |

### `registerAction()` 핸들러 등록

`<script>` 블록에서 `__panelBridge.registerAction()`으로 런타임 핸들러를 등록한다. **이 핸들러가 패널 액션의 primary 로직이다** — 모든 실행 경로(버튼, 선택지)가 이 핸들러를 통과한다:

```javascript
// 핸들러 등록 — 이것이 이 액션의 유일한 실행 로직
__panelBridge.registerAction('buy_item', async (params) => {
  const res = await __panelBridge.runTool('engine', {
    action: 'buy_item', item: params.item_id, qty: params.qty || 1
  });
  if (res.result?.success) {
    await __panelBridge.queueEvent(`[구매: ${params.item_id} × ${params.qty || 1}]`);
    // UI 피드백, 애니메이션 등
  }
});

// 버튼은 executeAction으로 위임 — 인라인에 로직을 넣지 않는다
shadow.querySelector('.buy-btn')?.addEventListener('click', async function() {
  this.disabled = true;
  await __panelBridge.executeAction('buy_item', {
    item_id: this.dataset.item, qty: 1
  });
});
```

### `executeAction()` 실행

`executeAction()`은 레지스트리를 통해 핸들러를 호출하고, 히스토리에 자동 기록한다:

```javascript
// 패널 내부에서 호출 (패널 이름 자동 감지)
await __panelBridge.executeAction('advance_slot');

// 파라미터 전달
await __panelBridge.executeAction('confirm_schedule', {
  schedule_1: 'private_school',
  schedule_2: 'job_farm',
  schedule_3: 'job_farm'
});
```

### 패널 액션 체크리스트

서버 연동이 있는 패널을 만들 때:

- [ ] `<panel-actions>` 태그로 메타데이터 선언 (id, label, description, available_when)
- [ ] `registerAction()`으로 핸들러 등록 — 여기에 모든 비즈니스 로직 (runTool + UI 연출)
- [ ] UI 버튼의 클릭 이벤트에서 `executeAction()` 호출 — 인라인 로직 금지
- [ ] AI 선택지 형식 확인: `{"panel": "패널이름", "action": "액션id", "params": {...}}`

---

## 패널 복잡도 스펙트럼

패널은 용도에 따라 세 단계로 나뉜다. 가장 단순한 수준부터 시작하고, 필요할 때만 복잡도를 올려라:

| 수준 | 구성 | 예시 |
|------|------|------|
| **정적 표시** | Handlebars + CSS만 | 프로필 카드, 로그, 상태 요약 |
| **클라이언트 인터랙션** | + `<script>` (탭, 아코디언, 모달 열기) | 탭 UI, 퀵 버튼, 토글 |
| **서버 연동** | + `runTool` / `sendMessage` / `queueEvent` | 상점, 전투, 스케줄 설정 |

단순 정보 표시에 엔진 연동이 필요 없고, 탭 UI에 서버 통신이 필요 없다. 과설계하지 마라.

---

## 패널 생성 워크플로우

### Step 1: 요구사항 → 배치 타입 결정

| 용도 | 배치 타입 | 근거 |
|------|-----------|------|
| 상시 표시 요약 (HP, 스탯, 프로필) | `left` / `right` | 항상 보이는 사이드바 |
| 상세 조작 UI (스케줄, 인벤토리, 상점) | `modal` | 필요할 때 열고 닫음 |
| 진행 컨트롤 (슬롯 진행 버튼) | `dock` / `dock-right` | 채팅 옆에 항상 접근 가능 |
| 캐릭터 일러스트 / 씬 이미지 | `left` / `dock-left` | 시각적 참조용 |
| 일회성 선택지 (거래, 퀴즈) | 인라인 (`$PANEL:이름$`) | 대화 흐름에 자연 삽입 |
| 전체화면 인터랙션 (전투, 모험) | `modal` + `autoRefresh: false` | 복잡한 JS 상태 보존 |

**결정 기준:**
- 항상 보여야 하는가? → 사이드바
- 필요할 때만 열리는가? → 모달
- 게임 플레이 중 상시 접근? → 독
- 대화 흐름에 자연 삽입? → 인라인
- CSS 애니메이션 / 복잡한 JS 상태? → `autoRefresh: false` 추가

### Step 2: 데이터 모델 설계

패널이 읽을 데이터를 **먼저** 설계한다 (UI보다 데이터가 선행):

- 매 턴 변하는 동적 값 → `variables.json`
- 구조화된 정적/반정적 데이터 → 커스텀 `*.json`
- 규칙 기반 조작이 필요 → `tools/engine.js` 액션 추가

**variables.json 규칙:**
- 게이지형 변수는 `_max` 짝 필수: `hp` + `hp_max`
- 변수명은 영문 `snake_case`
- 상황 변수 포함: `location`, `time`, `mood`, `outfit` 등
- 하드코딩 금지: 패널에서 최댓값이나 문자열을 직접 쓰지 말고 변수 참조
- `__` 접두사는 시스템 예약: `__modals`, `__popups` 등

→ 데이터 설계 상세: `references/engine-and-data.md`

### Step 3: HTML 작성

파일을 `panels/{순서번호}-{이름}.html` 로 생성. 숫자 prefix가 표시 순서를 결정하고, UI에서는 자동 제거된다.

**기본 구조:**
```html
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap');
  :host { font-family: 'Noto Sans KR', sans-serif; }

  .panel-root {
    background: linear-gradient(135deg, #2a1f3d 0%, #1e1630 100%);
    border-radius: 12px;
    padding: 14px;
  }
  /* 컴포넌트 스타일 */
</style>

<div class="panel-root">
  <div class="header">{{name}} · {{age}}세</div>
  <div class="bar-row">
    <div class="bar-fill hp" style="width:{{percentage hp hp_max}}%"></div>
  </div>
  {{#if (gt stress 70)}}<div class="warning">스트레스 과다!</div>{{/if}}
</div>

<script>
  // shadow는 Shadow Root 참조 — 시스템이 자동 주입한다 (아래 "스크립트 환경" 참조)
  shadow.querySelector('.some-btn')?.addEventListener('click', () => {
    __panelBridge.openModal('inventory', 'dismissible');
  });
</script>
```

→ Handlebars 헬퍼 & CSS 패턴 상세: `references/helpers-and-patterns.md`

### Step 4: 레이아웃 등록

`layout.json`의 `panels.placement`에 이름 등록 (파일명에서 숫자 prefix 제거):

```json
{
  "panels": {
    "placement": { "inventory": "modal" }
  }
}
```

모달/독이면 `variables.json`의 `__modals`에도 초기값 추가:
```json
{ "__modals": { "inventory": false } }
```

### Step 5: 인터랙션 연결

→ 아래 "핵심 인터랙티브 패턴" 섹션과 `references/bridge-api.md` 참조

---

## 배치 타입 상세

### 사이드바 (`left` / `right`)
- 세션 내내 항상 표시, `panels.size` (기본 300px) 너비
- `showProfileImage: false` — 좌측 사이드바의 프로필 이미지 숨기기

### 모달 (`modal`)
- `__modals.{name}`이 truthy일 때 표시
- `true` = 필수 (ESC/X/배경 클릭 닫기 불가), `"dismissible"` = 자유롭게 닫기
- 여러 모달 겹침 가능 (z-index 자동 증가, ESC는 최상위만 닫음)

**모달 그룹** — 상호 배타적 UI 흐름:
```json
"modalGroups": {
  "gameplay": ["schedule", "advance", "competition", "inventory"],
  "overlay": ["portrait", "values"]
}
```
같은 그룹 모달이 열리면 나머지 자동 닫힘. 그룹 없는 모달은 독립 동작.

### 독 (`dock` 계열)
| 타입 | 위치 | 특성 |
|------|------|------|
| `dock` / `dock-bottom` | 채팅↔입력 사이, 전체 너비 | 같은 방향 여러 독 → 탭 |
| `dock-left` / `dock-right` | 채팅 영역 안, float + sticky | 겹치는 메시지 너비 축소 |

- `dockWidth` (px) — dock-left/right 너비 (기본 auto, min 280, max 50%)
- `dockHeight` (px) — 모든 독 최대 높이 (기본 50vh)
- `__modals`로 on/off 제어

### 인라인 (배치 없음)
- AI가 응답에 `$PANEL:이름$` 토큰 삽입 → 해당 위치에 렌더링
- 해당 메시지에서만 표시, 일회성 인터랙션에 적합
- 인라인에서도 `<script>` + Bridge API 사용 가능

---

## 핵심 인터랙티브 패턴

### A) 채팅 전송
```javascript
btn.addEventListener('click', () => __panelBridge.sendMessage(btn.dataset.action));
```

### B) 패널 액션 (엔진 호출 + 상태 변경)
서버 연동이 있는 패널은 **반드시 패널 액션을 사용하라**. 인라인 핸들러에 runTool을 직접 넣지 않는다:

```javascript
// 1. 핸들러 등록 (primary 로직)
__panelBridge.registerAction('buy_item', async (params) => {
  const res = await __panelBridge.runTool('engine', {
    action: 'buy_item', item: params.item_id, qty: params.qty || 1
  });
  if (!res.result?.success) throw new Error(res.result?.message || '구매 실패');
  await __panelBridge.queueEvent(`[구매: ${params.item_id} × ${params.qty || 1}]`);
});

// 2. 버튼 → executeAction 위임
shadow.querySelector('.buy-btn')?.addEventListener('click', async function() {
  this.disabled = true;
  try {
    await __panelBridge.executeAction('buy_item', {
      item_id: this.dataset.item, qty: 1
    });
  } catch { this.disabled = false; }
});
```

**왜 이 패턴인가:**
- AI 선택지와 UI 버튼이 **같은 핸들러**를 호출하여 동작이 동일
- `executeAction()`이 실행을 히스토리에 자동 기록 → `[ACTION_LOG]`에 반영
- `available_when` 조건으로 AI에게 현재 가능한 액션만 `[AVAILABLE]`로 노출

### C) 모달 열기/닫기/토글
```javascript
__panelBridge.openModal('inventory', 'dismissible');
__panelBridge.closeModal('inventory');
// 토글
const isOpen = (__panelBridge.data.__modals || {}).inventory;
isOpen ? __panelBridge.closeModal('inventory') : __panelBridge.openModal('inventory', 'dismissible');
```

### D) AI에게 맥락 전달
패널 액션 핸들러 내부에서 `queueEvent`를 호출하여 AI에게 맥락을 전달한다. 패널 액션을 사용하면 `[ACTION_LOG]`에도 자동 기록되므로, `queueEvent`는 추가 디테일이 필요할 때만 사용:

```javascript
// 패널 액션 핸들러 안에서 — 상세 결과를 AI에게 전달
__panelBridge.registerAction('use_item', async (params) => {
  const res = await __panelBridge.runTool('engine', { action: 'use_item', item: params.item });
  if (res.result?.success) {
    const fx = Object.entries(res.result.effects || {}).map(([k,v]) => `${k}${v>0?'+':''}${v}`).join(', ');
    await __panelBridge.queueEvent(`[아이템사용: ${params.item} → ${fx}]`);
  }
});
```

### E) 클라이언트 전용 UI (탭)
```javascript
shadow.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    shadow.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    shadow.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    shadow.getElementById(tab.dataset.tab)?.classList.add('active');
  });
});
```

### F) autoRefresh: false 패널에서 수동 데이터 갱신
```javascript
__panelBridge.on('turnEnd', () => {
  const d = __panelBridge.data;
  shadow.querySelector('.hp').textContent = `${d.hp}/${d.hp_max}`;
});
```

### G) 퀵 버튼 → 모달 (사이드바 + 모달 연계 패턴)
사이드바에 요약 정보 + 버튼을 두고, 클릭하면 상세 모달이 열리는 패턴. 이것이 **progressive disclosure** — 간결한 사이드바에서 한 번의 클릭으로 상세 UI에 접근:
```html
<div class="quick-btns">
  <button class="qbtn" id="openSchedule">📅 스케줄</button>
  <button class="qbtn" id="openInventory">🎒 인벤</button>
</div>
<script>
  shadow.querySelector('#openSchedule')?.addEventListener('click',
    () => __panelBridge.openModal('schedule', 'dismissible'));
  shadow.querySelector('#openInventory')?.addEventListener('click',
    () => __panelBridge.openModal('inventory', 'dismissible'));
</script>
```

→ Bridge API 전체 메서드: `references/bridge-api.md`

---

## 팝업 이펙트

화면 중앙에 일시적으로 표시되는 연출용 오버레이. `popups/` 디렉토리에 HTML 파일 작성.

```html
<!-- popups/level-up.html -->
<style>
  .popup-content { text-align: center; padding: 12px; }
  .title { font-size: 22px; font-weight: 800; color: var(--popup-primary); }
</style>
<div class="popup-content">
  <div class="title">LEVEL UP!</div>
  <div>Lv. {{level}}</div>
</div>
```

**트리거:**
```javascript
// 패널에서
await __panelBridge.showPopup('level-up', { duration: 4000, vars: { level: 10 } });

// 엔진에서
return { variables: { __popups: [{ template: 'level-up', duration: 4000, vars: { level: 10 } }] } };
```

- 큐 기반 순차 재생, 다음 비-OOC 메시지 시 자동 클리어
- `--popup-primary`, `--popup-glow` CSS 변수로 테마 연동
- 진입 (scale 0.7→1 + fade in) / 퇴장 (scale 1→0.9 + fade out) 애니메이션 자동

---

## 자동 갱신 제어

```json
{ "panels": { "autoRefresh": { "portrait": false, "competition": false } } }
```

| 값 | 동작 |
|---|---|
| `true` (기본) | 변수/데이터 변경, AI 턴 종료 시마다 재렌더링 |
| `false` | HTML 템플릿 파일이 직접 수정될 때만 재렌더링 |

**`false`가 필요한 경우:**
- CSS 애니메이션 보존 (진행 도트, 전투 이펙트)
- 복잡한 JS 상태 유지 (전투 시뮬레이션, 슬롯 진행)
- `__panelBridge.on('turnEnd')` 로 필요한 데이터만 수동 갱신

---

## 턴 기반 연출 오케스트레이션

패널의 기믹적 깊이는 "무엇을 보여주는가"가 아니라 **"언제 보여주고 언제 숨기는가"**에 있다.

### 2-Phase 아키텍처

하나의 턴 진행에 두 개의 의미 단위가 있을 때, 이를 분리하여 각각 독립된 AI 서사를 받는 구조:

```
Phase 1: [엔진: 행동 처리] → [AI 서사: 무엇을 했는가]
            ↓ turnEnd
Phase 2: [엔진: 시간 진행] → [팝업 연출] → [AI 서사: 무엇이 달라졌는가 (silent)]
```

**설계 철학:**
- **행동 결과와 시간 진행을 분리** — "검술 연습을 마쳤다"와 "겨울이 찾아왔다"는 다른 서사 단위
- **엔진은 즉시, 연출은 지연** — 데이터는 빠르게 갱신하되, 팝업/모달은 AI 서사 완료 후에
- **Silent Message** — 유저에게 보이지 않는 메시지로 AI 턴을 트리거. `sendMessage(text, { silent: true })`
- **조건부 2턴** — 시간 진행에 중요 이벤트가 있을 때만 2턴, 없으면 조용히 전환
- **유저에게 주도권** — AI가 모달을 직접 열지 않고, 인라인 트리거 버튼으로 유저 타이밍에 맞춤
- **원샷 훅** — `turnEnd` 리스너를 한 번 실행하고 즉시 해제하여 누적 방지

```javascript
// 2-Phase 대표 패턴: 행동 결과 → AI 서사 → turnEnd → 시간 진행 → 팝업 → silent AI 서사
async function finalize(result) {
  await queueEvent(buildSlotSummary(result));  // Phase 1: 행동 결과만
  sendMessage('[진행]');

  if (result.pending_transition) {
    const unsub = __panelBridge.on('turnEnd', async () => {
      unsub();
      const tr = await runTool('engine', { action: 'turn_transition' });
      if (tr.result?.popups) showPopups(tr.result.popups);      // 팝업 즉시
      if (tr.result?.needs_narration)
        sendMessage(buildMonthSummary(tr.result), { silent: true }); // Phase 2
    });
  }
}
```

→ 전체 패턴 (지연 팝업, 지연 모달, 스트리밍 가드, 애니메이션 잠금, silent message, 2-phase 전환, 크로스 패널 통신, 위상 기반 가시성 등): `references/turn-choreography.md`

---

## 주의사항 & 안티패턴

1. **Shadow DOM 접근**: `document.querySelector` ❌ → `shadow.querySelector` ✅ (자동 주입)
2. **패널에 상태 저장**: DOM/변수에 저장 ❌ → JSON 파일에 저장 ✅
3. **하드코딩**: `style="width:50%"` ❌ → `style="width:{{percentage hp hp_max}}%"` ✅
4. **연타 방지**: 비동기 버튼에 `btn.disabled = true` 필수
5. **엔진 반환값 추측 금지**: 엔진 코드를 읽고 실제 반환 구조 확인 후 필드 참조
6. **이벤트 중복 등록**: `autoRefresh: true` 패널에서 `on(event)` 사용 시 재렌더링마다 리스너 누적
7. **모달 직접 조작보다 API 우선**: `updateVariables({ __modals })` 대신 `openModal()`/`closeModal()` → 그룹 로직 자동 적용
8. **커스텀 데이터 네임스페이스**: `world.json` → `{{world.locations}}` (파일명이 키)
9. **시스템 파일 접근 불가**: `session.json`, `layout.json`, `chat-history.json` 등은 데이터 로딩에서 제외
10. **JSON 데이터를 JS로 전달**: Handlebars에서 복잡한 객체를 직접 쓸 수 없을 때 `{{json (lookup this "file-name")}}` → `<script type="application/json">` 패턴 사용
11. **인라인 핸들러에 서버 로직 금지**: 클릭 핸들러에서 `runTool` 직접 호출 ❌ → `registerAction`에 로직을 등록하고 버튼은 `executeAction`으로 위임 ✅. 인라인 핸들러에 로직을 넣으면 AI 선택지가 같은 동작을 재현할 수 없고, 히스토리에 기록되지 않는다
12. **`<panel-actions>` 누락**: 서버 연동 액션이 있는 패널은 반드시 `<panel-actions>` 메타데이터를 선언해야 AI가 해당 액션을 인지하고 선택지에 포함할 수 있다

---

## 참조 문서

상세한 레퍼런스가 필요할 때 아래 파일을 읽어라:

| 파일 | 내용 | 언제 읽나 |
|------|------|-----------|
| `references/helpers-and-patterns.md` | Handlebars 헬퍼 전체 목록, CSS 디자인 패턴 (게이지/태그/그리드/버튼/탭/카드/애니메이션) | 패널 HTML/CSS 작성 시 |
| `references/bridge-api.md` | Bridge API 전체 메서드·이벤트, 이미지 리소스 사용법 | 인터랙티브 기능 추가 시 |
| `references/engine-and-data.md` | 엔진 스크립트 인터페이스, 액션 디스패처, 데이터 파일 설계, hint-rules.json | 엔진/데이터 구조 작업 시 |
| `references/turn-choreography.md` | 턴 사이클 타이밍 제어: 지연 팝업, 지연 모달, 스트리밍 가드, 애니메이션 잠금, 원샷 훅, 크로스 패널 통신, 위상 기반 가시성 — 9가지 연출 패턴 | 턴 기반 연출·타이밍 제어가 필요할 때 |

세션에 `panel-spec.md`가 있으면 기술 명세의 원본으로 참조할 수 있다.
