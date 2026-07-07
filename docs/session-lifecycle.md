# Session Lifecycle

1. **Create**: `POST /api/sessions` — 페르소나 디렉토리 → 세션 디렉토리 복사 (빌더 메타·런타임 설정 등은 자동 제외, 페르소나 루트 `.sessionignore`에 추가 제외 항목 등록 가능 — top-level 이름만), CLAUDE.md/AGENTS.md/GEMINI.md 조립, 런타임 설정 파일(`.claude/`, `.codex/`, `.gemini/`, `.kimi/`) 생성, panel-spec.md + 글로벌 스킬 동기화
2. **Open**: `POST /api/sessions/[id]/open` — provider별 AI 프로세스 spawn, PanelEngine 시작, panel-spec.md 및 글로벌 스킬 갱신, panel-action 메타 markdown 직렬화 후 시스템 프롬프트에 주입. 페르소나 템플릿에 추가된 신규 파일(hooks, opt-in 설정 등)을 additive mirror — 페르소나에만 있고 세션에 없는 파일만 1회 복사, 기존 세션 파일은 절대 덮어쓰지 않음 (RP 상태 보호). 메인 프로세스 spawn 완료 후 `subAgents.spawnAll()`로 상시 서브에이전트 기동 (`subagents.json` 존재 시)
3. **Chat**: WebSocket `chat:send` 또는 `POST /api/chat/send` — 메시지 직전에 큐된 이벤트(`pending-events.json`) / 패널 액션 / 힌트 스냅샷을 flush하여 한 번에 전달, NDJSON 스트리밍 응답
4. **Accumulate**: `SessionInstance`에서 `text_delta` 이벤트를 수집, `<dialog_response>` / `<choice>` 추출, OOC 플래그 처리, 히스토리 저장 (`<break/>`/`<scene_break>` scene break는 서버가 아니라 프론트 `ChatMessages.tsx`가 렌더링 시 분할)
5. **Hooks**: 메시지/응답 단계에서 `hooks/on-message.js`, `hooks/on-assistant.js` 실행 — 변수/데이터 패치 + `fireAi` 디스패치(`spawnBackgroundAI()`) 가능. 추가로 Claude 런타임 compaction 종료 시 `hooks/on-compaction-resume.js`가 호출되어 `{contextBlock: string}`을 반환하면 silent system turn으로 주입 (페르소나 핵심 상태 재정착). 페르소나가 `style-check.json` + `hooks/on-style-check.js` 둘 다 보유하면 코어가 `__style_check_counter`를 굴리며 `intervalTurns` 도달 시 hook을 호출 — 공용 룰셋(`data/style-check/defaults.md`)과 페르소나 룰(`style-check-rules.md`)을 머지해 인자로 넘기고, hook은 `fireAi`를 반환해 검토 LLM을 띄움. 검토 LLM은 세션 dir의 `variables.json`을 직접 패치해 `style_drift_verdict` / `style_warning`을 갱신 (룰셋 defaults.md가 지시하는 `update_variables` MCP 도구는 현재 미등록 — 실제로는 파일 편집 폴백으로 동작)
6. **Panel refresh**: AI 턴 종료 시 `PanelEngine.reload()`로 데이터 파일 재로드 및 패널 재렌더링
7. **Sync** (수동): `POST /api/sessions/[id]/sync` — 양방향. Forward(페르소나→세션)는 OOC 알림 전송, Reverse(세션→페르소나)는 페르소나 템플릿에 역기록
8. **Leave/Disconnect**: 마지막 클라이언트 연결 해제 후 10분 유예 (`CLEANUP_GRACE_MS`, 모바일 재연결 대비) → AI 프로세스 종료, PanelEngine 중지, 파이프라인 스케줄러 정지, 서브에이전트 전체 종료 (`SubAgentManager.destroyAll()`)

## Penta Runtime (Claude / Codex / Gemini / Kimi / Antigravity)

