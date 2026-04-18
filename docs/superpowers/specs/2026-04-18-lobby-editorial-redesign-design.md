# Lobby Editorial Redesign

**Date**: 2026-04-18
**Scope**: Main landing page (`src/app/page.tsx` and components it renders)
**Direction**: Premium / Editorial, dark mode

## 1. Goal

메인 랜딩(로비)의 시각적 밀도와 고급감을 올린다. 현재 구조(좌측 세션 사이드바 + 중앙 페르소나 그리드)는 유지하되 타이포그래피, 색, 카드 재질감, 세션 행 인지성을 에디토리얼 수준으로 끌어올린다.

Out of scope: 채팅 화면(`/chat/[sessionId]`), 빌더(`/builder/[name]`), 라이트 모드.

## 2. Design Tokens

에디토리얼 방향을 고정하기 위해 신규 토큰을 도입한다. `src/app/globals.css`의 CSS 변수와 `tailwind.config.ts`에 추가.

### 2.1 색상

```
--lobby-bg:        #0a0a0e   (기존 배경보다 더 중성 다크)
--lobby-surface:   #0c0c10   (사이드바 배경)
--lobby-card:      #0f0f14   (페르소나 카드 배경)
--lobby-border:    rgba(255,255,255,0.05)
--lobby-border-hover: rgba(184,125,184,0.25)

--plum:            #b87db8   (액센트)
--plum-soft:       rgba(184,125,184,0.08)
--plum-hairline:   rgba(184,125,184,0.3)

--text:            #fafafa
--text-dim:        rgba(250,250,250,0.55)
--text-mute:       rgba(250,250,250,0.4)
```

기존 `--accent`는 호환을 위해 유지하되 로비 스코프에서는 plum으로 상속.

### 2.2 타이포그래피

- **본문/UI**: `Inter` (기존 유지, weights 200/300/400/500)
- **세리프 포인트**: `Playfair Display` italic, weights 400/500
  - Google Fonts로 로딩. `next/font/google`에 추가.
  - 용도: 넘버링(`No. 01`), brand의 `Play`, hero의 `?`, 사이드바 `Sessions` 라벨, 이니셜 폴백.

타입 스케일:
- Hero h1: Inter 200, 38px desktop / 30px mobile, letter-spacing -0.035em, line-height 1.1
- Section label: Inter 500, 10px, letter-spacing 0.3em, uppercase
- Card name: Inter 500, 15px, letter-spacing -0.01em
- Meta: Inter 400, 10-11px, color `--text-mute`
- Italic serif accent: Playfair Display italic 400

## 3. Layout

구조는 유지. 좌측 고정 사이드바(280px) + 우측 메인. 모바일은 기존 드로어 패턴 유지.

## 4. Components

### 4.1 Header (`src/app/page.tsx` 내부)

- Brand: `Claude` (Inter 500) + `Play` (Playfair italic 400, plum)
- 1px 수직 구분자
- Breadcrumb: `LOBBY` (Inter 400, 11px, letter-spacing 0.2em, `--text-mute`)
- 우측: 프로필 칩 그룹
- 배경: `rgba(10,10,14,0.5)` + `backdrop-filter: blur(12px)`, 하단 1px border

### 4.2 Profile chips

- `px-3 py-1.5 rounded-full`, border 1px `--lobby-border`
- Primary 프로필: border plum-hairline, 좌측에 4-5px plum dot
- `+` 버튼: 26×26, dashed border

### 4.3 Hero (페르소나 그리드 상단)

```
[eyebrow]       Tonight's Cast
[h1]            Who would you like to meet?
                                 └─ 세리프 이탤릭 플럼
[subtitle]      Choose a persona to start a new session
[divider]       ─── (40px wide, plum-hairline)
```

- eyebrow: 10px, plum, letter-spacing 0.35em, uppercase
- h1: 경량 산세리프, 마지막 `?`만 Playfair italic plum으로 분리 렌더
- divider: 40×1px, plum 40% opacity, 중앙 정렬

### 4.4 Persona Card (`src/components/PersonaCard.tsx`)

구조 변경: 상단 비주얼 영역 + 하단 본문.

