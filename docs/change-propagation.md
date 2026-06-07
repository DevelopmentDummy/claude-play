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
| 패널 액션 스펙 (`panels/_actions.meta.json`) 포맷 변경 | `panel-spec.md` + `panel-actions-meta.ts` (직렬화) + `panel-action-registry.ts` (클라이언트 평가) |

## 세션 런타임 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 응답 형식 규칙 변경 (dialog_response, choice, scene break, 토큰 등) | `session-shared.md` |
| OOC 동작 변경 | `session-shared.md` + `session-instance.ts` |
| 이미지 생성 워크플로우 변경 | `session-shared.md` |
| MCP 도구 인터페이스 변경 | `session-shared.md` + `src/mcp/claude-play-mcp-server.mjs` + `docs/architecture.md` (MCP Tools) |
| 세션 AI 시스템 프롬프트 변경 | `session-primer.yaml` (+ `-codex` / `-gemini` 변형) |
| 새 provider 추가 (Claude/Codex/Gemini/Kimi 외) | `ai-provider.ts` (`AIProvider`, `providerFromModel`) + 신규 `*-process.ts` + `session-manager.ts` runtime configs + `session-list.ts` (resume) + `docs/architecture.md` + `docs/session-lifecycle.md` |
| fire-ai 백그라운드 세션 동작 변경 | `background-session.ts` + `/api/sessions/[id]/fire-ai` 라우트 + MCP `fire_ai` 핸들러 + `session-instance.ts`의 `runAssistantHooks()` fireAi 분기 + **AI가 직접 보는 문서**: `session-shared.md` (Background Session 절), `builder-prompt.md` (`on-assistant.js` 절), `data/skills/panel-design/references/engine-and-data.md` (on-assistant 한 줄) + `docs/architecture.md` + `docs/session-lifecycle.md` |
| 파이프라인 스케줄러 동작 변경 | `pipeline-scheduler.ts` + `bridge_scheduler_*` MCP 도구 + `docs/architecture.md` |
| 재시작 후 복구 흐름 변경 | `restart-notification.ts` + `service/restart` 라우트 + `docs/session-lifecycle.md` |
| 페르소나 lifecycle hook 추가/시그니처 변경 (`hooks/on-*.js`) | `session-instance.ts` (run*Hooks 메서드) + `docs/session-lifecycle.md` (Hooks 단계) + `docs/data-model.md` (`hooks/` 디렉토리 예시) |
| 서브에이전트 추가/변경 시 | `subagents.json`(매니페스트) + `subagents/{name}/instructions.md` 편집. 영향 범위: 세션 Open 시 spawn(`subAgents.spawnAll()`), hook/autoTrigger dispatch 경로, `bridge_delegate`/`report_to_main`/`bridge_define_subagent` MCP 도구. `.resume`은 runtime artifact — gitignore 및 미러 SKIP 목록에 포함 유지. 변경 후 세션 재open 필요 (spawn은 Open 시점에만 발생). |

## 빌더 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 페르소나 파일 스키마 변경 (새 파일 추가, 필드 변경) | `builder-prompt.md` + `docs/data-model.md` |
| 빌더 워크플로우 변경 | `builder-prompt.md` |
| 빌더 AI 시스템 프롬프트 변경 | `builder-primer.yaml` |
| voice.json 스키마 변경 | `builder-prompt.md` (음성 설정 섹션) |
| import / publish / clone 흐름 변경 | `docs/api-routes.md` (Personas) + 관련 모달 컴포넌트 |

## 서비스 인프라 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| API 엔드포인트 추가/변경 | `docs/api-routes.md` |
| 환경 변수 추가/변경 | `docs/infrastructure.md` |
| 세션 라이프사이클 변경 | `docs/session-lifecycle.md` |
| MCP 서버 인증/설정 변경 | `docs/architecture.md` (MCP Server) + `docs/infrastructure.md` |
| 프론트엔드 페이지/컴포넌트/훅 추가 | `docs/frontend.md` |
| Core Library 파일 추가/변경 | `docs/architecture.md` (Core Libraries) |
| 사용량 API 변경 (Claude/Codex/Gemini) | `usage-checker.ts` + `/api/usage` + `docs/api-routes.md` |
| 외부 LLM 게이트웨이 라우팅 변경 | `docs/external-llm-routing.md` + `codex-process.ts` 관련 흐름 |

## 스킬 전파

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| `data/skills/` 글로벌 공유 스킬 변경 | 변경 즉시 반영 안 됨 — 세션 Open 시 자동 갱신 (`refreshToolSkills()`) |
| `data/tools/{name}/skills/` 도구 스킬 변경 | 동일 — 세션 Open 시 자동 갱신 |
| `data/builder_skills/` 빌더 전용 스킬 변경 | 빌더 세션 시작 시 자동 갱신 |
| 스킬 내 `{{PORT}}` 플레이스홀더 | 세션 Open 시 현재 서버 포트로 치환됨 (`SKILL.md`, `*.sh`) |
