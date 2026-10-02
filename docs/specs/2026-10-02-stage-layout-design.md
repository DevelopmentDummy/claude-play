# 무대 레이아웃 (Stage Layout) — 우측 채팅 컬럼 + 중앙 탭 무대 + mount-once 패널

- 작성일: 2026-10-02
- 상태: 승인됨 (사용자 대화 승인 — 설계 1·2·3부)
- 첫 소비자: `novel_writer` 페르소나 (집필 워크벤치). 페르소나 쪽 설계는 머신 로컬 노트
  `docs/superpowers/specs/2026-10-02-novel-writer-ux-redesign.md`.
- 선행 사례: [앱 모드 설계](2026-09-12-app-mode-platform-design.md) — AppSlot의 "한 번 마운트 + 이벤트 갱신" 계약을 일반 패널로 확장한다.

## 1. 문제

세션 화면은 **채팅이 항상 가운데 컬럼**이다(`page.tsx`의 chat column은 `absolute inset-0`이고 사이드바 px만큼
`left/right` 오프셋으로 밀린다). 패널은 left/right 사이드바·modal·dock·inline으로만 들어간다.
집필 도구·대시보드형 페르소나처럼 **패널이 본체이고 대화가 보조**인 경우를 표현할 수 없다.

또한 패널 갱신 정책에 두 결함이 있다.

1. **재렌더 시 상태 유실** — 패널은 Handlebars 출력이 바뀔 때마다 `shadow.innerHTML`을 통째로 갈아끼운다.
   긴 본문 뷰어에서 스크롤 위치·작성 중인 입력이 매번 날아간다.
2. **고정된 브리지 데이터** — `PanelSlot`이 스크립트 실행 시점의 `window.__panelBridge` 객체를 Proxy로 감싸 넘긴다.
   `usePanelBridge`는 panelData가 바뀔 때마다 **새 브리지 객체**를 `window`에 꽂으므로, 스크립트가 나중에
   읽는 `__panelBridge.data`는 최초 실행 시점 값에 고정된다. Handlebars 의존이 없는 패널(재실행되지 않음)은
   `turnEnd`·새로고침 버튼으로도 새 데이터를 못 본다.

## 2. 목표 / 비목표

**목표**
- `panels.placement` 값 `"main"`을 추가한다. main 패널이 하나라도 있으면 **무대 레이아웃**이 켜진다:
  `[좌측 사이드바] [중앙 무대(main 패널 탭)] [우측 채팅 컬럼]`.
- 우측 채팅 컬럼: 폭 `chat.width`(드래그 조절·저장), 접기(레일), 좁은 폭용 압축 입력창.
- 패널 opt-in `mount: "once"` — 한 번 마운트 후 `stateChanged` 이벤트로만 갱신.
- 브리지: `data`가 항상 최신값, `focusPanel(name)`, `emit(name, detail)` 추가.
- **기존 페르소나는 동작 불변** (main이 없으면 지금 경로 그대로).

**비목표**
- 채팅 좌측 배치(`chat.position`) — 필요해지면 그때 키를 추가한다. 지금은 main의 존재가 곧 "채팅 우측"이다.
- 앱 모드와의 결합 — `layout.app`이 있으면 앱 모드가 우선이고 main은 무시된다(lint 경고).
- 템플릿 파일 변경 시 mount-once 패널 자동 재마운트 — 새로고침으로 반영한다(문서화).
- `chat.maxWidth`/`chat.align` 정리(현재 dead code) — 별건.

## 3. `layout.json` 스키마 추가

```jsonc
{
  "panels": {
    "placement": {
      "목차": "left",
      "원고": "main",        // 신규 값. 하나 이상이면 무대 레이아웃
      "트리트먼트": "main"
    },
    "leftSize": 300
  },
  "chat": {
    "width": 420              // 신규. 무대 레이아웃에서 우측 채팅 컬럼 폭(px). 기본 420
  }
}
```

- `readLayout`(`session-config-io.ts`)은 `panels`/`chat`을 spread로 병합하므로 **런타임 변경 불필요** —
  중첩 키는 보존된다(플레이북 §5.11). 회귀 테스트만 추가.
- 서버 타입(`session-manager.ts`의 `LayoutConfig`)과 클라 타입(`useLayout.ts`)에 필드 추가.

## 4. 활성 규칙 — `src/lib/stage-layout.ts` (순수 함수, 단위 테스트)

