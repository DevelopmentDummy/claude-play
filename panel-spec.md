# Panel System Specification

패널 시스템의 기술 레퍼런스. 빌더와 RP 세션 양쪽에서 참조한다.

---

## 파일 네이밍 규약

패널 파일은 `panels/` 디렉토리에 위치하며, 다음 형식을 따른다:

```
{두자리숫자}-{이름}.html
```

- 숫자는 표시 순서를 결정한다 (예: `01-상태.html`, `02-프로필.html`, `03-인벤토리.html`)
- 사용자에게 표시될 때 숫자 prefix는 자동 제거된다 (`01-상태` → `상태`)
- prefix가 없는 파일명도 동작한다 (`status.html` → `status`)

---

## Handlebars 헬퍼 목록

패널은 Handlebars 템플릿이며, `variables.json`의 값이 `{{변수명}}`으로 자동 주입된다.

### 산술 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `percentage` | `{{percentage val max}}` | 백분율 계산 (val/max×100, 반올림) |
| `add` | `{{add a b}}` | 더하기 |
| `subtract` | `{{subtract a b}}` | 빼기 |
| `multiply` | `{{multiply a b}}` | 곱하기 |
| `divide` | `{{divide a b}}` | 나누기 (0 나누기 방지) |
| `formatNumber` | `{{formatNumber n}}` | 천 단위 쉼표 |

### 비교 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `eq` | `{{#if (eq a b)}}` | 같음 |
| `ne` | `{{#if (ne a b)}}` | 다름 |
| `lt` | `{{#if (lt a b)}}` | 미만 |
| `lte` | `{{#if (lte a b)}}` | 이하 |
| `gt` | `{{#if (gt a b)}}` | 초과 |
| `gte` | `{{#if (gte a b)}}` | 이상 |

### 논리 헬퍼

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `and` | `{{#if (and a b)}}` | 논리 AND |
| `or` | `{{#if (or a b)}}` | 논리 OR |
| `not` | `{{#if (not a)}}` | 논리 NOT |

### 조건문 예시

```handlebars
{{#if (gt hp 50)}}높음{{else}}낮음{{/if}}
{{#if (eq weather "맑음")}}☀️{{/if}}
{{#if (and (gt trust 50) (gt affection 30))}}친밀{{/if}}
```

---

## 렌더링 환경

- 각 패널은 **Shadow DOM** 안에서 렌더링된다 → 외부 스타일과 충돌 없음
- 패널 컨테이너 기본 스타일: `padding: 8px 12px`, `font-size: 13px`, `color: #e0e0e0`
- `<style>` 태그를 패널 상단에 포함시켜 스코프 CSS를 작성한다

---

## CSS 스타일 가이드

### 기본 원칙

- **다크 테마** 기반 (배경 `#1a1a2e` 계열, 텍스트 `#e0e0e0` 계열)
- 캐릭터에 맞는 **액센트 색상**을 선택한다
- 폰트 크기는 `11px`~`13px` 범위로 유지한다

### 게이지 바 패턴

```html
<div class="stat">
  <span class="label">호감</span>
  <div class="bar-bg">
    <div class="bar love" style="width:{{percentage affection affection_max}}%"></div>
  </div>
  <span class="val">{{affection}}/{{affection_max}}</span>
</div>
```

```css
.stat { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.label { width: 48px; color: #8888a0; flex-shrink: 0; }
.bar-bg { flex: 1; height: 8px; background: #1a1a2e; border-radius: 4px; overflow: hidden; }
.bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
.val { width: 48px; text-align: right; font-size: 11px; color: #8888a0; }
```

### 태그/뱃지 패턴

```html
<div class="tags">
  <span class="tag">📍 {{location}}</span>
  <span class="tag">🕐 {{time}}</span>
</div>
```

```css
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.tag { background: #1a1a2e; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #8888a0; }
```

### 섹션 제목

```css
.section-title { font-size: 11px; color: #6c63ff; margin: 10px 0 6px; font-weight: 600; }
```

---

## variables.json 설계 규칙