```
┌──────────────────────────┐
│ No. 01    ● (live dot)   │  ← 비주얼 영역 (140px)
│                          │     배경: 그라디언트 (hasIcon이면 icon)
│                          │
│ [↓ 외부]                 │  ← 배지 영역 (좌하단, import/publish)
├──────────────────────────┤
│ Aria                     │  ← 본문 영역 (padding 14px)
│ 3 sessions               │
│                          │
│ "조용한 밤의 도서관…"      │  ← 이탤릭 태그라인
└──────────────────────────┘
```

세부:

- **카드 컨테이너**: `bg-[--lobby-card]`, `rounded-xl`, border 1px `--lobby-border`. Hover: border `--lobby-border-hover`, `translateY(-2px)`.
- **비주얼 영역**: 140px 높이. `hasIcon`이면 `<img>` 풀블리드 `object-cover`. 없으면 accent 인덱스 기반 그라디언트 폴백 + 중앙에 Playfair italic 이니셜(28px, rgba(255,255,255,0.85)).
- **넘버링**: 좌상단 `No. {index+1}` (Playfair italic, 10px, plum 75%). 2자리 패딩: `No. 01`, `No. 12`.
- **Live dot**: 우상단 6×6 plum dot, `box-shadow: 0 0 10px plum`. 세션이 1개 이상일 때만 표시.
- **Source 배지**: 비주얼 영역 좌하단. `↓ 외부` (import) / `↑ 업로드됨` (publish). 9px, 2px 4px padding, 0.04 rounded.
- **본문**: `padding: 14px`. 이름(15px, Inter 500) → 메타(`{n} sessions`, 10px, text-mute) → 태그라인(10px, italic, text-dim, 2줄 max).
- **태그라인 소스**: 페르소나 설명의 첫 문장(~40자). `data/personas/{name}/persona.md`에서 first paragraph의 첫 문장 추출. 없으면 숨김.

**호버 시 카드 액션**:

- 우상단 케밥 버튼 ⋯ (28×28, `bg-black/35 backdrop-blur`, border 1px `white/8`). `opacity-0 group-hover:opacity-100 md:focus-within:opacity-100`. 모바일은 항상 표시.
- 클릭 시 드롭다운 (Headless UI Menu 또는 자체 구현):
  - `✎ Edit`
  - `⎘ Clone`
  - `↻ Check update` (importMeta 있을 때만)
  - `↑ Publish` (publishMeta 없을 때)
  - — 구분선 —
  - `× Delete` (1-click 확인: 첫 클릭은 `Delete ({n} sessions)` 확인 상태로 변경, 3초 내 재클릭 시 삭제)
- 드롭다운: `bg-[#14141a]`, border 1px `white/8`, `rounded-lg`, `shadow-xl`, 140px min-width.

**업데이트 알림**: `update-available` 상태일 때 케밥 옆에 작은 dot 배지(4×4, `--accent` orange).

### 4.5 "New Persona" / "Import from GitHub" 카드

기존 2개 추가 카드(새 페르소나, GitHub 가져오기) 유지. 스타일을 통일:

- 동일한 비율(실제 페르소나 카드 높이와 맞춤)
- 1px dashed border `rgba(255,255,255,0.1)`
- 중앙 36×36 plum-soft 배경 버튼 + 심볼(`+` / `↓`)
- 아래 라벨 (Inter 400, 11px, text-dim)

### 4.6 Grid

```css
grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
gap: 18px;
max-width: 1000px;  /* 중앙 정렬 */
```

- 최소 카드 폭 200px, 좁은 화면은 자연스럽게 1-2열로 랩
- 컨테이너 좌우 패딩: 모바일 24px, 데스크탑 48px

### 4.7 Sessions Sidebar

헤더:
```
Sessions                 12
──────────  ──────── 이탤릭 플럼     카운트 (11px, uppercase, text-mute)
```

- 배경 `--lobby-surface`, 우측 1px border
- 라벨: Playfair italic 14px plum

세션 행(`src/components/SessionCard.tsx` 개편):

```
┌──┐  타이틀(ellipsis)            01
│IC│  페르소나명 · 2h ago
└──┘
```