- Provider determined by model at session creation (`providerFromModel()`), locked for session lifetime
- **Claude**: `claude -p` persistent process, NDJSON stream-json I/O
- **Codex**: `codex app-server` persistent JSON-RPC 2.0 over stdin/stdout. `external/...` 모델은 `model_provider="external"`을 per-process로 주입 (외부 게이트웨이 사용 시). spawn 시 child env의 `CODEX_HOME`을 세션 `.codex/`로 리포인트하고 실제 `auth.json`을 복사 — codex는 config.toml(mcp_servers·model_instructions_file 포함)을 `$CODEX_HOME`에서만 읽으므로 세션별 MCP/시스템 프롬프트는 이 리포인트로만 성립 (`codex-process.ts`)
- **Gemini** (은퇴): `gemini` per-turn spawning with `--resume`. **⚠️ 2026-06-18부터 Google이 무료/Pro/Ultra 요청 처리 중단으로 Gemini CLI 텍스트 프로바이더 사용 불가** → 현재 배포는 `NEXT_PUBLIC_DISABLE_GEMINI=true` **기본 설정**. 이때 `providerFromModel`이 **gemini-* id를 antigravity로 투명 리맵**(gemini-…-pro→Pro tier, 그 외→Flash; agy `modelPattern`이 키워드 기반이라 매핑 테이블 불필요) + 선택기 Gemini 그룹 숨김. 기존 gemini 세션/페르소나/서브/fire_ai가 그대로 agy에서 동작(세션 open/sync/options 라우트의 uncaught throw 500도 해소). 신규 선택은 "Gemini (Antigravity)" 옵션(Gemini 3.5 Flash / 3.1 Pro). (이미지 생성용 `GEMINI_API_KEY`는 별개로 유효)
- **Kimi**: `kimi --wire` JSON-RPC persistent process, `:thinking` suffix는 `--thinking` 플래그로 전달. 세션 id 캡처는 cwd+mtime **휴리스틱**(`findKimiSessionId`) — 서브에이전트가 cwd를 공유하므로 per-spawn sticky `resolvedSessionId`로 한 번 확정된 뒤의 휴리스틱 id는 무시(`kimi-stream.log`에 `[session] ignored heuristic id X (sticky: Y)` 기록). 서브는 kimi id를 캡처/영속하지 않음(매 open fresh+re-prime)
- **Antigravity** (agy 1.0.5 기준 — 1.0.5에서 `SendUserCascadeMessage`가 `items:[{text}]` 스키마로, 모델 키가 동적 인덱스 `MODEL_PLACEHOLDER_M{N}`으로 변경됨): PowerShell `Start-Process -WindowStyle Hidden`으로 agy 백그라운드 spawn, 자체 in-process Language Server(HTTPS+gRPC, random port)에 ConnectRPC 직접 호출(`/exa.language_server_pb.LanguageServerService/*`). Service: `StartCascade` → `SendUserCascadeMessage` → `GetCascadeTrajectory` 500ms 폴링. agy CLI in-process LS는 unauth (CSRF 토큰 불필요). `~/.gemini/antigravity-cli/settings.json` trustedWorkspaces 자동 등록. Windows-only 현재
  - **턴 종료 감지**: primary = agy의 명시적 `WaitForConversationFullyIdle` RPC(`{conversationId: cascadeId}`)와 휴리스틱 폴백(IDLE grace 틱 + trajectory-stable 5틱; ERROR 종료 분기는 stable 3틱으로 단축)의 race. 턴 종료 후에는 `startIdleWatch()`가 4초 간격 경폴링으로 async 도구(ComfyUI 이미지/영상) 완료 wake-up 턴을 라이브 emit — 결과에 `spontaneous:true` 태깅, 15분/연속 실패 3회 상한, `ANTIGRAVITY_IDLE_WATCH=false`로 opt-out (`antigravity-process.ts`)
  - **빈 턴 silent retry (agy 전용)**: 턴 결과가 빈 턴(세그먼트 0+도구 0)·메타-only·도구호출 누출이면 `SessionInstance`가 `[system]` nudge를 `_silentRetry`로 1회 재전송 (`silentRetryDone` — 유저 입력마다 리셋, 입력당 최대 1회; spontaneous idle-watch 턴은 제외). 로그에 보이는 유령 `[system]` nudge의 정체
  - **GEMINI.md 자동 로드 안 함**: agy는 지시문을 **primer**(첫 USER_INPUT)로만 전달받으며 cascade 히스토리에 남아 resume에도 유지됨 — 진행 중 세션의 GEMINI.md 수정은 사실상 no-op. primer는 `MAX_PRIMER_CHARS`(28000자, Windows 커맨드라인 32767자 한계) truncation 주의
