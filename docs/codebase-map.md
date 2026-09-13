# Codebase Map — 작업 요청 → 어디부터 보나

> **독자**: 새 작업 요청(기능 추가·버그·동작 변경)을 받은 AI 에이전트와 사람.
> **목적**: 39k줄·212파일 리포에서 **요청 어휘 → 서브시스템 → 진입 파일 → grep 앵커 → 읽어야 할 문서 → 검증 단계**를 한 번의 조회로 잇는다. 파일별 역할 설명은 [architecture.md](architecture.md)·[frontend.md](frontend.md)·[api-routes.md](api-routes.md)가 담당하고, 이 문서는 **탐색 순서**만 다룬다.
> 이 문서에 줄 번호는 적지 않는다 — 줄 번호는 썩는다. 대신 grep 앵커(식별자·이벤트명·헤더 토큰·한국어 UI 문자열)를 적는다. 지도에 적힌 파일 경로가 실존하는지는 `npm run check:docs`가 강제한다.

## 0. 탐색 절차 (5단계, 10분 이내)

1. **분류** — 요청을 아래 §2 표의 행 하나(또는 둘)에 대응시킨다. 대응되는 행이 없으면 §3의 레이어 표로 내려가 "어느 레이어에서 시작하는 요청인가"(UI / 라우트 / 세션 런타임 / 프로바이더 / 데이터 파일)를 정한다.
2. **진입** — 행의 진입 파일을 **읽기 전에** grep 앵커로 먼저 검색한다 (한 앵커가 보통 3~8개 파일에 걸리고 그것이 곧 영향 범위다). 2,000줄짜리 `session-instance.ts`·`session-manager.ts`·`chat/[sessionId]/page.tsx`는 통째로 읽지 말고 앵커 주변만 읽는다.
3. **함정 확인** — 행에 적힌 플레이북 §를 읽는다. "이상해 보이는" 코드를 만나면 고치기 전에 [maintenance-playbook.md](maintenance-playbook.md) §5·§3 표에서 먼저 찾는다.
4. **전파** — [change-propagation.md](change-propagation.md)의 해당 행을 열어 함께 고칠 파일·문서를 확정한다. 프롬프트/스킬/MCP desc처럼 **AI가 읽는 문서**가 영향권이면 세션 재-open이 필요하다는 점을 계획에 넣는다.
5. **검증 계획** — 행의 "검증" 열이 `hot-path`면 typecheck만으로 끝나지 않는다 (플레이북 §1.1). 라이브 스모크를 못 돌리면 커밋 메시지에 명기 + [HANDOVER.md](../HANDOVER.md) §4에 등재.

## 1. grep 위생

- **Grep 도구(Claude Code)는 내장 ripgrep을 쓴다.** 셸에는 `rg`가 PATH에 없다 — 셸에서 검색할 땐 `git grep -n "패턴" -- src server.ts scripts` (tracked 파일만 뒤지므로 `data/`·`.next/`·`node_modules/`가 자동 제외된다).
- Grep 도구를 쓸 때는 `path`를 `src` 또는 파일 하나로 좁혀라. 리포 루트 전체 검색은 `data/`(15GB, 유저 데이터)와 `scratch/`·`docs/superpowers/`를 훑어 느리고 결과가 오염된다.
- **한국어 UI 문자열이 가장 안정적인 앵커다.** 예: `"세션 종료"`는 정확히 관련 5개 파일(라우트·페이지·StatusBar·registry·외부 MCP)만 맞춘다. 식별자는 리팩터로 바뀌지만 사용자에게 보이는 문구는 잘 안 바뀐다.
- 서버↔클라이언트 경계는 **WS 이벤트명**(`chat:send`, `event:pending`, `subagent:message`…)과 **프롬프트 헤더 토큰**(`[CHOICE_MISS]`, `[MEMO]`, `[SUB:`, `[OPERATOR]`, `[AVAILABLE]`)으로 잇는다. 이벤트명 하나를 grep하면 발신·수신 양쪽이 같이 나온다.
- MCP 도구는 `src/mcp/claude-play-mcp-server.mjs`의 `server.registerTool(` 바로 다음 줄이 이름이다. 도구 이름 grep은 `.mjs` + `session-shared.md` + `builder-prompt.md`까지 포함해야 AI 측 지시문 영향까지 잡힌다.
- 라우트 파일은 `src/app/api/**/route.ts`. URL을 알면 경로가 곧 파일이다 (`/api/sessions/[id]/memo` → `src/app/api/sessions/[id]/memo/route.ts`). 단, `/api/chat/tts`·`/api/personas/[name]/voice/generate`·`/mcp/external`·`/ws`는 `server.ts`가 Next 앞에서 가로챈다.