```ts
export const CHAT_WIDTH_DEFAULT = 420;
export const CHAT_WIDTH_MIN = 320;
export const STAGE_MIN_WIDTH = 480;
export const CHAT_RAIL_WIDTH = 44;

/** placement 키에서 숫자 prefix 제거 ("01-원고" → "원고") — page.tsx 정규화와 동일 규칙 */
export function normalizePanelKey(key: string): string;

/** 무대 레이아웃 판정. appModeActive면 항상 inactive. */
export function resolveStage(input: {
  panelNames: string[];                       // 패널 표시 이름, 파일 순서
  placement: Record<string, string>;          // 정규화된 placement
  appModeActive: boolean;
}): { active: boolean; mainPanelNames: string[] };   // mainPanelNames는 panelNames 순서 유지

/** 채팅 폭 범위 제한. 남는 무대 폭이 STAGE_MIN_WIDTH 이상이 되도록 상한을 잡는다. */
export function clampChatWidth(
  requested: number | undefined | null,
  viewportWidth: number,
  occupiedSides: number,                      // 표시 중인 left + right 사이드바 폭 합
): number;  // 결과 ∈ [CHAT_WIDTH_MIN, max(CHAT_WIDTH_MIN, viewportWidth - occupiedSides - STAGE_MIN_WIDTH)]
            // requested가 숫자가 아니면 CHAT_WIDTH_DEFAULT를 기준으로 clamp
```

## 5. 화면 구조

### 5.1 데스크톱 (무대 활성 · 비모바일)

`flex-1 relative min-h-0` 컨테이너 안의 absolute 영역들:

| 영역 | 위치 | 내용 |
|---|---|---|
| 좌측 사이드바 | `left:0`, `width:leftPanelSize` | 기존 그대로 (left 패널 + 프로필 이미지) |
| 우측 사이드바 | `right: chatColW`, `width:rightPanelSize` | 기존 right 패널 — 채팅 컬럼 바로 왼쪽 |
| 무대 | `left: L`, `right: chatColW + R` | `<MainStage>` |
| 채팅 컬럼 | `right:0`, `width: chatColW` | `<ChatColumn>` 안에 기존 채팅 컬럼(메시지·dock-bottom·입력창) |

- `chatColW` = 접힘이면 `CHAT_RAIL_WIDTH`, 아니면 `clampChatWidth(resizeOverride ?? layout.chat.width, innerWidth, L+R)`.
- 기존 `chatColumn` JSX를 재사용한다. 무대 모드에서는 내부 div에 `sidebarOffsetStyle`을 주지 않는다
  (채팅 컬럼 박스가 이미 위치를 갖는다).
- **dock-left / dock-right 패널은 모달로 승격**한다(모바일과 동일 규칙: `effectiveModalPanels`에 합류,
  `activeDockLeft/Right`는 빈 배열). 좁은 컬럼 안 플로팅 독은 말풍선 폭을 ~90px로 짓눌러 쓸 수 없다.
- dock-bottom·inline 패널·선택지는 채팅 컬럼 안에서 그대로 동작한다.
- 윈도 리사이즈 시 `chatColW`는 재계산된다(저장값은 그대로, 표시값만 clamp).

### 5.2 `ChatColumn` (신규 `src/components/ChatColumn.tsx`)

- 폭 박스 + `PanelResizeHandle side="right"`(직계 자식이어야 함 — 핸들이 `parentElement.offsetWidth`를 잰다).
  `minSize=CHAT_WIDTH_MIN`, `maxSize`=clamp 상한. 드래그 중 로컬 override, 종료 시
  `PATCH /api/sessions/:id/layout { chat: { width } }`. 서버 watch → `layout:update` 브로드캐스트 → override 해제
  (기존 사이드바 리사이즈와 같은 왕복).
- **접기**: 컬럼 왼쪽 가장자리의 토글 버튼. 접힘 상태는 `localStorage["stageChatCollapsed:" + sessionId]`.
  접히면 `CHAT_RAIL_WIDTH` 레일만 남고(펼치기 버튼 + 스트리밍 중 펄스 점), **채팅 내용은 마운트를 유지한 채
  숨긴다**(입력 중 텍스트·스크롤 보존).
- 접기 버튼은 `aria-label`/`title`을 갖는다.

### 5.3 `MainStage` (신규 `src/components/MainStage.tsx`)

