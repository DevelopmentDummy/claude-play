# Popup Effect System Design

## Overview

채팅 세션에서 진행상황 갱신, 성과, 이벤트 발생 등 주목할 만한 정보를 화면 중앙에 일시적으로 표시하는 연출용 이펙트 시스템. Handlebars 템플릿 기반의 리치 HTML 콘텐츠를 지원하며, 턴 단위로 유지되고 다음 메시지 전송 시 자동 클리어된다.

## Data Structure

### `variables.json`의 `__popups` 키

```json
{
  "__popups": [
    { "template": "level-up", "duration": 4000 },
    { "template": "item-acquired", "duration": 3000, "vars": { "itemName": "신비한 검" } }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `template` | string | Yes | `popups/` 디렉토리의 Handlebars 파일명 (확장자 없이) |
| `duration` | number | No | 표시 시간(ms). 기본값 4000ms |
| `vars` | object | No | 해당 팝업에만 적용할 추가 변수. 기존 variables 컨텍스트에 머지됨 |

### `popups/` 디렉토리

페르소나/세션 내 `popups/` 폴더에 Handlebars HTML 템플릿 파일 배치. 기존 `panels/` 패턴과 동일.

```
personas/{name}/
  popups/
    level-up.html
    item-acquired.html
    quest-start.html
```

- 템플릿은 Handlebars로 컴파일되며 기존 패널과 동일한 헬퍼 함수 사용 가능
- 렌더링 컨텍스트: `variables.json` 전체 + 해당 팝업의 `vars` 머지
- 페르소나 ↔ 세션 양방향 동기화 대상

## Trigger Paths

### AI 측 (MCP)

- MCP `run_tool` 결과로 `variables.json`의 `__popups` 업데이트
- 또는 `updateVariables({ __popups: [...] })` 직접 호출

### 패널 스크립트 측 (`__panelBridge`)

새 메서드 `__panelBridge.showPopup(template, opts?)` 추가:

```js
__panelBridge.showPopup("level-up", { duration: 5000, vars: { level: 10 } })
```

- 로컬 `bridge.data.__popups` 배열을 읽어 새 항목을 append한 전체 배열을 구성 → `updateVariables({ __popups: [...existing, newEntry] })` 호출
- `opts`: `{ duration?: number, vars?: object }`

### 패널 엔진 측 (`panel-engine.ts`)

- `popups/` 디렉토리를 기존 `panels/`처럼 감시 (fs.watch)
- 팝업 템플릿 캐시는 패널과 별도 관리 (`popup:` 네임스페이스 프리픽스로 캐시 키 충돌 방지)
- `variables.json` 변경 감지 → `__popups`가 있으면 각 템플릿을 Handlebars로 렌더링
- 존재하지 않는 템플릿을 참조하면 해당 항목은 무시 (skip)
- `panels:update` WebSocket 이벤트에 렌더된 팝업 배열을 포함하여 전송:

```ts
// panels:update 이벤트 페이로드
{
  panels: Panel[],
  context: Record<string, unknown>,
  sharedPlacements?: Record<string, string>,
  popups?: Array<{ template: string; html: string; duration: number }>
}
```

## Frontend Rendering

### PopupEffect 컴포넌트

- `createPortal(document.body)` — 최상위에 렌더 (모달 패턴과 동일)
- z-index: 10100+ (ModalPanel의 9998+ 위에 표시 — 팝업이 모달보다 항상 위)
- 배경 딤 (반투명 오버레이, **클릭 통과 불가** — 팝업 표시 중 입력 차단)
- 중앙 팝업 컨테이너
- Shadow DOM으로 CSS 격리 (기존 패널 패턴 동일)
- 컴포넌트 언마운트 시 타이머/애니메이션 정리 (cleanup)

### 애니메이션

- **진입**: scale 0.7 → 1.0 + fade in + 배경 딤 (~300ms)
- **퇴장**: scale 1.0 → 0.9 + fade out + 배경 딤 해제 (~300ms)

### 큐 재생

- `__popups` 배열을 순차 처리
- 현재 팝업 표시 → duration 대기 → 퇴장 애니메이션 → 다음 팝업 진입
- 한 번에 하나만 표시
- 모든 팝업 소진되면 종료

### 테마 연동

- `layout.json`의 theme 컬러를 CSS 변수로 주입 (기존 방식과 동일)
- 팝업 컨테이너에 기본 그라디언트/글로우를 theme 컬러 기반으로 적용
- 팝업 템플릿 내부에서 `--popup-primary`, `--popup-glow` 등 CSS 변수 사용 가능

### 새로고침 대응

- 페이지 로드 시 `panelData.__popups`에 데이터가 있으면 큐 재생 시작
- 턴 단위 데이터이므로 전체 큐 다시 재생

## Clear Mechanism

### 서버 측

- `ws-server.ts`의 `chat:send` 핸들러에서, AI에게 메시지를 파이프하기 전에 `SessionInstance.clearPopups()` 호출
- `clearPopups()`: `variables.json` 읽기 → `__popups: []` 패치 → 저장 → `PanelEngine.scheduleRender()` 트리거
- 기존 `<choice>` 클리어 로직과 같은 타이밍
- **OOC 메시지는 팝업을 클리어하지 않음** (유지)

### 프론트엔드 측

- 일반 메시지 전송 시 현재 재생 중인 팝업 큐를 즉시 중단 + 퇴장 애니메이션 실행

## WebSocket Event Flow

```
AI turn → variables.json __popups 업데이트
  → PanelEngine 감지 → popups/ 템플릿 Handlebars 렌더
  → panels:update 이벤트에 popups 배열 포함하여 브로드캐스트
  → 프론트엔드 PopupEffect 컴포넌트가 큐 재생 시작
  → 순차: 진입 애니메이션 → duration 대기 → 퇴장 → 다음 팝업
  → 유저 메시지 전송 시 → 서버에서 __popups 클리어 → 프론트엔드 큐 중단
```

## File Changes

### New Files
- `src/components/PopupEffect.tsx` — 팝업 렌더링 + 큐 재생 + 애니메이션 컴포넌트

### Modified Files
- `src/lib/panel-engine.ts` — `popups/` 디렉토리 감시, 템플릿 렌더링, panels:update에 popups 포함
- `src/lib/use-panel-bridge.ts` — `showPopup()` 메서드 추가
- `src/app/chat/[sessionId]/page.tsx` — PopupEffect 컴포넌트 마운트, popups 데이터 전달, 메시지 전송 시 클리어
- `src/lib/services.ts` (또는 `ws-server.ts`) — chat:send 시 `__popups` 클리어 로직
- `src/lib/session-manager.ts` — `popups/` 디렉토리를 페르소나 ↔ 세션 동기화 대상에 포함 (`syncDiff`, `syncDiffReverse`, `syncApply`, `syncApplyReverse`에 `{ key: "popups", label: "팝업 (popups/)" }` 항목 추가)

## Notes

- `popups/` 디렉토리는 `createSession` 시 `copyDirRecursive`에 의해 자동 복사됨 (SKIP_FILES에 없으므로 별도 처리 불필요)
- `SYSTEM_JSON` 세트에 `__popups` 관련 추가 제외 불필요 — `__popups`는 `variables.json` 내부 키이므로 별도 파일이 아님