## 2. 요청 어휘별 진입점

"진입" 열은 **서버 → 클라이언트** 순. "검증"은 플레이북 §1 사다리 기준 (`tsc` = typecheck로 충분, `hot-path` = 라이브 스모크 필요, `re-open` = 기존 세션 재-open 해야 반영).

| 요청 어휘 | 서브시스템 | 진입 파일 | grep 앵커 | 함정·문서 | 전파 행 | 검증 |
|---|---|---|---|---|---|---|
| 빌더 기록 누락, 재시작 후 응답 사라짐 | 기록 저장 | `src/lib/history-storage.ts` → `src/lib/session-instance.ts` → `src/app/api/service/restart/route.ts` | `flushHistoryDraft`, `history-draft.json`, `recoverHistoryDraft` | session-lifecycle.md Builder history checkpoints | 서비스 재시작 + 라우트 빌드 | hot-path |
| 메시지 전송, 스트리밍, 응답 안 옴, 순서 꼬임 | 채팅 코어 | `src/lib/session-instance.ts` (`sendMessage`) → `src/lib/ws-server.ts` → `src/hooks/useChat.ts` → `src/components/ChatMessages.tsx` | `chat:send`, `chat:user`, `chat:split`, `chat:cancelled`, `upsertAssistantMessage`, `finishAssistantTurn` | 플레이북 §4 (프로바이더별), §4.1 카드 함정 | 세션 런타임 | hot-path |
| OOC, 메타 대화, 캐릭터 이탈 | 채팅 코어 | `src/lib/session-instance.ts` → `src/app/api/chat/send/route.ts` → `src/components/ChatInput.tsx` | `isOOC`, `OOC 메시지입니다`, `oocRef` | `session-shared.md` OOC 절 | "OOC 동작 변경" | hot-path |
| 턴 중 개입, steer, 스트리밍 중 메시지 | 채팅 코어 | `src/lib/session-instance.ts` (`steerAI`) → 각 `src/lib/*-process.ts` → `src/hooks/useChat.ts` (`prepareInterject`) | `steerAI`, `splitAssistantTurnForInterject`, `chat:split`, `prepareInterject`, `bridge_interject_enabled` | HANDOVER §4-17 (agy·kimi 미검증), frontend.md useChat 행 | 세션 런타임 | hot-path |
| 취소, Stop 버튼 | 채팅 코어 | `src/lib/session-instance.ts` (`cancelStreaming`) → `src/hooks/useChat.ts` (`handleCancelled`) | `chat:cancel`, `chat:cancelled` | frontend.md useChat 행 | 세션 런타임 | hot-path |
| 선택지, CHOICE_MISS, 선택지 빗나감 | 프롬프트 헤더 | `src/lib/session-instance.ts` (`buildChoiceMiss`) → `src/components/ChatMessages.tsx` (choice 파싱) → `src/components/ChatInput.tsx` (버튼) | `[CHOICE_MISS]`, `buildChoiceMiss`, `choices` | HANDOVER §4-11, `session-shared.md` 선택지 절 | "응답 형식 규칙 변경" | re-open |
| 세션 메모, 로비 카드 요약, 자동 요약 | 메모 | `src/lib/session-memo.ts` → `src/lib/session-instance.ts` (`runSessionMemoTick`) → `src/app/api/sessions/[id]/memo/route.ts` → `src/components/SessionCard.tsx`, `src/components/StatusBar.tsx` | `[MEMO]`, `autoMemo`, `memoAuto`, `bridge_set_session_memo` | data-model.md 세션 메모 노트, `docs/specs/2026-07-29-session-memo-design.md` | MCP 도구 + API | re-open |
| 시스템 이벤트, 다음 턴에 알림, 이벤트 큐 | 이벤트 큐 | `src/lib/session-instance.ts` (`queueEvent`/`flushEvents`) → `src/app/api/sessions/[id]/events/route.ts` | `pending-events`, `event:pending`, `queueEvent`, `[EVENT]` | session-lifecycle.md 이벤트 병합 | 세션 런타임 | tsc |
| 패널 안 바뀜, Handlebars, variables.json | 패널 엔진 | `src/lib/panel-engine.ts` → `src/lib/session-state.ts` (원자 쓰기) → `src/components/PanelSlot.tsx`/`DockPanel.tsx`/`ModalPanel.tsx` | `panels:update`, `layout:update`, `fs.watch`, `atomicWriteJsonSync` | **플레이북 §5.1·§5.3** (watch 단절·templateCache), `panel-spec.md` | 패널 시스템 | hot-path |
| 패널 액션, `[AVAILABLE]`, 액션 버튼이 유저 메시지를 덮음 | 패널 액션 | `src/lib/panel-actions-meta.ts` (서버) → `src/lib/panel-action-registry.ts` (클라) → `src/lib/panel-action-spec.ts` | `[AVAILABLE]`, `[정의]`, `_actions.meta.json`, `available_when` | 플레이북 §5.3 (tools/ 패널 오염) | 패널 액션 스펙 | re-open |
| 모달 열림/닫힘, `__modals`, ESC | 모달 | `src/lib/modal-merge.ts` → `src/app/api/sessions/[id]/modals/route.ts` → `src/lib/use-panel-bridge.ts` → `src/components/ModalPanel.tsx`, `MinimizedModals.tsx` | `__modals`, `closeAllModals`, `modalGroups` | `modal-merge.test.ts` 실행 필수 | 패널 시스템 | tsc + 테스트 |
| 레이아웃, placement, dock, 패널 위치 | 레이아웃 | `src/hooks/useLayout.ts` → `src/app/api/sessions/[id]/layout/route.ts` → `src/lib/session-config-io.ts` | `placement`, `dock-bottom`, `layout.json` | `scripts/lint-data.mjs`의 placement 허용 집합도 갱신 | layout.json 스키마 | tsc |
| 훅, on-assistant, on-message, on-compaction | 페르소나 훅 | `src/lib/session-instance.ts` (`runMessageHooks`/`runAssistantHooks`/`runCompactionResumeHook`) | `hooks/on-`, `guardAsyncHookResult`, `mutateSessionJsonSync` | 플레이북 §5.2 (훅↔서브 쓰기 레이스), `builder-prompt.md` hooks 절 | "lifecycle hook 추가" | hot-path |
| 문체 검토, 드리프트, style-check | 문체 자가검토 | `src/lib/session-instance.ts` (`runStyleCheckHook`) → `src/lib/session-state.ts` | `__style_check_counter`, `style-check.json`, `on-style-check` | [style-check-system.md](style-check-system.md), HANDOVER §5-8 (`update_variables` 유령 도구) | style-check 행 | hot-path |
| 앱 모드, 월드, 스레드 루프, NPC가 안 움직임, 틱이 안 돎 | 앱 모드 | `src/lib/app-mode.ts` → `src/lib/thread-loop.ts` → `src/lib/world-engine.ts` → `src/lib/thread-registry.ts` → `src/components/AppSlot.tsx` | `resolveAppMode`, `selectDueThreads`, `runExclusiveSession`, `syncThreadLoop`, `threads:status`, `[WORLD]`, `[THREAD]` | [앱 모드 설계](specs/2026-09-12-app-mode-platform-design.md) (틱 순서 §7.0·의도 큐 §5.6이 핵심 함정) | 세션 런타임 + 패널 시스템 | hot-path |
| 서브에이전트, 위임, `[SUB:`, 서브 대화 모달 | 서브에이전트 | `src/lib/subagent-manager.ts` → `subagent-instance.ts` → `subagent-manifest.ts` → `subagent-transcript.ts` → `src/components/SubAgentChatModal.tsx` | `bridge_delegate`, `report_to_main`, `[SUB:`, `[OPERATOR]`, `subagent:message` | session-lifecycle.md 서브 절, `docs/specs/2026-06-*-subagent-*` | 서브에이전트 2행 | hot-path + re-open |
| fire_ai, 백그라운드 AI, autoResume, 자발 턴 | 백그라운드 AI | `src/lib/background-session.ts` (`spawnBackgroundAI`) → `src/lib/session-instance.ts` (`autoResumeTurn`) → `src/app/api/sessions/[id]/fire-ai/route.ts` | `fire_ai`, `autoResume`, `FIRE_AI_TIMEOUT_MS`, `onExit` | 플레이북 §4.5 (readiness·setImmediate yield) | fire-ai 행 | hot-path |
| 파이프라인 스케줄러, scheduler_tick, 주기 실행 | 스케줄러 | `src/lib/pipeline-scheduler.ts` → `src/app/api/sessions/[id]/pipeline-scheduler/*` | `scheduler_tick` (페르소나 `pipeline` 툴의 action), `scheduler:notify`, `bridge_scheduler_` | session-lifecycle.md | 스케줄러 행 | hot-path |
| 세션 열기, resume, 대화 이어가기, 프로세스 spawn | 세션 수명 | `src/app/api/sessions/[id]/open/route.ts` → `src/lib/session-registry.ts` → `src/lib/session-instance.ts` (constructor) → `src/lib/respawn-helpers.ts` | `openSessionInstance`, `getResumeIdForProvider`, `relinkConversation` | session-lifecycle.md Open 단계, shared-documents.md 조립 흐름 | 세션 라이프사이클 | hot-path |
| 세션 종료, 유예 시간, 끊겼는데 살아있음 | 세션 수명 | `src/lib/session-registry.ts` (grace) → `src/app/api/sessions/[id]/close/route.ts` → `src/components/StatusBar.tsx` | `"세션 종료"`, `closeSessionInstance`, `session:leave` | HANDOVER §4-13 | 세션 라이프사이클 | hot-path |
| 세션 생성, 페르소나 → 세션 복사, sync, diff | 세션 파일 | `src/lib/session-manager.ts` → `src/lib/session-sync-diff.ts` → `src/app/api/sessions/[id]/sync/route.ts` → `src/components/SyncModal.tsx` | `fileDiffers`, `mirrorNewPersonaFiles`, `.sessionignore` | shared-documents.md, data-model.md | 세션 라이프사이클 | tsc |
| 시스템 프롬프트, primer, 지시문 파일, CLAUDE.md 조립 | 프롬프트 조립 | `src/lib/prompt-assembly.ts` → `src/lib/runtime-instructions.ts` → `src/lib/respawn-helpers.ts` | `buildServiceSystemPrompt`, `writeInstructionsForProvider`, `active_system_prompt` | **shared-documents.md** (어느 yaml/md가 어디로 가는지), 플레이북 §4.4.5 (agy는 GEMINI.md 미로드) | "시스템 프롬프트 변경" | re-open |
| MCP 도구 안 보임, `.mcp.json`, config.toml, 토큰 | 런타임 설정 | `src/lib/runtime-config.ts` (`ensureClaudeRuntimeConfig`) → `src/lib/auth.ts` | `writeMcpConfig`, `writeCodexConfig`, `writeAntigravityMcpConfig`, `x-bridge-token` | 플레이북 §3 표 "MCP 도구가 안 보임", §4.2 CODEX_HOME | MCP 설정 행 | re-open |
| 페르소나 전용 MCP, Blender 연결, MCP 승인 | 런타임 설정 | `src/lib/persona-mcp.ts` → `src/lib/runtime-config.ts` | `runtime-mcp.json`, `mcp-trust.json`, `readPersonaMcpServers` | [persona MCP 명세](specs/persona-mcp.md), 플레이북 §4.2 | MCP 설정 행 | tsc + 테스트 + re-open |
| MCP 도구 추가, bridge_* 도구, run_tool | MCP 서버 | `src/mcp/claude-play-mcp-server.mjs` | `server.registerTool(`, `withPersona`, `requestJson` | architecture.md MCP Tools 표, 플레이북 §5.10 (`node:http`) | "MCP 도구 추가" | re-open |
| 모델 추가, 프로바이더 라우팅, effort, advisor | 프로바이더 해석 | `src/lib/ai-provider.ts` → `src/lib/ai-process-factory.ts` → `src/components/StatusBar.tsx`/`PersonaStartModal.tsx`/`NewPersonaDialog.tsx` | `MODEL_GROUPS`, `providerFromModel`, `parseModelEffort`, `MIN_CLI_VERSIONS` | **플레이북 §4.2** (CLI 버전 게이트), `ai-provider.test.mts` 실행 | "모델 선택기 변경" | tsc + 테스트 |
| Claude 프로세스, stream-json, AskUserQuestion 카드 | 프로바이더 | `src/lib/claude-process.ts` → `src/lib/session-instance.ts` (`submitToolAnswer`) → `src/components/InteractiveQuestionCard.tsx` | `tool:answered`, `[질문 응답]`, `content_block_delta` | 플레이북 §4.1 (헤드리스 자동 거부·카드 연쇄 함정) | 세션 런타임 | hot-path |
| Codex, app-server, thread/start, turn 실패 | 프로바이더 | `src/lib/codex-process.ts` | `turn/completed`, `extractCodexErrorMessage`, `CODEX_HOME`, `[steer]` | 플레이북 §4.2, `codex-process.test.mts` 실행, [external-llm-routing.md](external-llm-routing.md) | Codex 런타임 설정 | hot-path |
| Kimi, --wire, sticky session id | 프로바이더 | `src/lib/kimi-process.ts` | `findKimiSessionId`, `ApprovalRequest`, `sticky` | 플레이북 §4.3 | 세션 런타임 | hot-path |
| Antigravity, agy, Gemini 모델, stream-json, CSRF 401, wake-up echo | 프로바이더 | `src/lib/antigravity-process.ts` → `src/lib/antigravity-pid-registry.ts` | `turnQueue`, `handleStepUpdate`, `handleResult`, `stripSystemMessageEcho`, `resolveModelSlug` | **플레이북 §4.4 전체** (전환 배경·stream-json 함정·모델 slug·플러그인 MCP·디버깅) | Antigravity 배관 | hot-path |
| 이미지 생성, ComfyUI, 워크플로 패키지, LoRA, 체크포인트 | 이미지 | `src/lib/comfyui-client.ts` → `comfyui-graph.ts`/`comfyui-checkpoint.ts`/`comfyui-history.ts` → `src/lib/workflow-resolver.ts` → `src/app/api/tools/comfyui/generate/route.ts` | `generate_image`, `timeoutBudget`, `seed_randomize`, `resolver.mjs`, `params.json` | 플레이북 §5.4 (4개소 게이트)·§5.10 (undici 절벽·seed) | 이미지 워크플로 행 | hot-path + re-open |
| 영상 생성, H3, Range 재생, 긴 렌더 | 이미지/미디어 | `src/lib/long-http.ts` → `src/lib/comfyui-client.ts` → `src/lib/static-file.ts` → `src/components/InlineImage.tsx` | `longRequest`, `SaveVideo`, `fileResponseWithRange`, `VIDEO_RE` | 플레이북 §5.10, HANDOVER §4-15 | 이미지 + API | hot-path |
| GPT 이미지, Codex image_gen, OpenAI 이미지 | 이미지 | `src/lib/codex-image.ts` (기본) / `src/lib/openai-image.ts` (api) → `src/app/api/tools/openai/generate/route.ts` | `OPENAI_IMAGE_BACKEND`, `IG_OUTPUT_RE`, `generated_images` | **플레이북 §5.5** (파일명 규칙이 codex 버전마다 바뀜) | 이미지 백엔드 게이팅 | hot-path |
| Gemini 이미지 | 이미지 | `src/lib/gemini-image.ts` → `src/app/api/tools/gemini/generate/route.ts` | `GEMINI_IMAGE_MODEL`, `generate_image_gemini` | 플레이북 §5.4 | 이미지 백엔드 게이팅 | tsc |
| 인라인 이미지 재로딩, `$IMAGE` 토큰, 썸네일, 304 | 미디어 서빙 | `src/app/api/sessions/[id]/files/[...filepath]/route.ts` → `src/lib/static-file.ts` → `src/lib/inline-formatter.ts` → `src/components/InlineImage.tsx` | `$IMAGE`, `?thumb=`, `.thumbs`, `ETag` | HANDOVER §4-14, 플레이북 §5.7 (formatter 불변식) | API + 프론트 | tsc + 테스트 |
| 외부 에이전트, `/mcp/external`, 스킬팩 셋업 | 외부 MCP | `src/lib/external-mcp/registry.ts` (`EXTERNAL_TOOLS`) → `server.ts` → `src/lib/external-mcp/server.ts`/`token.ts`/`flatten.ts` → `scripts/setup-external.mjs` | `x-external-token`, `outputDir`, `CURATED_SKILLS` | [external-mcp.md](external-mcp.md), [external-setup-guide.md](external-setup-guide.md), `scripts/smoke-external-mcp.mjs` | 외부 MCP 행 | 서버 재시작 (re-open 불필요) |
| TTS, 음성, Edge, 음성 클로닝, STT | 음성 | `src/lib/tts-handler.ts` → `tts-server.mjs` → `src/lib/edge-tts-client.ts` → `gpu-manager/tts_engine.py` → `src/components/VoiceSettings.tsx`, `ChatInput.tsx` (voiceChat) | `ttsProvider`, `TTS_PORT`, `/api/chat/tts`, `voiceChat` | **플레이북 §5.8** (독립 서버 유지), architecture.md GPU Manager | TTS 행 | hot-path |
| 사용량, 한도, 리셋 시각 | 사용량 | `src/lib/usage-checker.ts` → `src/app/api/usage/route.ts` → `src/components/UsageIndicator.tsx`, `UsageModal.tsx` | `getClaudeUsage`, `resets_at`, `timeProgress` | 메모리 노트: 참조 앱 `C:\repository\claude_usage` | 사용량 API 행 | tsc |
| 재시작, 빌드 반영 안 됨, 재시작 후 이어가기 | 재시작 복구 | `scripts/restart.mjs` → `src/app/api/service/restart/route.ts` → `src/lib/restart-notification.ts` → 마커 소비 3곳 | `consumeRestartMarker`, `.restart-trigger`, `restart-build.log` | 플레이북 철칙 #2, §3 표 첫 두 행, `data/restart*.log` | 재시작 복구 행 | hot-path |
| 로그인, 401, ADMIN_PASSWORD, 쿠키 | 인증 | `src/middleware.ts` → `src/lib/auth.ts` → `src/app/api/auth/*` → `src/app/login/page.tsx` | `bridge_auth`, `verifyAuthToken`, `validateInternalToken` | **플레이북 §1.3** (middleware는 토큰 존재만 확인) | 인프라 | tsc + `npm run smoke` |
| 셋업 위자드, 첫 실행, .env.local 저장 | 셋업 | `src/lib/setup-guard.ts` → `src/app/api/setup/*` → `src/app/setup/page.tsx` → `src/lib/env-file.ts` → `setup.js`/`setup-web.js` | `isSetupComplete`, `.setup-complete`, `cudaTag` | [ai-setup-guide.md](ai-setup-guide.md), 플레이북 §2.6 (Blackwell) | 인프라 | tsc |
| 앱 페르소나 저작, 빌더가 앱 모드를 모름 | 빌더 + 앱 모드 | `app-spec.md` → `builder-prompt.md`(앱 모드 절) → `src/mcp/claude-play-mcp-server.mjs` → `src/app/api/builder/{start,edit}/route.ts` | `bridge_define_role`, `app-spec.md`, `앱 모드`, `roles/` | [앱 모드 설계](specs/2026-09-12-app-mode-platform-design.md), shared-documents.md | 빌더 변경 표 | re-open (빌더 재시작) |
| 빌더, 페르소나 제작, builder-prompt, 빌더 카드 | 빌더 | `src/app/api/builder/start/route.ts`·`edit/route.ts` → `src/lib/prompt-assembly.ts` (`getBuilderPrompt`) → `src/app/builder/[name]/page.tsx` → `src/components/BuilderOverview.tsx` | `builder-session.json`, `{{validModels}}`, `builderPersona` | shared-documents.md 빌더 흐름, 메모리: Fable로 빌더 실행 시 API 차단 | 빌더 변경 표 | hot-path |
| 페르소나 import/publish/clone/버전, GitHub | 페르소나 배포 | `src/app/api/personas/[name]/{publish,clone,versions,check-update}/route.ts`, `personas/import/route.ts` → `src/components/ImportPersonaModal.tsx`/`PublishPersonaModal.tsx`/`ClonePersonaDialog.tsx`/`VersionHistoryModal.tsx` | `import-meta.json`, `persona.json`, `(복제본)` | data-model.md 페르소나 트리 | "import/publish/clone" | tsc |
| 삭제, 복구, deleted_sessions, EBUSY | 소프트 삭제 | `src/lib/soft-delete.ts` → `src/app/api/sessions/[id]/route.ts`·`personas/[name]/route.ts` → `src/lib/antigravity-pid-registry.ts` | `deleted_sessions`, `killAgyForDir`, `retryOnWindowsLock` | 플레이북 철칙 #6, §3 "세션 삭제가 EBUSY", HANDOVER §5-1 | 인프라 | tsc |
| 프로필, 유저 이름, {user_name} | 프로필 | `src/app/api/profiles/*` → `src/components/ProfileCard.tsx`/`ProfileSelectDialog.tsx`/`NewProfileDialog.tsx` → `src/lib/prompt-assembly.ts` | `profileSlug`, `user_name` | data-model.md profiles | 인프라 | tsc |
| 로비, 홈 화면, 카드 목록 | 로비 UI | `src/app/page.tsx` → `src/components/PersonaCard.tsx`/`SessionCard.tsx`/`ProfileCard.tsx` | `memoFallback`, `sessionCount` | frontend.md Cards | 프론트엔드 | tsc + 하드 리프레시 |
| 모바일, 좁은 화면, 드로어 | 반응형 | `src/hooks/useIsMobile.ts` → `src/components/PanelDrawer.tsx` → `src/components/PanelSlot.tsx` (`PANEL_DEFENSIVE_STYLE`) | `useIsMobile`, `PANEL_DEFENSIVE_STYLE`, `visibilitychange` | HANDOVER §7-6 모바일 잔여 항목 | 프론트엔드 | 브라우저 확인 |
| WebSocket 끊김, 재연결, 브로드캐스트 | 통신 | `src/lib/ws-server.ts` → `src/hooks/useWebSocket.ts` → `src/lib/sse-manager.ts`/`useSSE.ts` | `wsBroadcast`, `session:bind`, `setupWebSocket` | architecture.md Communication | 인프라 | hot-path |
| 스킬 전파, SKILL.md, {{PORT}}, 스킬이 세션에 안 보임 | 스킬 | `src/app/api/sessions/[id]/open/route.ts` → `src/lib/session-manager.ts` (`refreshToolSkills`) → `src/lib/fs-mirror.ts`; 빌더는 `src/app/api/builder/start/route.ts` 별도 | `refreshToolSkills`, `refreshDirectoryWithBackups`, `.skill-backups`, `{{PORT}}`, `builder_skills` | 플레이북 §5.6 | 스킬 전파 표 | re-open + fs-mirror.test.ts |
| 환경 변수, 포트, .env.example | 인프라 | `src/lib/endpoints.ts` → `src/lib/data-dir.ts` → `.env.example` | `process.env.`, `getDataDir`, `DATA_DIR_NAME` | **플레이북 §5.9** (data 리터럴 금지), [infrastructure.md](infrastructure.md) | env var 행 | `npm run check:docs` |
| 빌드 느림, nft, tracer | 빌드 | `next.config.ts` → `src/lib/data-dir.ts` | `outputFileTracingExcludes`, `DATA_DIR_NAME` | 플레이북 §5.9, 메모리 `build_perf` | 인프라 | `npm run build` (프로덕션 중지 시에만) |