- props: `panels`(main 패널, 파일 순서), `sessionId`, `panelData`, `onSendMessage`, `activeName`, `onActiveChange`.
- main 패널 1개 → 탭 바 없이 꽉 채움. 2개 이상 → 상단 탭 바(`role="tablist"`, `aria-selected`, accent 밑줄).
- 각 패널은 `PanelSlot variant="bare"`로 렌더. **비활성 탭도 마운트 유지**하고 `display:none`으로 숨긴다
  (shadow DOM·스크롤·입력 보존).
- 활성 탭은 `localStorage["stageTab:" + sessionId]`에 기억. 저장값이 목록에 없으면 첫 탭.
- 탭 바 높이는 작게(≈36px), 테마 토큰(`--surface`, `--border`, `--accent`, `--text-dim`) 사용.

### 5.4 모바일 (`useIsMobile`: <768px)

- 무대가 활성이면 StatusBar에 `원고 | 채팅` 세그먼트 토글을 띄운다(라벨: 첫 번째 탭 이름 대신 고정 "무대"/"채팅" —
  패널 이름은 페르소나마다 달라서 고정 라벨이 안전). 상태 `mobileView: "stage" | "chat"`, 기본 `"stage"`.
- 두 뷰 모두 **마운트 유지**, 비활성 뷰는 숨김.
- left/right 패널은 기존처럼 ☰ 서랍(`PanelDrawer`). dock-* 패널은 기존처럼 모달 승격.
- `focusPanel`로 main 탭을 부르면 `mobileView="stage"`, 패널의 `fillInput`(입력창 채우기) 이벤트가 오면
  `mobileView="chat"`으로 전환해 사용자가 입력창을 보게 한다.
- 채팅 폭·접기는 모바일에서 적용하지 않는다.

### 5.5 겹침 요소

- 무대 데스크톱 모드에서 페이지가 `document.documentElement`에 `--stage-right-inset: {chatColW}px`를 설정하고
  모드가 아니면 제거한다(언마운트 시에도 제거).
- `ToastEffect`(`right:24`)·`MinimizedModals`(`right:16`)는 `right: calc(var(--stage-right-inset, 0px) + Npx)`로
  바꿔 입력창을 가리지 않게 무대 우하단에 뜬다. 변수가 없으면 기존과 같다.

## 6. 패널 갱신 — `mount: "once"`

### 6.1 선언

```html
<panel-meta>{"mount": "once"}</panel-meta>
```

`parsePanelMeta`(`panel-action-registry.ts`)의 `PanelMeta`에 `mount?: "once"`를 추가한다. 다른 값은 무시.

### 6.2 동작 (PanelSlot)

- 최초 html로 shadow를 채우고 스크립트를 **한 번** 실행한다(지금과 같음).
- 이후 html prop이 바뀌어도 mount-once 패널은 `innerHTML`을 갈아끼우지 않고 스크립트도 재실행하지 않는다.
  sandbox(타이머·리스너·브리지 구독)도 해제하지 않는다 — 언마운트 시에만 해제.
- 상태 갱신은 이벤트로만: 페이지가 panelData가 바뀔 때마다(비앱 모드) `dispatchBridgeEvent("stateChanged", panelData)`를
  **한 번** 발송한다(패널별 중복 발송 금지 — 전역 이벤트이므로). 앱 모드에서는 지금처럼 AppSlot만 발송한다.
- **계약**: 스크립트는 실행 시점에 `__panelBridge.data`로 초기 렌더를 하고, 이후 `__panelBridge.on("stateChanged", d => …)`로
  갱신한다. panelData는 최대 ~5Hz로 바뀌므로 패널은 관심 있는 조각만 비교해 바뀌었을 때만 DOM을 고친다.
- 템플릿 파일을 고쳐도 새로고침 전까지 반영되지 않는다.
- mount-once는 배치와 무관하다(left·right·main·modal·dock 어디서든). ModalPanel/DockPanel 등이 PanelSlot과
  별개의 스크립트 실행기를 가지고 있다면 같은 규칙을 적용한다.

### 6.3 브리지 데이터 최신화 (모든 패널에 적용되는 버그 수정)

PanelSlot의 sandboxed bridge Proxy가 **조회 시점의** `window.__panelBridge`를 대상으로 하게 바꾼다:

```ts
get(target, prop) {
  const live = (window.__panelBridge as Record<string, unknown> | undefined) ?? target;
  if (prop === "on") { /* live.on 을 감싸 unsubscribe 기록 — 기존과 동일 */ }
  return Reflect.get(live, prop);
}
```