- 모두 동일한 EventEmitter interface (`message/status/error/sessionId`)
- Instruction files: `CLAUDE.md` (Claude) + `AGENTS.md` (Codex/Kimi — Kimi CLI는 작업 디렉토리의 AGENTS.md를 로드하며, spawn마다 `writeKimiInstructions`가 CLAUDE.md+런타임 프롬프트 병합본으로 AGENTS.md를 덮어씀) + `GEMINI.md` (Gemini/Antigravity — 단 agy는 자동 로드하지 않음, 위 Antigravity 항목 참조) — 세션 생성 시 동일 컨텐츠로 병렬 생성 (CLAUDE.md가 병합의 authoritative source)
- MCP config: `.mcp.json` (Claude·Kimi — Kimi는 동일 파일을 `--mcp-config-file`로 명시 전달, `.kimi/`는 skills·agent yaml 전용) + `.codex/config.toml` (Codex — 위 CODEX_HOME 리포인트로 로드됨) + `.gemini/` (Gemini) + `.agents/mcp_config.json` (Antigravity)
- Builder mode supports service switching — provider 전환 시 빌더 채팅 히스토리 리셋

## Background AI (`fire_ai`)

- MCP `fire_ai` 도구 또는 hook 반환값(`fireAi`)으로 트리거
- `background-session.ts`의 `spawnBackgroundAI()`가 `model`에서 도출된 provider(기본 Claude)로 백그라운드 턴을 spawn(`createProcess` 엔진 재사용) — PID 즉시 반환, 메인 턴 비차단. 한 턴 실행 후 `{type:"result"}` 수신 시 settle(kill+notify/onExit).
- `useSessionContext: true`이면 페르소나 전체 컨텍스트, 아니면 최소 시스템 프롬프트
- 종료 시점 옵션 (`onExit`는 독립적, 순서: `onExit.broadcast` → `onExit.script` → 완료 통지. 완료 통지는 `autoResume` > `notify` 우선순위로 택일):
  - `notify: true` — `[BACKGROUND_SESSION_COMPLETE]` silent system event를 caller 세션에 주입 → AI가 **다음 유저 턴**에 응답(큐잉만). 라이브 인스턴스 없으면 `pending-events.json` disk fallback
  - `autoResume: true` — 완료 시 caller AI가 **idle이면 즉시, busy면 현재 턴 종료 직후** 자발적 응답 턴을 발동(유저 입력 대기 없음). `notify`를 흡수(설정 시 큐잉+자동발동 모두 수행). 구현: `SessionInstance.autoResumeTurn()`이 `queueEvent`→`waitForIdle()`→(`setImmediate` yield로 co-waking 유저 턴에 양보)→빈-큐/`_pendingTurn`/체인캡 가드 통과 시 `[BACKGROUND_RESUME] fire_ai 결과 콜백입니다.` 지시문+이벤트로 `claude.send`. 빈-큐 가드가 유저 merge·다중완료 coalesce를 자연 해소. 런어웨이 루프 가드 `_autoResumeChain`(상한 `FIRE_AI_AUTORESUME_MAX`, 기본 5, 유저 턴마다 리셋). 라이브 인스턴스/프로세스 없으면 `notify`와 동일하게 disk fallback
  - `onExit.broadcast: { event, data }` — caller 세션 클라이언트에게만 WS 메시지(`wsBroadcast(..., { sessionId: callerSessionId })`). UI 스피너 숨김·지연 reveal·토스트 등 AI 턴 비개입 용도
  - `onExit.script: "hooks/xxx.js"` — `sessionDir` 안의 JS 모듈을 `require`해서 호출. 인자 `{ pid, exitCode, sessionDir, logTail }`, 반환 `{ broadcast?, queueEvent? }`로 동적 처리. path traversal 차단(세션 dir 밖 경로 거부), `require.cache`는 매 호출마다 invalidate