- **게이지형 변수**는 반드시 `_max` 짝을 만든다: `hp` + `hp_max`, `affection` + `affection_max`
- 변수명은 **영문 snake_case**로 작성한다
- 위치(`location`), 시간(`time`), 날씨(`weather`) 같은 상황 변수를 포함한다
- **하드코딩 금지**: 패널에서 최댓값이나 문자열을 직접 쓰지 말고 반드시 변수로 참조한다
- 캐릭터 고유의 특수 변수를 추가한다 (예: 마법사 → `mana`, 탐정 → `clues_found`)

---

## 커스텀 데이터 파일

`variables.json` 외에 **임의의 `*.json` 파일**을 세션/페르소나 디렉토리에 두면 패널 템플릿에서 자동으로 접근할 수 있다. 파일명(확장자 제외)이 Handlebars 컨텍스트의 키가 된다.

### 예시

`world.json`:
```json
{
  "locations": [
    { "name": "크로엔 왕도", "distance": 5, "goods": "공예품, 보석", "desc": "거대한 성벽의 수도" },
    { "name": "리헨 평원시장", "distance": 7, "goods": "곡물, 가축", "desc": "드넓은 초원 위의 장터" },
    { "name": "벨라항", "distance": 3, "goods": "해산물, 향신료", "desc": "남쪽 항구 도시" }
  ],
  "routes": {
    "크로엔 왕도-벨라항": { "days": 4, "danger": "low" },
    "벨라항-리헨 평원시장": { "days": 6, "danger": "medium" }
  }
}
```

패널에서 사용:
```handlebars
{{#each world.locations}}
  {{#if (ne this.name ../location)}}
    <div class="dest">{{this.name}} — {{this.distance}}일 거리</div>
  {{/if}}
{{/each}}
```

`items.json`, `npcs.json`, `quests.json` 등 자유롭게 추가할 수 있다.

### 규칙

- 파일명이 컨텍스트 키가 된다: `world.json` → `{{world.xxx}}`, `items.json` → `{{items.xxx}}`
- `variables.json`의 값은 루트 레벨에 주입된다 (`{{location}}`, `{{hp}}` 등)
- 커스텀 데이터 파일은 파일명 키 아래에 주입된다 (`{{world.locations}}`, `{{items.weapons}}` 등)
- 파일이 변경되면 패널이 자동 재렌더링된다 (파일 감시 동작)
- 다음 시스템 파일은 자동 로드 대상에서 제외된다: `variables.json`, `session.json`, `builder-session.json`, `comfyui-config.json`, `layout.json`, `chat-history.json`, `character-tags.json`
- AI도 세션 중에 데이터 파일을 읽고 수정할 수 있다 (대화 맥락에 활용)

### variables.json vs 커스텀 데이터 파일

| | `variables.json` | 커스텀 데이터 파일 |
|---|---|---|
| 용도 | 매 턴 변하는 동적 상태 | 세계관, 아이템, NPC 등 정적/반정적 데이터 |
| 템플릿 접근 | `{{변수명}}` (루트) | `{{파일명.키}}` (네임스페이스) |
| 변경 주체 | AI가 매 턴 갱신 | AI가 필요 시 갱신, 또는 패널 브릿지로 갱신 |
| Bridge API | `__panelBridge.updateVariables()` | 직접 fetch로 수정 가능 |

---

## 인터랙티브 패널

패널 HTML 내에서 `<script>` 태그를 사용할 수 있다. 스크립트는 Shadow DOM 안에서 실행되지만 `window` 객체를 공유하므로, `window.__panelBridge` API를 통해 앱과 상호작용할 수 있다.

### Bridge API

| 메서드/속성 | 설명 |
|---|---|
| `__panelBridge.sendMessage(text)` | 채팅에 사용자 메시지를 전송한다. AI가 이 메시지에 응답한다. |
| `__panelBridge.updateVariables(patch)` | `variables.json`을 부분 업데이트한다. 패널이 자동 재렌더링된다. `patch`는 `{ key: value }` 객체. |
| `__panelBridge.data` | 전체 템플릿 컨텍스트 객체 (읽기 전용). `variables.json` 값 + 커스텀 데이터 파일이 합쳐져 있다. |
| `__panelBridge.sessionId` | 현재 세션 ID (읽기 전용) |

