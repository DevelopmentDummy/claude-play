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
| 공유 도구 패널 (`data/tools/{tool}/panels/*.html`) 추가/이동 | ⚠️ `panel-engine.ts` `getSharedPanelFiles()`가 **모든** 페르소나 세션에 자동 mount — 페르소나 전용 패널(특히 panel-actions 있는 것)은 절대 `data/tools/`에 두지 말 것(모든 세션에 액션이 등록돼 `[AVAILABLE]` 헤더가 유저 메시지를 묻음). `data/tools/`에는 진짜 공유·액션 없는 패널만. 잘못 등록분은 `data/tools/{tool}/panels.removed/`로 soft delete. tools 디렉토리는 watch 대상이 아님 — 파일 이동 후 세션 재open 또는 서버 재시작 필요 |

## 세션 런타임 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 응답 형식 규칙 변경 (dialog_response, choice, scene break, 토큰 등) | `session-shared.md` |
| OOC 동작 변경 | `session-shared.md` + `session-instance.ts` + `ws-server.ts` (OOC 프리픽스 감지·`isOOC`·힌트 주입) + `/api/chat/send` 라우트. 서브에이전트 운영자 사이드채널은 별도 `[OPERATOR]` 규약 (`subagent-instance.ts`) |
| 이미지 생성 워크플로우 변경 | `session-shared.md` + AI가 읽는 스킬 (`data/tools/*/skills/generate-image*`) + MCP 도구 desc (`generate_image*` — `claude-play-mcp-server.mjs`; legacy `generate_image`는 disabled) + 백엔드 lib (`comfyui-client.ts` / `codex-image.ts` / `openai-image.ts` / `gemini-image.ts`) + `OPENAI_IMAGE_BACKEND` env 문서 (`docs/infrastructure.md`) |
| 이미지 백엔드 게이팅 (기본=ComfyUI, Gemini/OpenAI는 명시 요청 시에만) | **4곳 동시 유지**: SKILL.md 2개 (`generate-image-gemini`, `generate-image-openai` — desc+본문) + MCP 도구 desc 2개 (`generate_image_gemini`, `generate_image_openai` in `claude-play-mcp-server.mjs`) |
| MCP 도구 추가/인터페이스 변경 | `session-shared.md` + `src/mcp/claude-play-mcp-server.mjs` + `docs/architecture.md` (MCP Tools 표에 행 추가). MCP 서버는 세션 Open 시 spawn되는 per-session child — 변경 반영에 **세션 재open 필요** |
| 세션 AI 시스템 프롬프트 변경 | `session-primer.yaml` (+ `-codex` 변형 = Codex·Kimi 공용, `-gemini` 변형 = Antigravity 공용 — Gemini CLI 은퇴 후에도 live). 분기는 `prompt-assembly.ts` `buildServiceSystemPrompt` |
| 새 provider 추가 (Claude/Codex/Gemini/Kimi/Antigravity 외) | `ai-provider.ts` (`AIProvider`, `providerFromModel`, `MODEL_GROUPS`) + 신규 `*-process.ts` + `ai-process-factory.ts` (`createProcess` 분기 + `AIProcess` union — **누락 시 신규 provider가 조용히 Claude로 spawn됨**) + `prompt-assembly.ts` (`buildServiceSystemPrompt` primer 분기) + `runtime-config.ts` (per-provider MCP/설정 writer) + `runtime-instructions.ts` (instruction 파일 writer) + `session-list.ts` (resume) + `docs/architecture.md` + `docs/session-lifecycle.md` |
| provider 은퇴/비활성 또는 모델 선택기 변경 | `ai-provider.ts` (`providerFromModel` 라우팅 + `MODEL_GROUPS`) + `.env.example` + `docs/infrastructure.md`. 예: Gemini CLI 은퇴 — `NEXT_PUBLIC_DISABLE_GEMINI=true`면 gemini-* 모델을 Antigravity로 투명 라우팅 |
| fire-ai 백그라운드 세션 동작 변경 | `background-session.ts` (`spawnBackgroundAI` — provider는 model에서 도출해 `createProcess`로 5종 전부 실행, provider 라우팅 변경이 fire_ai에도 영향) + `/api/sessions/[id]/fire-ai` 라우트 + MCP `fire_ai` 핸들러 + `session-instance.ts`의 `runAssistantHooks()` fireAi 분기 및 `autoResumeTurn` (autoResume settle 경로) + **AI가 직접 보는 문서**: `session-shared.md` (Background Session 절), `builder-prompt.md` (`on-assistant.js` 절), `data/skills/panel-design/references/engine-and-data.md` (on-assistant 한 줄) + `docs/architecture.md` + `docs/session-lifecycle.md` |
| 파이프라인 스케줄러 동작 변경 | `pipeline-scheduler.ts` + `bridge_scheduler_*` MCP 도구 + `docs/architecture.md` |
| 재시작 후 복구 흐름 변경 | `restart-notification.ts` + `service/restart` 라우트 + 마커 소비 지점 3곳 (`ws-server.ts`, sessions `[id]/open` 라우트, `builder/edit` 라우트의 `consumeRestartMarker`) + `docs/session-lifecycle.md` |
| 페르소나 lifecycle hook 추가/시그니처 변경 (`hooks/on-*.js`) | `session-instance.ts` (run*Hooks 메서드) + `builder-prompt.md` (hooks 섹션 — 빌더 AI가 hook을 작성하는 근거 문서) + `docs/session-lifecycle.md` (Hooks 단계) + `docs/data-model.md` (`hooks/` 디렉토리 예시) |
| 서브에이전트 추가/변경 시 | `subagents.json`(매니페스트) + `subagents/{name}/instructions.md` 편집. 영향 범위: 세션 Open 시 spawn(`subAgents.spawnAll()`), hook/autoTrigger dispatch 경로, `bridge_delegate`/`report_to_main`/`bridge_define_subagent` MCP 도구. `.resume-*`/`sub.log`/`history.json`/`transcript.jsonl`은 runtime artifact — gitignore·세션 복사 strip·publish SKIP 3곳 모두에 포함 유지 (2026-07 기준 publish SKIP에 `transcript.jsonl` 누락 — 코드 불일치 주의). 변경 후 세션 재open 필요 (spawn은 Open 시점에만 발생). |
| 서브에이전트 런타임 내부 변경 (spawn/transcript/사이드채널) | `subagent-manager.ts` / `subagent-instance.ts` / `subagent-registry.ts` / `subagent-manifest.ts` + `subagent:message` WS 이벤트 + 운영자 OOC 사이드채널 라우트 + 서브 대화 모달 UI (`docs/frontend.md`) + `docs/session-lifecycle.md` |
| 문체 자가검토 (style-check) 룰셋/훅 계약 변경 | `data/style-check/defaults.md` + `data/style-check/review-prompt.md` + 페르소나 `hooks/on-style-check.js` 계약 + `style-check.json` 옵트인 스키마 + 코어 (`session-instance.ts`/`session-state.ts`의 `__style_check_counter`) + `docs/style-check-system.md` + `builder-prompt.md` (on-style-check 섹션) |

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
| 환경 변수 추가/변경 | `docs/infrastructure.md` + `.env.example` |
| 세션 라이프사이클 변경 | `docs/session-lifecycle.md` |
| MCP 서버 인증/설정(URL·토큰) 변경 | per-provider writer 전부 (`runtime-config.ts`: `writeMcpConfig`(Claude) / `writeCodexConfig` / `writeGeminiConfig` / `writeAntigravityMcpConfig`(`.agents/mcp_config.json`)) + `docs/architecture.md` (MCP Server) + `docs/infrastructure.md` |
| Codex 런타임 설정 변경 (config.toml/MCP 등록) | `codex-process.ts` (spawn 시 `CODEX_HOME`을 세션 `.codex`로 리포인트 + `auth.json` 복사 — codex는 cwd의 `.codex/config.toml`을 읽지 않음) + `runtime-config.ts` `writeCodexConfig`. 기존 codex 세션은 재open 필요 |
| Antigravity 런타임 배관 변경 | `antigravity-process.ts` + `runtime-config.ts` `writeAntigravityMcpConfig` + 고아 PID 레지스트리 (`antigravity-pid-registry.ts`, `data/.runtime/agy-procs.json`, 세션 DELETE 라우트의 reap) + `docs/session-lifecycle.md` |
| TTS 서브시스템 변경 | `tts-server.mjs` (port 3341 독립 서버) + `tts-handler.ts` (server.ts 라우트 인터셉트, Edge/ComfyUI 분기) + `edge-tts-client.ts` + `TTS_ENABLED`/`TTS_PORT` env (`docs/infrastructure.md`) + voice.json 스키마면 `builder-prompt.md`도 (빌더 변경 표 참조) |
| 프론트엔드 페이지/컴포넌트/훅 추가 | `docs/frontend.md` |
| Core Library 파일 추가/변경 | `docs/architecture.md` (Core Libraries) |
| 사용량 API 변경 (Claude/Codex/Gemini/Antigravity) | `usage-checker.ts` + `/api/usage` + `docs/api-routes.md` |
| 외부 LLM 게이트웨이 라우팅 변경 | `docs/external-llm-routing.md` + `codex-process.ts` 관련 흐름 |

## 스킬 전파

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| `data/skills/` 글로벌 공유 스킬 변경 | 변경 즉시 반영 안 됨 — 세션 Open 시 자동 갱신 (`refreshToolSkills()`) |
| `data/tools/{name}/skills/` 도구 스킬 변경 | 동일 — 세션 Open 시 자동 갱신 |
| `data/builder_skills/` 빌더 전용 스킬 변경 | 빌더 세션 시작 시 자동 갱신 |
| 스킬 내 `{{PORT}}` 플레이스홀더 | 세션 Open 시 현재 서버 포트로 치환됨 (`SKILL.md`, `*.sh`) |
