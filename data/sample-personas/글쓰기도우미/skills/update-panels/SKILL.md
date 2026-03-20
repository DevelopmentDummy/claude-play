---
name: update-panels
description: 캔버스 패널 HTML을 구조적으로 수정할 때 사용 (레이아웃, 디자인, 기능 변경)
allowed-tools: Read, Write, Edit, Glob
---

# 패널 수정

## 사전 작업
1. `/frontend-design` 스킬을 사용하여 패널을 수정하라
2. `panel-spec.md`를 먼저 읽어 기술 규칙을 확인하라

## 패널 파일 목록
- `panels/01-canvas.html`: 아티클 캔버스 (dock-right / modal 토글)
  - article.json 데이터를 렌더링 (제목, 본문, 태그, 편집 노트)
  - 텍스트 셀렉션 → AI 인터랙션 툴바 (다시쓰기/강화/축약/직접질문)
  - 인라인 이미지 렌더링 (`![alt](src)` + `$IMAGE:path$`)
  - 직접 편집 모드 (제목 클릭편집, 본문 ✏️ 토글)
  - 이미지 삽입/업로드, 내보내기(서식복사/HTML), 문서 관리
  - 글자수/어절수 카운터
- `panels/02-control.html`: 에디터 열기 버튼 (좌측 사이드바)

## 데이터 접근
- `{{article.title}}`, `{{article.body}}` 등: article.json (네임스페이스)
- `{{community}}`, `{{stage}}` 등: variables.json (루트 레벨)
- `__panelBridge.data`: 전체 컨텍스트 객체 (JS에서)
- `__panelBridge.data.__layout`: 현재 layout.json 상태 (JS에서)

## Bridge API
- `__panelBridge.sendMessage(text)`: 채팅 전송
- `__panelBridge.fillInput(text)`: 입력창 삽입
- `__panelBridge.updateVariables(patch)`: variables.json 패치
- `__panelBridge.updateData(fileName, patch)`: 커스텀 데이터 파일 패치
- `__panelBridge.updateLayout(patch)`: layout.json deep merge (실시간 반영)
- `__panelBridge.runTool(name, args)`: 서버사이드 도구 실행
- `__panelBridge.queueEvent(header)`: 다음 사용자 메시지에 이벤트 헤더 첨부
- `__panelBridge.showPopup(template, opts?)`: 팝업 이펙트 표시
- `__panelBridge.on(event, handler)`: 이벤트 구독 (turnStart, turnEnd, imageUpdated)
- `__panelBridge.isStreaming`: AI 응답 중 여부 (boolean)

## 규칙
- Shadow DOM 내 렌더링 — 외부 스타일 영향 없음
- `<style>` 태그 상단에 필수 포함
- 다크 테마 (배경 #1c1814, 텍스트 #e8e0d4, 액센트 #d4a574)
- **`shadow`가 자동 주입됨** — `shadow.querySelector()`로 요소 접근. `document.currentScript.getRootNode()` 불필요
- `autoRefresh` 제어: `layout.json`의 `panels.autoRefresh.canvas`로 자동 재렌더링 on/off 가능
