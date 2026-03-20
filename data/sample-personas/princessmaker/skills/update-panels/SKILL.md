---
name: update-panels
description: 패널 HTML 구조를 수정해야 할 때 호출. 새 정보 표시, 레이아웃 변경, 버그 수정 등. 일반적인 데이터 갱신은 자동이므로 구조적 변경이 필요할 때만 사용.
allowed-tools: Read, Write, Edit, Glob
---

# 패널 수정

## 사전 준비

1. **반드시 `./panel-spec.md`를 먼저 읽어라** — Handlebars 헬퍼, CSS 가이드, 인터랙티브 패턴이 정리되어 있다
2. **/frontend-design 스킬을 사용하여 패널을 수정하라** — 프로덕션 수준의 UI 품질을 유지한다

## 이 페르소나의 패널 목록

| 파일 | 배치 | 역할 |
|------|------|------|
| `panels/01-profile.html` | right | 이름, 나이, 날짜, 소지금, HP, 스트레스, 기분, 위치, 복장 |
| `panels/02-stats.html` | right | 12개 능력치 게이지 (기본7 + 기능5) + 전투 스탯 |
| `panels/03-schedule.html` | dock | 스케줄 3슬롯 선택 + 턴 진행 버튼 + 모달 열기 버튼 |
| `panels/04-catalog.html` | modal | 활동 카탈로그 (카테고리별 탭, 해금/잠금 상태, 요구조건, 효과) |
| `panels/05-inventory.html` | modal | 소지품/장비/의상/상점 (4탭 구조) |
| `panels/06-log.html` | right | 이벤트 로그 (최근 30건) |

## 수정 규칙

- Shadow DOM 안에서 렌더링 — 외부 CSS 접근 불가
- 테마 색상: bg `#1a1425`, surface `#2a1f3d`, accent `#e8a0bf`, text `#f0e8f5`, textDim `#9988aa`
- font: Noto Sans KR
- `<style>` 태그를 패널 상단에 반드시 포함
- variables.json 값은 `{{변수명}}`으로 자동 주입
- 커스텀 데이터는 `{{파일명.키}}`로 접근 (예: `{{inventory.items}}`)
- 스크립트에서 Shadow Root 접근: `document.currentScript.getRootNode()`
- `__panelBridge` API로 상태 갱신, 엔진 호출, 메시지 전송

## 주의

- 엔진의 반환 구조를 반드시 확인한 후 필드를 참조하라
- 패널은 variables 변경 시 전체 재렌더링 — DOM 상태 초기화됨
- 영속 상태는 JSON 파일에 저장