- **트리거 경로별 옵션 차이**: `autoResume`은 MCP `fire_ai` 도구와 `POST /api/sessions/[id]/fire-ai` 라우트에서만 지원 — hook 반환 `fireAi`(on-assistant)는 autoResume 미지원, on-style-check 경로는 `onExit`도 미지원 (`session-instance.ts`의 각 fireAi shape 참조)
- **안전 타임아웃**: `FIRE_AI_TIMEOUT_MS` env (기본 600000ms=10분) — persistent provider 프로세스는 한 턴 후 자체 종료하지 않으므로 hung turn을 kill (`background-session.ts`)
- **readiness 규칙**: `waitForReady(20s) === false`는 실패가 **아님** — `!proc.isRunning()`일 때만 abort하고, 프로세스가 살아 있으면 그냥 `send()` 한다 (각 provider의 send()가 자체 readiness 대기; agy는 primer 응답 대기로 20s를 상습 초과하므로 timeout=실패 취급 시 프롬프트 전송 전에 죽음). 서브에이전트 dispatch(`subagent-instance.ts`)도 동일 규칙. child PID는 spawn 직후 1회 캡처(`firedPid`) — settle 시 provider가 내부 proc를 null화하므로 늦게 읽으면 -1
- **Antigravity 백그라운드는 `pid=0` 반환** — agy는 `proc.pid` 미노출(자체 `agy-procs.json` PID 레지스트리로 reap)
- 서버 종료 시 `destroyAllBackgroundProcesses()`가 활성 백그라운드 프로세스를 일괄 kill (`server.ts`)

## Sub-Agents (always-on)

페르소나 디렉토리의 `subagents.json` 매니페스트로 정의된 **상시 상주 서브에이전트** 기능 (v2).

### Spawn & Destroy
- 세션 **Open** 시 `SessionInstance.subAgents`(`SubAgentManager`)가 매니페스트를 읽어 각 서브를 `SubAgentInstance`로 spawn. `SubAgentInstance`는 provider 프로세스의 경량 래퍼 — PanelEngine 없음.
- **v2.1: 서브는 기본적으로 세션의 provider·모델·effort를 상속하되, 매니페스트 `model`로 개별 고정할 수 있다.** Open 라우트가 세션 값으로 `SubAgentManager.spawnAll(provider, model, effort)`를 호출하고, `spawnAll`이 def별로 resolve한다 — `model`이 지정된 서브는 그 id에서 provider를 도출(`providerFromModel`)하고 effort suffix를 분리(`parseModelEffort`); effort는 서브가 세션과 같은 provider일 때만 세션 값을 상속하고, 다른 provider면 그 provider 기본을 쓴다. `model` 미지정 서브는 세션 값을 그대로 따른다.
- **런타임 전환 시 재생성**: 재오픈에서 세션 provider/모델/effort가 바뀌었으면 `spawnAll()`이 캐시된 서브를 개별 destroy 후 새 런타임으로 재생성한다.
- 서비스 재시작 후 세션이 재오픈되면 `spawnAll()`이 다시 실행된다 — `subagents/{name}/.resume-{provider}` 파일이 있으면 resume으로 기동(이미 primed 취급), 없으면 첫 dispatch에서 role 재주입.
- 서브는 세션 디렉토리를 cwd로 공유 → MCP 도구(`run_tool` 등)를 통해 동일 변수/데이터에 직접 접근, MCP 설정도 자동 상속.
- 세션 **destroy** 시 (`SessionInstance.destroy()`) `SubAgentManager.destroyAll()`로 cascade 종료.

### Role 주입 (leading-message)
- 서브의 role은 **첫 번째 디스패치 메시지(leading-message)로 주입**된다 (spawn의 append-system-prompt 인자는 서브에 사용하지 않음). `instructions.md` 내용이 실제 태스크 앞에 prepend되어 전송(`primed`는 SubAgentInstance 인메모리 플래그 — 매 start()마다 `.resume-{provider}` 존재 여부로 재파생). resume 재오픈 시 이미 primed된 서브는 재주입 생략. 이 경로는 5개 provider가 단일 코드로 처리한다.

### Dispatch 경로 (4가지)
1. **Hook-driven**: `hooks/on-assistant.js`가 `dispatch: [{ to, task }]`를 반환 → `SessionInstance.runAssistantHooks()`에서 `SubAgentManager.dispatch(name, task)` 호출.
2. **Declarative autoTrigger**: 매니페스트에서 `autoTrigger: "onAssistantTurn"`으로 선언된 서브는 메인 AI 응답마다 `autoTriggerTask`(기본 태스크 + 최신 응답 cap append)로 자동 dispatch. `on-assistant.js` 없어도 동작.
3. **MCP explicit delegation**: 메인 AI가 `bridge_delegate({ to, task })` MCP 도구 호출 → `POST /api/sessions/{id}/subagents/{name}/dispatch` → `SubAgentManager.dispatch`.
4. **Operator OOC 직접 메시지**: 서브 대화 모달에서 `POST /api/sessions/{id}/subagents/{name}/message` → `dispatch(name, text, "operator")` — 메인 내레이터 비개입 사이드채널. dispatch 호출은 origin 태깅됨(`delegate`/`auto`/`operator`).

