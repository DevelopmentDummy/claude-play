# Session Lifecycle

1. **Create**: `POST /api/sessions` — 페르소나 디렉토리 → 세션 디렉토리 복사 (빌더 메타·런타임 설정 등은 자동 제외, 페르소나 루트 `.sessionignore`에 추가 제외 항목 등록 가능 — top-level 이름만), CLAUDE.md/AGENTS.md/GEMINI.md 조립, 런타임 설정 파일(`.claude/`, `.codex/`, `.gemini/`, `.kimi/`) 생성, panel-spec.md + 글로벌 스킬 동기화
2. **Open**: `POST /api/sessions/[id]/open` — provider별 AI 프로세스 spawn, PanelEngine 시작, panel-spec.md 및 글로벌 스킬 갱신, panel-action 메타 markdown 직렬화 후 시스템 프롬프트에 주입
3. **Chat**: WebSocket `chat:send` 또는 `POST /api/chat/send` — 메시지 직전에 큐된 이벤트(`events.json`) / 패널 액션 / 힌트 스냅샷을 flush하여 한 번에 전달, NDJSON 스트리밍 응답
4. **Accumulate**: `SessionInstance`에서 `text_delta` 이벤트를 수집, `<dialog_response>` / `<choice>` / `<break/>` (scene break) 추출, OOC 플래그 처리, 히스토리 저장
5. **Hooks**: 메시지/응답 단계에서 `hooks/on-message.js`, `hooks/on-assistant.js` 실행 — 변수/데이터 패치 + `fireAi` 디스패치(`spawnBackgroundClaude()`) 가능. 추가로 Claude 런타임 compaction 종료 시 `hooks/on-compaction-resume.js`가 호출되어 `{contextBlock: string}`을 반환하면 silent system turn으로 주입 (페르소나 핵심 상태 재정착)
6. **Panel refresh**: AI 턴 종료 시 `PanelEngine.reload()`로 데이터 파일 재로드 및 패널 재렌더링
7. **Sync** (수동): `POST /api/sessions/[id]/sync` — 양방향. Forward(페르소나→세션)는 OOC 알림 전송, Reverse(세션→페르소나)는 페르소나 템플릿에 역기록
8. **Leave/Disconnect**: 마지막 클라이언트 연결 해제 후 5초 유예 → AI 프로세스 종료, PanelEngine 중지, 파이프라인 스케줄러 정지

## Penta Runtime (Claude / Codex / Gemini / Kimi / Antigravity)

- Provider determined by model at session creation (`providerFromModel()`), locked for session lifetime
- **Claude**: `claude -p` persistent process, NDJSON stream-json I/O
- **Codex**: `codex app-server` persistent JSON-RPC 2.0 over stdin/stdout. `external/...` 모델은 `model_provider="external"`을 per-process로 주입 (외부 게이트웨이 사용 시)
- **Gemini**: `gemini` per-turn spawning with `--resume` for session continuity. **⚠️ 2026-06-18부터 Google이 무료/Pro/Ultra 요청 처리 중단** — `NEXT_PUBLIC_DISABLE_GEMINI=true`로 즉시 차단 가능, Antigravity로 마이그레이션 권장
- **Kimi**: `kimi --wire` JSON-RPC persistent process, `:thinking` suffix는 `--thinking` 플래그로 전달
- **Antigravity** (agy 1.0.0): PowerShell `Start-Process -WindowStyle Hidden`으로 agy 백그라운드 spawn, 자체 in-process Language Server(HTTPS+gRPC, random port)에 ConnectRPC 직접 호출(`/exa.language_server_pb.LanguageServerService/*`). Service: `StartCascade` → `SendUserCascadeMessage` → `GetCascadeTrajectory` 500ms 폴링. agy CLI in-process LS는 unauth (CSRF 토큰 불필요). `~/.gemini/antigravity-cli/settings.json` trustedWorkspaces 자동 등록. Windows-only 현재
- 모두 동일한 EventEmitter interface (`message/status/error/sessionId`)
- Instruction files: `CLAUDE.md` (Claude/Kimi) + `AGENTS.md` (Codex) + `GEMINI.md` (Gemini/Antigravity) — 세션 생성 시 동일 컨텐츠로 병렬 생성
- MCP config: `.mcp.json` (Claude) + `.codex/config.toml` (Codex) + `.gemini/` (Gemini) + `.kimi/` (Kimi) + `.agents/mcp_config.json` (Antigravity)
- Builder mode supports service switching — provider 전환 시 빌더 채팅 히스토리 리셋

## Background AI (`fire_ai`)

- MCP `fire_ai` 도구 또는 hook 반환값(`fireAi`)으로 트리거
- `background-session.ts`의 `spawnBackgroundClaude()`가 detached Claude를 spawn — PID 즉시 반환, 메인 턴 비차단
- `useSessionContext: true`이면 페르소나 전체 컨텍스트, 아니면 최소 시스템 프롬프트
- 종료 시점 옵션 (모두 독립적, 순서: `onExit.broadcast` → `onExit.script` → `notify`):
  - `notify: true` — `[BACKGROUND_SESSION_COMPLETE]` silent system event를 caller 세션에 주입 → AI가 다음 턴에 응답. 라이브 인스턴스 없으면 `pending-events.json` disk fallback
  - `onExit.broadcast: { event, data }` — caller 세션 클라이언트에게만 WS 메시지(`wsBroadcast(..., { sessionId: callerSessionId })`). UI 스피너 숨김·지연 reveal·토스트 등 AI 턴 비개입 용도
  - `onExit.script: "hooks/xxx.js"` — `sessionDir` 안의 JS 모듈을 `require`해서 호출. 인자 `{ pid, exitCode, sessionDir, logTail }`, 반환 `{ broadcast?, queueEvent? }`로 동적 처리. path traversal 차단(세션 dir 밖 경로 거부), `require.cache`는 매 호출마다 invalidate

## Pipeline Scheduler

- 세션별 폴링 루프로 `pipeline_tick()` 커스텀 도구를 주기적으로 실행
- `POST /api/sessions/[id]/pipeline-scheduler/start` / `/stop` — UI에서 토글
- MCP의 `bridge_scheduler_inspect` / `_stop` / `_restart`로 AI 측에서도 제어 가능
- Tick 결과로 발생한 notification은 다음 사용자 턴 직전에 시스템 이벤트로 합류

## Restart Recovery

- `POST /api/service/restart` 또는 MCP `bridge_restart_service` 호출 시 `restart-notification.ts`가 활성 세션마다 마커를 기록
- 새 서버 부팅 후 마커를 atomic rename으로 클레임 → 다음 사용자 메시지 직전에 사일런트 시스템 이벤트로 AI에 전달
- 이를 통해 재시작 직전 상태에서 자연스럽게 이어 받음