같은 수정을 별도 실행기(ModalPanel/DockPanel 등)에도 적용한다. 기존 패널에서 `__panelBridge.data`를 나중에 읽는
코드는 이제 최신값을 본다 — 순수한 버그 수정이다.

## 7. 브리지 API 추가 (`use-panel-bridge.ts`)

| API | 동작 |
|---|---|
| `focusPanel(name)` | `window`에 `__bridge_focus_panel` CustomEvent(`{ name }`) 발송. 페이지가 처리: 정규화한 이름이 main 패널이면 그 탭 활성화(+모바일이면 무대 뷰), placement가 `modal`/`modal-dismissible`/`full-screen`이면 dismissible 모달 열기, 그 외 무시. |
| `emit(name, detail?)` | `__bridge_evt:panel:{name}` CustomEvent 발송. 받는 쪽은 `on("panel:" + name, fn)`. 시스템 이벤트(`turnEnd` 등)와 네임스페이스로 분리돼 사칭 불가. `name`이 빈 문자열이면 무시. |

## 8. 선택지 액션의 placement 조회 버그 수정 (`ChatInput.tsx`)

선택지 액션 실행부가 `registry.getLayout()?.placement?.[act.panel]`을 읽는다. `__layout`은 layout.json 원본이라
placement는 `panels.placement`에 있다 → 항상 undefined → 사이드바·main 패널에도 `/modals open`이 나간다.

- `panels.placement`를 먼저 읽고(숫자 prefix 정규화 포함), 없으면 구형 최상위 `placement`로 폴백.
- placement가 `left`/`right`/`main`/`dock`/`dock-*`이면 모달 열기를 보내지 않는다. `main`이면 `focusPanel` 경로로 탭 전환.

## 9. 압축 입력창 (`ChatInput` `compact` prop)

무대 모드 채팅 컬럼에서 `compact`를 켠다. 320px 폭에서도 textarea가 쓸 만해야 한다.

- 메인 행: `[textarea][전송/중지]` — 전송·중지는 아이콘 버튼(`aria-label`/`title` 유지).
- 그 외 보조 버튼(이미지·STT·오토플레이 등)과 하단 바(사용량·턴 중 개입·오토 메시지)는 두 번째 행으로 내리고
  줄바꿈 허용. **기능은 하나도 숨기지 않는다** — 위치만 옮긴다.
- `compact`가 아니면 지금과 픽셀 단위로 동일.

## 10. 검사 (`scripts/lint-data.mjs`)

- `VALID_PLACEMENTS`에 `"main"` 추가(헤더 주석 포함).
- `chat.width`가 있으면 양의 숫자인지 경고.
- `layout.app`과 main 배치가 동시에 있으면 "앱 모드가 우선, main 무시" 경고.

## 11. 하위 호환

- main 패널이 없는 세션: 레이아웃·렌더 경로 불변. 바뀌는 것은 (a) §6.3 브리지 최신화(버그 수정),
  (b) 비앱 세션에서도 `stateChanged`가 발송됨(기존 일반 패널 중 구독자가 없으면 무영향),
  (c) §8 선택지 액션이 비모달 패널에 모달 열기를 보내지 않음(버그 수정), (d) Toast/MinimizedModals의 `right`가
  CSS 변수 fallback으로 계산(값 동일).
- 앱 모드 세션: AppSlot 경로 불변. main은 무시.

