# Handlebars 헬퍼 & CSS 디자인 패턴

## Handlebars 헬퍼

### 산술

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `percentage` | `{{percentage val max}}` | val/max×100, 반올림 |
| `add` | `{{add a b}}` | 더하기 |
| `subtract` | `{{subtract a b}}` | 빼기 |
| `multiply` | `{{multiply a b}}` | 곱하기 |
| `divide` | `{{divide a b}}` | 나누기 (0 방지) |
| `formatNumber` | `{{formatNumber n}}` | 천 단위 쉼표 (1000 → 1,000) |

### 비교

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `eq` | `{{#if (eq a b)}}` | 같음 (==) |
| `ne` | `{{#if (ne a b)}}` | 다름 (!=) |
| `lt` | `{{#if (lt a b)}}` | 미만 (<) |
| `lte` | `{{#if (lte a b)}}` | 이하 (<=) |
| `gt` | `{{#if (gt a b)}}` | 초과 (>) |
| `gte` | `{{#if (gte a b)}}` | 이상 (>=) |

### 논리

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `and` | `{{#if (and a b)}}` | 논리 AND |
| `or` | `{{#if (or a b)}}` | 논리 OR |
| `not` | `{{#if (not a)}}` | 논리 NOT |

### 특수

| 헬퍼 | 사용법 | 설명 |
|---|---|---|
| `json` | `{{json object}}` | 객체를 JSON 문자열로 직렬화 |
| `lookup` | `{{lookup this "key-name"}}` | 하이픈 포함 키 접근 |

### 조건문 활용 예시

```handlebars
{{! 단순 비교 }}
{{#if (gt hp 50)}}높음{{else}}낮음{{/if}}

{{! 문자열 매칭 }}
{{#if (eq weather "맑음")}}☀️{{else if (eq weather "비")}}🌧️{{/if}}

{{! 복합 조건 }}
{{#if (and (gt trust 50) (gt affection 30))}}친밀{{/if}}

{{! 이모지 조건부 표시 (중첩 if) }}
{{#if (gte stress 70)}}😰{{else}}{{#if (gte stress 40)}}😐{{else}}😊{{/if}}{{/if}}

{{! 커스텀 데이터 반복 — 현재 위치 제외한 목적지 }}
{{#each world.locations}}
  {{#if (ne this.name ../location)}}
    <div class="dest">{{this.name}} — {{this.distance}}일 거리</div>
  {{/if}}
{{/each}}

{{! 빈 배열 처리 }}
{{#if items.length}}
  {{#each items}}<div>{{this.name}}</div>{{/each}}
{{else}}
  <div class="empty">아이템이 없습니다</div>
{{/if}}
```

### JSON 데이터를 스크립트에 전달하는 패턴

커스텀 데이터 파일의 복잡한 객체를 JS에서 사용할 때:

```html
<script type="application/json" id="logData">{{json (lookup this "event-log")}}</script>

<script>
(function() {
  // shadow는 자동 주입됨 — SKILL.md "Shadow DOM 스크립트 환경" 참조
  let data = {};
  try { data = JSON.parse(shadow.querySelector('#logData').textContent) || {}; } catch {}
  const entries = data.log || [];
  // ... JS로 자유롭게 처리
})();
</script>
```

`lookup this "event-log"`이 필요한 이유: `event-log`의 하이픈을 Handlebars가 빼기 연산으로 해석하기 때문.

### `__panelBridge.data`로 직접 접근하는 대안

Handlebars 없이 JS만으로 데이터를 가공할 수도 있다:

```javascript
const d = __panelBridge.data;
d.hp              // variables.json의 hp
d.world           // world.json 전체 객체
d.inventory       // inventory.json 전체 객체
d.__imageBase     // 이미지 서빙 경로
```

Handlebars는 정적 표시, JS는 동적 로직이 필요한 부분에 사용하면 자연스럽다. 혼용 가능.

---

## CSS 디자인 패턴

### 테마 색상 체계

`layout.json`의 `theme` 객체에서 색상을 가져와 패널 전체의 일관성을 유지한다:

| 역할 | 예시 값 | 용도 |
|------|---------|------|
| `accent` | `#e8a0bf` | 강조색, 제목, 활성 요소, 테두리 하이라이트 |
| `bg` | `#1a1425` | 최하위 배경 |
| `surface` | `#231d33` | 카드/패널 배경 |
| `surfaceLight` | `#2e2640` | 호버, 약간 밝은 배경 |
| `userBubble` | `#2e2545` | 사용자 채팅 버블 |
| `assistantBubble` | `#28203d` | AI 채팅 버블 |
| `border` | `#3a2e55` | 테두리 |
| `text` | `#f0e8f5` | 주 텍스트 |
| `textDim` | `#9988aa` | 보조 텍스트, 레이블 |

패널에서 이 값들을 직접 사용하면 테마 변경 시 자연스럽게 따라간다.
`rgba()` 변형도 활용: `rgba(232,160,191,0.15)` (accent의 반투명).

### 게이지 바

```css
.bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.bar-label { width: 26px; font-size: 10px; color: #9988aa; text-align: center; flex-shrink: 0; }
.bar-track {
  flex: 1; height: 10px;
  background: rgba(255,255,255,0.06);
  border-radius: 5px; overflow: hidden;
}
.bar-fill {
  height: 100%; border-radius: 5px;
  transition: width 0.4s ease;
}
.bar-fill::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 50%;
  background: linear-gradient(180deg, rgba(255,255,255,0.2), transparent);
  border-radius: 5px 5px 0 0;
}
.bar-fill.hp { background: linear-gradient(90deg, #4dcc7a, #2ecc71); }
.bar-fill.stress { background: linear-gradient(90deg, #e8a0bf, #e74c6f); }
.bar-fill.mana { background: linear-gradient(90deg, #6cb3ff, #3498db); }
.bar-num { width: 50px; font-size: 10px; color: #c8a0d4; text-align: right; flex-shrink: 0; }
```

```html
<div class="bar-row">
  <div class="bar-label">❤️</div>
  <div class="bar-track">
    <div class="bar-fill hp" style="width:{{percentage hp hp_max}}%"></div>
  </div>
  <div class="bar-num">{{hp}}/{{hp_max}}</div>
</div>
```

### 태그/뱃지

```css
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  background: rgba(255,255,255,0.06);
  padding: 2px 8px; border-radius: 4px;
  font-size: 11px; color: #9988aa;
}
.tag.accent { background: rgba(232,160,191,0.12); color: #e8a0bf; }
```

```html
<div class="tags">
  <span class="tag">📍 {{location}}</span>
  <span class="tag">🕐 {{time}}</span>
  <span class="tag accent">{{mood}}</span>
</div>
```

### 정보 그리드

```css
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.info-item { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.info-icon {
  width: 22px; height: 22px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; flex-shrink: 0;
}
.info-icon.gold { background: rgba(255,215,100,0.15); }
.info-icon.mood { background: rgba(160,220,160,0.15); }
.info-label { color: #9988aa; font-size: 10px; }
.info-value { color: #f0e8f5; font-weight: 500; }
```

### 버튼

```css
/* 기본 액션 버튼 */
.btn {
  background: rgba(232,160,191,0.15);
  border: 1px solid rgba(232,160,191,0.3);
  border-radius: 6px; padding: 5px 12px;
  font-size: 11px; color: #e8a0bf;
  cursor: pointer; font-family: inherit;
  transition: all 0.2s;
}
.btn:hover { background: rgba(232,160,191,0.25); }
.btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* 강조 버튼 (gradient) */
.btn-primary {
  background: linear-gradient(135deg, #e8a0bf, #c07a9a);
  border: none; color: #1a1425;
  font-weight: 700; padding: 10px 24px;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(232,160,191,0.12);
}
.btn-primary:hover:not(:disabled) {
  box-shadow: 0 4px 20px rgba(232,160,191,0.25);
  transform: translateY(-1px);
}
.btn-primary:active:not(:disabled) { transform: scale(0.97); }

/* 골드/구매 버튼 */
.btn-buy {
  background: rgba(245,215,110,0.12);
  border: 1px solid rgba(245,215,110,0.3);
  color: #f5d76e;
}

/* 퀵 버튼 행 */
.quick-btns { display: flex; gap: 4px; margin-top: 10px; }
.qbtn {
  flex: 1;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(232,160,191,0.15);
  border-radius: 6px; padding: 5px 0;
  font-size: 10px; color: #c8a0d4;
  cursor: pointer; font-family: inherit;
  text-align: center; transition: all 0.2s;
}
.qbtn:hover { background: rgba(232,160,191,0.1); color: #e8a0bf; }
.qbtn.active { background: rgba(232,160,191,0.15); border-color: #e8a0bf; color: #e8a0bf; }
```

