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

## 패널 종류 예시

캐릭터에 따라 적절한 패널을 1~3개 생성한다:

- **상태 패널** (`01-상태.html`): 관계 수치 게이지, 위치/시간/날씨 태그
- **프로필 패널** (`02-프로필.html`): 캐릭터 간략 정보, 현재 복장, 표정
- **인벤토리 패널** (`03-인벤토리.html`): 소지품, 아이템 목록
- **퀘스트/목표 패널**: 진행 중인 이벤트나 과제
- **관계도 패널**: 다른 NPC와의 관계
- **특수 패널**: 캐릭터 고유 (마법 주문 목록, 수사 노트 등)