## 3. 레이어별 시작점 (표에 없는 요청)

| 요청이 시작되는 곳 | 먼저 열 파일 | 그다음 |
|---|---|---|
| 화면에 보이는 것 | `src/app/chat/[sessionId]/page.tsx` (세션) / `src/app/page.tsx` (로비) / `src/app/builder/[name]/page.tsx` (빌더) | 해당 컴포넌트 → frontend.md 행 |
| HTTP 요청·응답 | `src/app/api/<url>/route.ts` (URL = 경로) | 라우트가 호출하는 `src/lib/*` — 라우트는 얇아야 하므로 로직은 lib에 있다 |
| AI 턴 도중의 동작 | `src/lib/session-instance.ts` (`sendMessage` → `processResult`) | 프로바이더 `*-process.ts` → 플레이북 §4 |
| AI가 도구를 호출 | `src/mcp/claude-play-mcp-server.mjs` | 도구가 때리는 라우트 → lib |
| AI가 읽는 지시문 | `session-shared.md` / `session-primer*.yaml` / `builder-prompt.md` / `panel-spec.md` | shared-documents.md (어디로 전파되는지) |
| 세션·페르소나 디렉토리의 파일 | [data-model.md](data-model.md) | 그 파일을 쓰는 코드는 파일명 grep (`chat-history.json` 등) |
| 서버 기동·자식 프로세스·포트 | `server.ts` → `src/lib/endpoints.ts` | 플레이북 철칙 #8 (detached 프로세스) |
| 커밋 전 검증 스크립트 | `scripts/check-static.mjs` / `lint-data.mjs` / `smoke.mjs` / `check-docs.mjs` | [pre-merge-checklist.md](pre-merge-checklist.md) |