### Sub → Main 리포트 (pure async)
- 서브가 `report_to_main({ from, summary })` MCP 도구 호출 → `POST /api/sessions/{id}/events` → `pending-events.json`에 `[SUB:<from>] <summary>` 헤더로 큐잉.
- 큐된 이벤트는 **다음 사용자 턴** 직전에 flush되어 메인 내레이터에 전달 (기존 event-queue → next-turn 메커니즘 재사용).
- 전달은 **순수 비동기** — 전송 시점에 큐된 것만 포함, 실행 중인 서브의 결과는 그 다음 턴에 합류.

### Operator ↔ Sub OOC 사이드채널 (대화 모달)
- 서브별 전체 대화가 `subagents/{name}/transcript.jsonl`에 영속 (`subagent-transcript.ts`) — publish/미러 제외 대상.
- `SubAgentManager`가 WS `subagent:message` / `subagent:status`(busy) 이벤트를 브로드캐스트 → 프론트 메신저형 모달이 실시간 갱신 (StatusBar 통합).
- API: `GET /api/sessions/[id]/subagents`(목록+busy 상태), `GET .../subagents/[name]/transcript`, `POST .../subagents/[name]/message`(operator dispatch, 위 경로 4).

### Manifest (`subagents.json`)
```json
{
  "version": 1,
  "subagents": [{
    "name": "tracker",
    "role": "상태 추적 역할 설명",
    "instructions": "instructions.md",
    "delegable": true,
    "autoTrigger": "onAssistantTurn",
    "autoTriggerTask": "현재 상태를 분석하고 변수를 갱신하라",
    "emitSummary": true,
    "writes": ["variables.json"]
  }]
}
```
서브 수 상한: `SUBAGENT_MAX` 환경변수 (기본 6).

매니페스트의 `model` 필드(effort suffix 포함 가능)는 해당 서브의 런타임 고정에 사용된다 — `validateManifest`가 `providerFromModel`/`parseModelEffort`로 `providerExplicit`/`model`/`effort` 분리 필드를 채운다. 매니페스트에 `provider`/`effort`를 직접 적으면(수동 편집) 도출보다 우선한다. `bridge_define_subagent` MCP 도구는 단일 `model` 문자열만 받아 기록하고(분해는 `validateManifest`가 수행), 미지정 시 세션 값을 상속한다.

### 파일 레이아웃
- `subagents/{name}/instructions.md` — role prompt 템플릿 (persona dir에서 session dir로 복사).
- `subagents/{name}/.resume-{provider}` — runtime artifact (provider session id for resume). provider별로 분리되어 provider 전환 시 기존 파일은 무시되고 role이 재주입됨. **gitignored, mirrored/published 대상 아님**.

### PID 레지스트리
- 서브 PID는 `data/.runtime/subagent-procs.json`에 영속화.
- `server.ts` 부팅 시 `reapOrphanSubProcs()`가 고아 프로세스를 정리 — PID에 기록된 세션 디렉토리가 실제 프로세스 커맨드라인에 포함되어 있는지 검증 후 kill (PID recycling-safe; 비-Claude 프로세스에는 적용 안 됨).

### 로그
- 각 프로세스는 자기 로그를 씀: 메인은 `{provider}-stream.log`(예: `claude-stream.log`), 서브는 `subagents/{name}/sub.log` (cwd 공유로 인한 로그 충돌 방지). 5개 provider 모두 spawn 시 `logName` 인자로 로그 경로를 제어한다.