### 탭 UI

```css
.tab-bar { display: flex; gap: 4px; margin-bottom: 12px; }
.tab-btn {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(232,160,191,0.15);
  border-radius: 6px; padding: 5px 12px;
  font-size: 11px; color: #9988aa;
  cursor: pointer; font-family: inherit;
  transition: all 0.2s;
}
.tab-btn:hover { background: rgba(232,160,191,0.1); color: #c8a0d4; }
.tab-btn.active {
  background: rgba(232,160,191,0.15);
  border-color: #e8a0bf; color: #e8a0bf;
  font-weight: 600;
}
.tab-panel { display: none; }
.tab-panel.active { display: block; }
```

### 카드 & 섹션 구분

```css
.card {
  background: linear-gradient(135deg, #2a1f3d 0%, #1e1630 100%);
  border-radius: 12px; padding: 14px;
  position: relative; overflow: hidden;
}

/* 배경 글로우 데코 (선택적) */
.card::before {
  content: '';
  position: absolute; top: -30px; right: -30px;
  width: 80px; height: 80px;
  background: radial-gradient(circle, rgba(232,160,191,0.15) 0%, transparent 70%);
  border-radius: 50%;
}

.divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(232,160,191,0.3), transparent);
  margin: 10px 0;
}

.section-title {
  font-size: 11px; color: #e8a0bf;
  font-weight: 700; letter-spacing: 1px;
  margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.section-title::after {
  content: ''; flex: 1; height: 1px;
  background: linear-gradient(90deg, rgba(232,160,191,0.3), transparent);
}
```

### 아이템 리스트 행

```css
.item-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 8px; margin-bottom: 5px;
  transition: background 0.2s;
}
.item-row:hover { background: rgba(255,255,255,0.06); }
.item-name { font-size: 12px; color: #f0e8f5; font-weight: 500; }
.item-desc { font-size: 10px; color: #9988aa; margin-top: 2px; }
.item-qty { font-size: 11px; color: #c8a0d4; min-width: 30px; text-align: center; }
```

### 색상 코딩된 로그 항목

```css
.log-entry {
  padding: 6px 8px;
  border-left: 2px solid;
  margin-bottom: 6px;
  border-radius: 0 6px 6px 0;
  background: rgba(255,255,255,0.02);
}
.log-entry.turn { border-color: #5b9cf5; }
.log-entry.adventure { border-color: #f07070; }
.log-entry.unlock { border-color: #f5d76e; }
.log-entry.seasonal { border-color: #4dcc7a; }
```

### 커스텀 스크롤바

```css
.scroll-area { max-height: 240px; overflow-y: auto; }
.scroll-area::-webkit-scrollbar { width: 4px; }
.scroll-area::-webkit-scrollbar-track { background: transparent; }
.scroll-area::-webkit-scrollbar-thumb { background: rgba(232,160,191,0.2); border-radius: 2px; }
```

### 애니메이션

```css
/* 펄스 (알림 뱃지) */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 점 깜빡임 (진행 중) */
@keyframes dotpulse {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 8px rgba(232,160,191,0.4); }
}

/* 슬라이드 인 */
@keyframes slideIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 빛남 (성공/해금 강조) */
@keyframes shine {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.shine-effect {
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: shine 2s ease-in-out;
}
```

### 반응형 고려사항

- 사이드바는 `panels.size` (기본 300px)로 제한되므로 넓은 레이아웃 불필요
- 모달은 `max-width: 480px` + `margin: 0 auto`로 중앙 정렬 권장
- 독 패널은 `dockWidth`로 크기 제어, 반응형 고려 불필요
- `flex-wrap: wrap`으로 태그/버튼 줄바꿈 처리
- 글꼴 크기: 제목 14-16px, 본문 11-13px, 보조 10px, 최소 9px
