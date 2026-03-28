# Change Propagation Rules

코드 변경 시 아래 체크리스트를 따라 관련 문서를 함께 업데이트해야 한다.

## 패널 시스템 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 패널 렌더링 동작 변경 (Shadow DOM, 클릭 핸들러, CSS 격리 등) | `panel-spec.md` |
| panelBridge 메서드 추가/변경 | `panel-spec.md` |
| Handlebars 헬퍼 추가/변경 | `panel-spec.md` |
| layout.json 스키마 변경 (placement, theme, 새 필드) | `panel-spec.md` |
| 패널 관련 WebSocket 이벤트 변경 | `panel-spec.md` |
| 패널 관련 API 엔드포인트 변경 | `panel-spec.md` + `docs/api-routes.md` |

## 세션 런타임 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 응답 형식 규칙 변경 (dialog_response, choice, 토큰 등) | `session-shared.md` |
| OOC 동작 변경 | `session-shared.md` |
| 이미지 생성 워크플로우 변경 | `session-shared.md` |
| MCP 도구 인터페이스 변경 | `session-shared.md` + `src/mcp/claude-play-mcp-server.mjs` |
| 세션 AI 시스템 프롬프트 변경 | `session-primer.yaml` (+ `-codex` / `-gemini` 변형) |

## 빌더 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 페르소나 파일 스키마 변경 (새 파일 추가, 필드 변경) | `builder-prompt.md` |
| 빌더 워크플로우 변경 | `builder-prompt.md` |
| 빌더 AI 시스템 프롬프트 변경 | `builder-primer.yaml` |
| voice.json 스키마 변경 | `builder-prompt.md` (음성 설정 섹션) |

## 서비스 인프라 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| API 엔드포인트 추가/변경 | `docs/api-routes.md` |
| 환경 변수 추가/변경 | `docs/infrastructure.md` |
| 세션 라이프사이클 변경 | `docs/session-lifecycle.md` |
| MCP 서버 인증/설정 변경 | `docs/architecture.md` (MCP Server) + `docs/infrastructure.md` |
| 프론트엔드 페이지/컴포넌트 추가 | `docs/frontend.md` |
| Core Library 파일 추가/변경 | `docs/architecture.md` (Core Libraries) |

## 스킬 전파

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| `data/tools/{name}/skills/` 글로벌 스킬 변경 | 변경 즉시 반영 안 됨 — 세션 Open 시 자동 갱신 (`refreshToolSkills()`) |
| 스킬 내 `{{PORT}}` 플레이스홀더 | 세션 Open 시 현재 서버 포트로 치환됨 |