- 좌측 34×34 페르소나 아이콘: `hasIcon`이면 `<img>`, 없으면 인덱스 기반 그라디언트 + Playfair italic 이니셜(14px).
- 본문: 제목 13px Inter 500 ellipsis, 메타(페르소나명 + `·` + 상대시간) 10px text-mute.
- 우상단: `01`, `02` Playfair italic 9px plum 50%.
- Active(현재 열린 세션 페이지가 있을 경우 — 향후 확장 — 현재는 전부 inactive): 배경 plum-soft, 좌측 2px plum 세로 바.
- Hover: 배경 plum 5% opacity.
- 삭제 버튼: 호버 시 우측(`01` 넘버 위치 대체)에 × 아이콘 표시. 기존 1-click 확인 로직 유지.

아이콘 폴백 그라디언트(페르소나별 고정): index mod 6 — plum/amber/teal/emerald/azure/violet 패밀리(기존 PERSONA_ACCENTS 유지하되 채도 낮춤).

### 4.8 Modals 및 파생 컴포넌트

다음 모달은 **토큰만 업데이트**하고 구조는 유지:
- `NewPersonaDialog`, `NewProfileDialog`, `PersonaStartModal`, `ImportPersonaModal`, `PublishPersonaModal`, `ClonePersonaDialog`, `ProfileCard`

업데이트 내용:
- 내부 accent 참조를 `--plum`으로
- 본체 배경을 `--lobby-card`로
- 타이틀에 Playfair italic을 포인트로 적용할지는 케이스별 — 우선은 `PersonaStartModal`만 적용하고 나머지는 기존 스타일 유지

## 5. Behavior & Edge Cases

- **No personas**: 빈 그리드 대신 중앙에 "Create your first persona" CTA 카드 1개 + 서브텍스트. (현재 동작과 동일한 구조, 톤만 조정)
- **No sessions**: 사이드바 "No sessions yet" 문구를 Playfair italic 중앙 정렬로.
- **Long persona names / session titles**: 이름은 1줄 ellipsis, 태그라인은 2줄 line-clamp.
- **Kebab dropdown on edge**: 우측 화면 끝에 가까운 카드는 드롭다운이 왼쪽으로 열리도록 boundary 체크.
- **Mobile**: 현재 sidebar drawer 패턴, backdrop blur 유지. 카드의 케밥 버튼은 항상 표시(호버 없음).

## 6. Files to Modify

| File | Change |
|------|--------|
| `src/app/globals.css` | `--plum*`, `--lobby-*` 토큰 추가, Playfair Display import |
| `tailwind.config.ts` | lobby 스코프 색상 확장 |
| `src/app/layout.tsx` | Playfair Display `next/font/google` 로딩 |
| `src/app/page.tsx` | Header / Hero / Sidebar 구조 개편, import/render 경로 동일 |
| `src/components/PersonaCard.tsx` | 상·하단 분리 구조 + 케밥 드롭다운 + 태그라인 렌더 |
| `src/components/SessionCard.tsx` | 아이콘 슬롯 + 넘버링 + 메타 포맷 변경 |
| `src/components/ProfileCard.tsx` | 칩 스타일 통일(primary dot) |
| `src/lib/persona.ts` 또는 API 응답 | 태그라인 추출 유틸 추가 (first sentence of persona.md) |

신규 파일:
- `src/components/KebabMenu.tsx` — 카드 액션 드롭다운 (재사용)

## 7. Testing

- Visual regression: 각 브레이크포인트(375, 768, 1024, 1440)에서 수동 확인
- 세션 0개 / 페르소나 0개 / import/publish 혼합 상태 렌더 확인
- 키보드 내비게이션(Tab으로 케밥 포커스, Enter로 드롭다운 열기, Esc로 닫기)
- 카드 액션: Edit/Clone/Delete 모두 기존 콜백 연결 유지(회귀 없음)

## 8. Non-Goals / Future

- 라이트 모드 — 별도 spec
- 페르소나 카드에 실제 썸네일 이미지(AI 생성) 자동 부여 — 별도 spec
- Hero 영역에 featured persona 큰 카드 — 별도 spec (레이아웃 B/C 방향으로 확장 시)