### v2 알려진 한계
- ⓐ **leading-message 역할 고정의 약점**: 시스템 프롬프트보다 역할 고정력이 약하다. 장기 세션에서 컨텍스트 compaction이 발생하면 leading-message가 희석될 수 있음 — 주기적 재주입은 추후 작업.
- ⓑ **서브의 narrator 컨텍스트 상속**: 서브는 cwd=세션 dir라 메인 narrator의 지시문 파일(`CLAUDE.md`(Claude)·`AGENTS.md`(Codex/Kimi)·`GEMINI.md`(Gemini))을 기본 컨텍스트로 로드한다(Antigravity는 GEMINI.md를 자동 로드하지 않으므로 해당 없음 — primer 참조). 보통 world/character 맥락은 부기에 유용하지만, narrator 지시문이 매우 길면 서브가 서사로 흐를 수 있음 — role leading-message의 preamble("You are NOT the narrator")이 유일한 가드.
- ⓒ **비-Claude 서브의 cmdline 기반 고아 reap 미지원**: PID 레지스트리의 정상 등록·해제 경로는 모든 provider에서 동작한다. 단, `reapOrphanSubProcs()`가 PID의 커맨드라인에서 세션 디렉토리를 검증하는 로직은 Claude 프로세스 외에는 적용되지 않는다. Antigravity 서브는 `agy-procs.json` 레지스트리 + `killAgyForDir`로 별도 reap됨.
- ⓓ **sync 훅 ↔ async 서브 쓰기 레이스**: 메인의 `runAssistantHooks`는 `mutateSessionJsonSync`(동기, per-file 뮤텍스 우회)로 `variables.json`을 쓰고, 서브는 라우트 경유 `mutateSessionJson`(뮤텍스 적용)으로 쓴다. 같은 파일을 sync(메인)와 async(서브)가 거의 동시에 건드리면 atomic tmp+rename으로 파일 손상은 없으나 **lost update** 가능. 노출은 낮음(윈도우 짧음, 보통 disjoint 키). **회피책**: 매니페스트 `writes[]`(권고)에 맞춰 메인 훅과 서브가 서로 다른 변수/파일을 쓰도록 페르소나를 구성. 완전 해결(훅 변수 쓰기의 async 게이트 경유)은 후속 작업.
- ⓔ **Kimi 첫 open 시 sticky id 오염 가능성 (잔여 race, 라이브 미검증)**: Kimi 세션 id는 cwd+mtime 휴리스틱이라, 서브가 cwd를 공유하는 세션의 **첫** open에서 서브 대화 파일이 mtime 우선권을 잡으면 sticky `resolvedSessionId`가 서브 id로 잘못 고정될 수 있음. `session.json`의 `kimiSessionId`가 메인 대화인지는 `kimi-stream.log`의 `ignored heuristic id` 라인으로 확인. 실제 발생 시 수정 방향은 서브 spawn을 메인 sessionId emit 이후로 지연.

## Pipeline Scheduler

- 세션별 폴링 루프가 페르소나 커스텀 도구 `pipeline`을 `{action:"scheduler_tick"}`으로 주기 호출 (시작/정지/완료 시엔 `engine` 도구의 `start_scheduler`/`stop_scheduler`/`finish_scheduler` 액션; 호출 경로는 `POST /api/sessions/[id]/tools/[name]` 재사용)
- `POST /api/sessions/[id]/pipeline-scheduler/start` / `/stop` — UI에서 토글
- MCP의 `bridge_scheduler_inspect` / `_stop` / `_restart`로 AI 측에서도 제어 가능
- Tick 결과로 발생한 notification은 다음 사용자 턴 직전에 시스템 이벤트로 합류

## Restart Recovery

- `POST /api/service/restart` 또는 MCP `bridge_restart_service` 호출 시 `restart-notification.ts`가 재시작을 유발한 세션에 마커를 기록
  - **채팅 세션**: 요청에 `sessionId` 포함 → 마커는 `data/sessions/{id}/.restart-pending.json`. 새 서버에서 `/api/sessions/[id]/open`이 `consumeRestartMarker` 호출
  - **빌더 세션**: MCP가 builder 모드에선 `sessionId`가 빈 문자열이라 대신 `builderPersona`(persona 이름)를 전달 → 마커는 `data/personas/{name}/.restart-pending.json`. 새 서버에서 **`/api/builder/edit`**(빌더 재진입 경로)가 spawn 직후 `consumeRestartMarker(personaDir, instance)` 호출. WS 연결 핸들러(`ws-server.ts`)도 빌더 인스턴스 연결 시 동일하게 consume하는 제2 소비 경로. `/api/builder/start`(신규 생성, fresh spawn)는 이어받을 컨텍스트가 없어 미적용
- 새 서버 부팅 후 마커를 atomic rename으로 클레임 → AI가 ready 되면 사일런트 시스템 이벤트로 전달 (TTL 10분 초과 시 폐기)
- 이를 통해 재시작 직전 상태에서 자연스럽게 이어 받음
- 마커 파일(`.restart-pending.json`/`.processing`)은 persona publish·clone `.gitignore` 및 세션 미러링 SKIP 목록에 포함 → 누출/오발송 방지