### 세션 이미지 리소스 사용

세션의 `images/` 디렉토리에 저장된 이미지(ComfyUI, Gemini 등으로 생성)를 패널에서 사용할 수 있다.

**Handlebars 방식** (권장 — 간단한 `<img>` 태그):
```html
<img src="{{__imageBase}}tavern-bg.png" />
```
`{{__imageBase}}`는 이미지 서빙 경로로 자동 치환된다. 세션에서는 `/api/sessions/{id}/files?path=images/`, 빌더에서는 `/api/personas/{name}/images?file=`로 설정된다. **파일명만 붙이면 된다** (`images/` 프리픽스 불필요).

**JavaScript 방식** (동적 이미지 교체 시):
```html
<script>
  const base = __panelBridge.data.__imageBase;
  const img = shadow.querySelector('.scene-img');
  img.src = base + 'scene.png';
</script>
```

**활용 예시:**
- 패널 배경: `background-image: url({{__imageBase}}panel-bg.png)`
- 장소 아이콘: 현재 `location` 변수에 따라 동적 교체
- 아이템 이미지: 인벤토리 패널에서 아이템별 이미지 표시

### `__panelBridge.data` 활용

Handlebars 없이 JS만으로 데이터를 가공하고 렌더링할 수 있다:

```html
<div class="dest-list"></div>

<script>
  const d = __panelBridge.data;
  const root = document.currentScript?.getRootNode();

  // variables.json 값: d.location, d.gold, d.hp 등
  // 커스텀 데이터: d.world (world.json), d.items (items.json) 등

  // JS로 자유롭게 필터링/정렬
  const nearby = d.world.locations
    .filter(loc => loc.name !== d.location)
    .sort((a, b) => a.distance - b.distance);

  root.querySelector('.dest-list').innerHTML = nearby
    .map(loc => `<button class="dest" data-name="${loc.name}">${loc.name} (${loc.distance}일)</button>`)
    .join('');

  // 버튼 클릭 → 채팅 전송도 조합 가능
  root.querySelectorAll('.dest').forEach(btn => {
    btn.addEventListener('click', () => {
      __panelBridge.sendMessage(`${btn.dataset.name}(으)로 이동하겠습니다`);
    });
  });
</script>
```

Handlebars와 혼용도 가능하다. 정적 부분은 `{{변수}}`로, 동적 로직이 필요한 부분은 `<script>` + `__panelBridge.data`로 처리하면 된다.

### Shadow DOM 내 요소 접근

스크립트는 Shadow DOM 안에서 실행되므로, `document.querySelector` 대신 **스크립트가 속한 Shadow Root**에서 요소를 찾아야 한다:

```html
<script>
  // 이 스크립트의 parentNode가 Shadow Root이다
  const root = document.currentScript?.getRootNode();
  const btn = root?.querySelector('.my-button');
</script>
```

### A) 선택지 버튼 → 채팅 전송

AI가 선택지를 패널에 표시하고, 사용자가 클릭하면 채팅으로 전송되는 패턴:

```html
<style>
  .choices { display: flex; flex-direction: column; gap: 6px; }
  .choice-btn {
    background: #1e2d4a; border: 1px solid #2a3a5e; border-radius: 8px;
    padding: 8px 12px; color: #e0e0e0; cursor: pointer; text-align: left;
    font-size: 12px; transition: all 0.2s;
  }
  .choice-btn:hover { background: #2a3a5e; border-color: #6c63ff; }
</style>

<div class="choices">
  {{#each choices}}
  <button class="choice-btn" data-action="{{this}}">{{this}}</button>
  {{/each}}
</div>

<script>
  const root = document.currentScript?.getRootNode();
  root?.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__panelBridge.sendMessage(btn.dataset.action);
    });
  });
</script>
```

### B) 변수 직접 조작 (상점, 치트 커맨드 등)

대화 없이 `variables.json`을 직접 수정하는 패턴. 패널 재렌더링이 자동으로 트리거된다:

```html
<style>
  .shop-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 0; border-bottom: 1px solid #1a1a2e;
  }
  .buy-btn {
    background: #6c63ff; color: white; border: none; border-radius: 6px;
    padding: 4px 10px; font-size: 11px; cursor: pointer;
  }
  .buy-btn:hover { opacity: 0.8; }
  .buy-btn:disabled { opacity: 0.3; cursor: not-allowed; }
</style>

<div class="shop-item">
  <span>회복 포션 (50G)</span>
  <button class="buy-btn" data-cost="50" data-item="potion">구매</button>
</div>

<script>
  const root = document.currentScript?.getRootNode();
  const d = __panelBridge.data;
  root?.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cost = Number(btn.dataset.cost);
      // data에서 현재 값을 읽고, updateVariables로 갱신
      await __panelBridge.updateVariables({
        gold: Math.max(0, d.gold - cost),
        potions: d.potions + 1
      });
    });
  });
</script>
```

### C) 클라이언트 인터랙션 (탭, 아코디언 등)

서버와 통신 없이 패널 내 UI만 전환하는 패턴:

```html
<style>
  .tab-bar { display: flex; gap: 2px; margin-bottom: 8px; }
  .tab { padding: 4px 10px; font-size: 11px; border-radius: 4px; cursor: pointer;
         background: transparent; color: #8888a0; border: none; }
  .tab.active { background: #1e2d4a; color: #e0e0e0; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
</style>

<div class="tab-bar">
  <button class="tab active" data-tab="stats">능력치</button>
  <button class="tab" data-tab="items">아이템</button>
</div>
<div class="tab-content active" id="stats">능력치 내용...</div>
<div class="tab-content" id="items">아이템 내용...</div>

<script>
  const root = document.currentScript?.getRootNode();
  root?.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      root.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      root.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      root.getElementById(tab.dataset.tab)?.classList.add('active');
    });
  });
</script>
```

### 주의사항

- 패널은 `variables.json` 변경 시 **전체 재렌더링**된다. 스크립트와 DOM 상태가 초기화되므로, 영속적 상태는 `variables.json`에 저장하라.
- `updateVariables`는 병합(merge)이다. 전달한 키만 덮어쓴다.
- `sendMessage`로 전송된 메시지는 일반 사용자 메시지와 동일하게 처리된다.

---

## 인라인 패널 (채팅 내 삽입)

사이드바뿐 아니라 **채팅 메시지 안에** 패널을 삽입할 수 있다. `$IMAGE:path$`와 동일한 문법:

```
$PANEL:패널명$
```

- `패널명`은 패널 파일의 표시 이름이다 (숫자 prefix 제거 후). 예: `05-거래.html` → `$PANEL:거래$`
- 해당 위치에 패널의 렌더링된 HTML이 Shadow DOM으로 인라인 표시된다
- 인라인 패널도 `<script>` + `__panelBridge` API를 사용할 수 있다
- 패널은 현재 `variables.json` 기준으로 렌더링되므로, 변수가 바뀌면 인라인 패널도 자동 갱신된다

### 사용 예시

AI 응답 안에서:
```
물건들을 살펴보시겠어요?

$PANEL:거래$

마음에 드는 게 있으면 골라주세요.
```

### 인라인 vs 사이드바

| | 사이드바 패널 | 인라인 패널 |
|---|---|---|
| 표시 위치 | 우측/좌측/하단 고정 | 채팅 메시지 내 |
| 항상 표시 | O (세션 내내) | X (해당 메시지에서만) |
| 용도 | 상태, 프로필 등 상시 정보 | 선택지, 거래, 일회성 인터랙션 |
| `$PANEL:` 필요 | X (자동 표시) | O (AI가 태그 출력) |

---

## 패널 종류 예시

캐릭터에 따라 적절한 패널을 1~3개 생성한다:

- **상태 패널** (`01-상태.html`): 관계 수치 게이지, 위치/시간/날씨 태그
- **프로필 패널** (`02-프로필.html`): 캐릭터 간략 정보, 현재 복장, 표정
- **인벤토리 패널** (`03-인벤토리.html`): 소지품, 아이템 목록
- **퀘스트/목표 패널**: 진행 중인 이벤트나 과제
- **관계도 패널**: 다른 NPC와의 관계
- **특수 패널**: 캐릭터 고유 (마법 주문 목록, 수사 노트 등)