## 12. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/lib/stage-layout.ts` (신규) + `stage-layout.test.ts` | §4 순수 함수 + 테스트 |
| `src/components/MainStage.tsx` (신규) | §5.3 |
| `src/components/ChatColumn.tsx` (신규) | §5.2 |
| `src/app/chat/[sessionId]/page.tsx` | placement 버킷 `main`, 무대 분기 JSX, focusPanel 처리, stateChanged 발송, `--stage-right-inset`, 모바일 뷰 토글 |
| `src/components/PanelSlot.tsx` | `variant`, mount-once, 브리지 Proxy 최신화 |
| `src/components/ModalPanel.tsx`/`DockPanel.tsx` (해당 시) | 별도 실행기면 §6.2·§6.3 동일 적용 |
| `src/lib/use-panel-bridge.ts` | `focusPanel`, `emit` |
| `src/lib/panel-action-registry.ts` | `PanelMeta.mount` |
| `src/components/ChatInput.tsx` | §8 placement 수정, §9 `compact` |
| `src/components/StatusBar.tsx` | 모바일 무대/채팅 세그먼트 |
| `src/components/ToastEffect.tsx`, `MinimizedModals.tsx` | §5.5 |
| `src/hooks/useLayout.ts`, `src/lib/session-manager.ts` | 타입 |
| `src/lib/session-config-io.test.ts` | `chat.width`·`placement.main` 보존 회귀 |
| `scripts/lint-data.mjs` | §10 |
| `panel-spec.md`, `builder-prompt.md`, `app-spec.md`, `session-shared.md`(해당 시) | 페르소나 저자용 문서 |
| `data/skills/panel-design/SKILL.md` (+references) | 배치 체크리스트·결정표에 main/무대/mount-once (라이브 데이터, git 밖) |
| `docs/frontend.md`, `docs/codebase-map.md`, `docs/change-propagation.md`, `docs/data-model.md`, `docs/architecture.md` | 개발 문서 (`check:docs`가 신규 컴포넌트·lib 행을 강제) |

## 13. 검증

- 단계마다 `npm run typecheck`. `npx tsx --test src/lib/stage-layout.test.ts src/lib/session-config-io.test.ts`.
- `npm run check:docs`, `npm run check:static`, `npm run lint:data`.
- 운영 서버가 메인 작업트리의 `.next/`를 서빙 중이므로 **빌드는 feature worktree에서만** 한다.
- worktree에서 격리 테스트 서버(`DATA_DIR`·`PORT` 분리)를 띄워 Playwright(시스템 Chrome)로 확인:
  무대 레이아웃 렌더·탭 전환 상태 보존·채팅 리사이즈/접기·모바일 뷰 토글, 그리고 **기존 페르소나 한 개의 회귀**.

## 14. 구현 중 확정된 보완 (적대적 리뷰 반영)

- **사이드바 표시 폭 맞춤** — `fitStageSides()`: 좁은 창에서 무대가 `STAGE_MIN_WIDTH` 아래로 짓눌리면 좌·우 사이드바의
  표시 폭을 같은 비율로 줄인다(각 `SIDEBAR_FIT_MIN`=200까지, 저장값 불변). 그래도 모자라면 채팅 컬럼을 침범하지 않는 선까지.
  채팅 폭 clamp(§4)가 먼저 `CHAT_WIDTH_MIN`까지 양보하고, 그다음 사이드바가 줄어든다. 무대 데스크톱에서만 적용.
- **리사이즈 핸들** — 포인터가 실제로 움직였을 때만 `onResizeEnd`(저장)를 부른다(클릭만으로 clamp된 표시 폭이 저장값을
  덮어쓰지 않게). 채팅 컬럼은 `placement="inside"`로 스트립을 컬럼 안쪽 가장자리에 둔다(무대 스크롤바를 가리지 않게).
- **모달 `sendMessage` 래핑 격리** — ModalPanel은 최상단 모달의 `sendMessage`를 공유 브리지 객체에서 "보내고 닫기"로 감싼다.
  라이브 프록시가 그 객체를 따르므로, 비모달 실행기(PanelSlot·DockPanel·InlinePanel)는 `createLiveBridgeProxy(onSub, { rawSend: true })`로
  감싸기 전 원본(`RAW_SEND_KEY`, 열거 불가 속성)을 쓴다 — 사이드바·무대 패널의 전송이 위에 뜬 필수 모달을 닫지 않는다.
- **구독 해제** — 모든 실행기가 `onSubscribe`로 `on()` 해제 함수를 모아 DOM 교체 전·언마운트 때 `releaseBridgeSubs()`로 푼다
  (독은 탭들이 shadow 하나를 공유하므로 탭 전환마다). StrictMode 모의 언마운트 뒤 다시 그리도록 정리 단계에서 표식을 되돌린다.
- **프록시 재귀 방지** — 프록시는 `usePanelBridge`가 꽂은 실제 객체(`lastRealBridge`)를 우선 따르고, 트랩 재진입 깊이 가드로
  프록시를 프로토타입·대상으로 둔 래퍼가 `window.__panelBridge`에 꽂혀도 재귀하지 않는다.
- **모바일 토글 활성 표시** — Tailwind 투명도 수식어는 CSS 변수 색에 적용되지 않으므로 활성 버튼은 단색(`bg-accent text-bg`).