## 4. 큰 파일 안에서 길 찾기

통째로 읽지 말고 아래 앵커로 점프한다.

| 파일 (줄 수 규모) | 구역 앵커 |
|---|---|
| `src/lib/session-instance.ts` (~2,000) | `sendMessage` (턴 시작) · `processResult` (턴 종료·silent retry) · `runMessageHooks`/`runAssistantHooks` (훅) · `buildChoiceMiss`/`buildHintSnapshot`/`buildJsonLint` (헤더 조립) · `runStyleCheckHook`/`runSessionMemoTick` (주기 작업) · `switchProvider` · `destroy` |
| `src/lib/session-manager.ts` (~1,900) | `createSession` · `refreshToolSkills` · `patchSessionMeta` (원자 쓰기 경고 주석) · `mirrorNewPersonaFiles` · builder-session 관련은 `builder-session.json` grep |
| `src/app/chat/[sessionId]/page.tsx` (~1,400) | `useChat(` 호출부 · `handleCloseSession` · `onSubAgents` · dock/modal 승격 분기는 `dock-bottom` grep · TTS 언락은 `audio` grep |
| `src/lib/comfyui-client.ts` (~1,360) | `generate(` · `timeoutBudget` · `pollHistory`/`waitAndDownload` · 그래프 수술은 `comfyui-graph.ts`로 이미 분리됨 |
| `src/lib/antigravity-process.ts` (~580) | `spawn`/`launch` (stream-json 파이프 spawn) · `resolveModelSlug` (`agy models`) · `turnQueue` (primer/user 턴 ↔ `result` 짝짓기) · `handleStepUpdate` (text_delta·spontaneous 턴) · `handleResult` · `stripSystemMessageEcho` |
| `src/mcp/claude-play-mcp-server.mjs` (~1,600) | `server.registerTool(` 24개 — 이름으로 grep |

## 5. 이 문서의 유지

- 새 lib·컴포넌트·라우트·MCP 도구를 추가하면 `npm run check:docs`가 architecture/frontend/api-routes 누락을 잡는다. **이 지도는 그 검사에 걸리지 않으므로**, 새 사용자-대면 기능을 추가했으면 §2에 행 하나를 손으로 추가할 것 (전파 규칙: [change-propagation.md](change-propagation.md) "새 기능/서브시스템 추가" 행).
- 지도가 참조하는 파일 경로가 사라지면 `check:docs`가 에러로 알려준다 — 그때 행을 고친다.
- 줄 번호·커밋 해시·날짜는 적지 않는다. 그런 정보는 HANDOVER.md와 git log의 몫이다.
