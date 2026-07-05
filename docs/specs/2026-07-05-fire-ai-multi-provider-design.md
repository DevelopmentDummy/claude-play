# fire_ai 멀티 프로바이더 지원 — 설계

- 날짜: 2026-07-05
- 상태: 승인됨 (구현 대기)
- 브랜치: `feat/openai-image-codex-backend` (현재 작업 브랜치) 또는 신규 브랜치

## 배경 / 문제

`fire_ai`는 세션 중 시간이 오래 걸리는 작업을 대화 흐름을 막지 않고 백그라운드로 실행하는 fire-and-forget 메커니즘이다. 진입점이 3곳 있다.

1. MCP 도구 `fire_ai` → `POST /api/sessions/[id]/fire-ai` → `spawnBackgroundClaude()`
2. 세션 훅 `hooks/on-assistant.js`가 `{ fireAi: {...} }` 반환 → `spawnBackgroundClaude()`
3. 세션 훅 `hooks/on-style-check.js`가 `{ fireAi: {...} }` 반환 → `spawnBackgroundClaude()`

세 경로 모두 `src/lib/background-session.ts`의 `spawnBackgroundClaude()`로 수렴하는데, 이 함수는 `spawn("claude", …)`로 **Claude 전용 하드코딩**이다. 세션이 Codex/Gemini/Kimi/Antigravity를 쓰더라도 fire_ai는 항상 Claude를 띄운다.

목표: fire_ai를 **다른 서비스 프로바이더와 원하는 모델로** 실행할 수 있게 한다.

## 재사용할 기존 자산

- `providerFromModel(model)` (`src/lib/ai-provider.ts`): 모델 id로 provider 도출 (`gpt-5.4`→codex, `gemini-*`→gemini, `antigravity-*`→antigravity, `kimi-*`/`moonshot-ai/kimi-*`→kimi, `external/*`→codex, 그 외 claude).
- `parseModelEffort(value)`: `"opus:high"` → `{ model: "opus", effort: "high" }`.
- `createProcess(provider)` (`src/lib/ai-process-factory.ts`): provider별 process 클래스 팩토리.
- 모든 provider process가 공유하는 인터페이스:
  - `spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions?, logName?)`
  - `send(text)`, `kill()`, `isRunning()`, `waitForReady(ms)`
  - EventEmitter: `message` / `status` / `error` / `sessionId` / `exit`
- **provider별 셋업이 모두 process 클래스 안에 캡슐화되어 있음** — 재사용 시 공짜로 따라온다:
  - `CodexProcess.spawn()`이 child env에 `CODEX_HOME`=세션 `.codex` 설정 + `auth.json` 복사 + config(model_instructions_file, mcp_servers) 로드.
  - Antigravity는 `.agents/mcp_config.json` 기반, agy-procs.json PID 레지스트리로 reap.
  - Gemini `--resume` 폴백, Kimi `--wire` 핸드셰이크.
- turn 종료 신호가 provider-uniform: 모두 `message` 이벤트로 `{ type: "result" }`를 emit하고, 최종 텍스트는 `result.result`/`result.text`에 담긴다 (`subagent-transcript.reduceSubMessage` 검증됨).

## 설계 결정

### 아키텍처: 세션/서브에이전트 프로세스 엔진 재사용 (Approach B)

프로바이더별 one-shot CLI(`claude -p` / `codex exec` / `gemini -p` …)를 각각 새로 배선하는 대신, 서브에이전트가 이미 검증한 지속-프로세스 추상화를 재사용한다. one-shot처럼 "한 턴 실행 후 종료"로 운용한다.

이유:
- provider별 spawn/MCP/시스템프롬프트/모델/effort 배선이 이미 5종 전부 구현·검증됨. 특히 Antigravity(bubbletea TTY, PowerShell Start-Process)와 Kimi는 네이티브 one-shot이 까다로워 CLI 방식으로는 사실상 미지원.
- CODEX_HOME/MCP 등 provider 셋업이 process 클래스에 들어있어 재사용만으로 MCP 도구까지 그대로 붙는다.

### 기본값: model 미지정 시 Claude (하위 호환)

- `model`이 없으면 지금처럼 Claude(opus) + minimal task-execution 프롬프트 — **오늘 동작과 완전 동일**.
- `model`이 명시되면 `providerFromModel(model)`로 provider 도출.
- 별도 `provider` 파라미터는 만들지 않는다 (model에서 도출되므로 YAGNI). 현재 모델 id 집합은 `providerFromModel`로 모두 명확히 분기됨.

## 상세 동작

### 진입점 (시그니처 불변)

- `spawnBackgroundClaude` → **`spawnBackgroundAI`로 개명**. 하위 호환용으로 기존 이름은 `spawnBackgroundAI`를 가리키는 얇은 re-export alias로 남길지 여부는 구현 시 결정 (호출부가 3곳뿐이라 전부 교체가 더 깔끔; alias는 두지 않는다).
- 3개 호출부는 import 이름만 교체. `FireAIOptions`/`FireAIOnExit` 타입, `model`/`effort`/`notify`/`useSessionContext`/`onExit`/`callerSessionId` 필드는 그대로.
- MCP `fire_ai` 도구: `model` 설명을 "provider별 모델 id 아무거나 (opus, gpt-5.4, gemini-3.1-pro-preview, antigravity-flash, kimi-auto…); provider 자동 도출"로 확장. 스키마 필드 추가/삭제 없음. 도구 description에 멀티 프로바이더 지원 한 줄 추가.

### 실행 흐름 (`spawnBackgroundAI`)

1. `const { model: parsedModel, effort: embeddedEffort } = parseModelEffort(opts.model || "")`.
   - 유효 model = `parsedModel || undefined` (없으면 provider 기본 모델은 process가 자체 결정 / Claude면 opus).
   - 유효 effort = `opts.effort || embeddedEffort` (명시 인자 우선).
2. `const provider = parsedModel ? providerFromModel(parsedModel) : "claude"`.
   - `providerFromModel`이 던질 수 있음(Gemini disabled 등) → try/catch로 감싸 로그 남기고 실패 반환.
3. 시스템 프롬프트 계산 (§ 시스템 프롬프트 전달).
4. `const proc = createProcess(provider)`.
5. 리스너 배선:
   - `message`: `reduceSubMessage` 패턴 재사용으로 최종 텍스트 누적. `msg.type === "result"` 수신 시 `settle(0)` (정상 완료). 최종 텍스트를 로그/onExit용으로 보관.
   - `error`: `settle(1)`.
   - `exit`: 프로세스가 스스로 죽으면 `settle(lastCode ?? 1)` (idempotent).
6. `proc.spawn(sessionDir, undefined, effectiveModel, claudeSystemPrompt, effectiveEffort, true, logName)`.
   - `resumeId`는 항상 undefined (fire_ai는 새 대화, 이력 없음).
   - `logName = "background-<provider>.log"` (sessionDir 기준).
7. `await proc.waitForReady(20_000)` 후 `proc.send(payload)` (codex/kimi 비동기 핸드셰이크 대응 — 서브에이전트 `dispatch`와 동일 패턴). ready 실패 → `settle(1)`.
8. **안전 타임아웃**: spawn 시점에 상한 타이머 설정. 초과 시 `settle(1)` (kill 포함). 기본값 env `FIRE_AI_TIMEOUT_MS` (default 600_000 = 10분).
9. `settle(code)` (idempotent):
   - 타임아웃 클리어, 프로세스 추적 Map에서 제거, `proc.kill()`.
   - onExit(broadcast/script) → notify 순서로 실행 (기존 `runOnExit`/`pushCompletionEvent` 재사용).
   - 반환값 `{ pid, status: "fired" }`은 spawn 직후 즉시 반환(현재와 동일, 완료를 기다리지 않음). pid는 `proc`의 내부 pid(서브에이전트 `ProcCarrier` 캐스트 방식) 또는 antigravity면 null.

### 시스템 프롬프트 전달

- **Claude**: `spawn()`의 `appendSystemPrompt` 인자로 실제 `--system-prompt` 주입 (ClaudeProcess만 이 인자를 실 시스템프롬프트로 사용). `useSessionContext`에 따라 `TASK_EXECUTION_SYSTEM_PROMPT` 또는 `buildSystemPromptForSession(sessionDir)`. **오늘 동작 그대로.** send할 payload는 순수 user prompt.
- **비-Claude**: `appendSystemPrompt`는 무시되므로(provider 클래스가 미적용), 시스템 프롬프트를 **payload 앞에 leading 블록으로 prepend**해서 `send`한다:
  ```
  <systemPrompt>

  --- TASK ---
  <prompt>
  ```
  ⚠️ **주의(문서화 대상)**: codex/gemini 등은 세션 config의 baseInstructions(persona 시스템 프롬프트)도 함께 로드한다. 따라서 minimal 모드라도 persona 지시가 완전히 치환되지 않고, "background 에이전트·RP 금지" leading 지시가 그 위에 얹히는 형태다. one-shot 태스크에서는 leading 지시가 지배적이라 수용 가능한 트레이드오프.

### onExit / notify 매핑

- turn `result` 정상 완료 → `exitCode = 0`.
- 프로세스 error / 타임아웃 / never-ready → `exitCode = 1`.
- 프로세스가 스스로 종료 → 실제 종료 코드 사용.
- `onExit.script`의 `logTail`은 `background-<provider>.log`에서 추출 (기존 `tailFile` 재사용, 로그 파일명만 provider별로).
- `onExit.broadcast`, `notify`(→ `pushCompletionEvent` completion 이벤트) 계약은 **불변**. `[BACKGROUND_SESSION_COMPLETE] pid=… exit_code=…` 헤더 포맷 유지.

## 컴포넌트 / 파일 변경

| 파일 | 변경 |
|------|------|
| `src/lib/background-session.ts` | `spawnBackgroundClaude` → `spawnBackgroundAI` 개명 + provider 라우팅. `createProcess`/`reduceSubMessage`/`parseModelEffort`/`providerFromModel` 사용. pid-keyed Map → provider-process 추적 Map. 안전 타임아웃. `destroyAll…`이 provider process를 kill. Claude vs 비-Claude 시스템프롬프트 분기. |
| `src/app/api/sessions/[id]/fire-ai/route.ts` | import `spawnBackgroundClaude` → `spawnBackgroundAI`. body 파싱 불변. |
| `src/lib/session-instance.ts` | on-assistant / on-style-check 훅의 `spawnBackgroundClaude` 호출 → `spawnBackgroundAI`. 로그 문구 "bg claude" → "bg AI". 필드 불변. |
| `src/mcp/claude-play-mcp-server.mjs` | `fire_ai` 도구 description + `model` 설명 확장. 스키마 필드 불변. |
| `docs/architecture.md`, `docs/session-lifecycle.md` | fire-ai 설명을 멀티 프로바이더로 갱신 (change-propagation 규칙). |

## 오류 처리

- `providerFromModel` throw (Gemini disabled 등): try/catch, 로그 후 `spawnBackgroundAI`가 던지거나 실패 표식 반환 — 훅/route가 이미 try/catch로 감싸고 있어 세션 턴은 깨지지 않음.
- provider spawn 실패(pid 없음/never-ready): `settle(1)`로 onExit/notify가 exit_code 1로 발화되어 호출자가 실패를 인지.
- 타임아웃: `settle(1)` + kill. 로그에 타임아웃 사유 기록.
- Antigravity: pid가 null이어도 agy-procs.json 레지스트리가 reap 담당(기존 메커니즘). settle의 `proc.kill()`이 agy 종료 시도.

## 테스트 / 검증

프레임워크 없음 → 수동 스모크. 최소:
1. **하위 호환**: model 없이 fire_ai 호출 → Claude opus 스폰, 로그·완료 이벤트 기존과 동일.
2. **Codex**: `model: "gpt-5.4"` → codex 프로세스가 세션 CODEX_HOME으로 스폰, MCP 도구 접근, turn 완료 후 notify.
3. **Gemini**(비활성 아니면): `model: "gemini-3.1-pro-preview"`.
4. **notify=true**: 완료 이벤트가 다음 user 턴에 주입되는지.
5. **onExit.script**: `logTail`이 provider 로그를 읽어 콜백이 broadcast/queueEvent 반환하는지.
6. **타임아웃**: 인위적으로 긴 작업 → 상한 초과 시 kill + exit_code 1.
7. `npm run build` (tsc + Next 빌드) 그린.

## 범위 밖 (YAGNI)

- 명시적 `provider` 파라미터 (model에서 도출).
- fire_ai가 세션 provider/모델을 상속하는 옵션 (기본은 Claude 유지로 결정됨).
- 진행 중 백그라운드 작업의 스트리밍/취소 API.
- fire_ai 대화의 resume/이력 (항상 새 대화).
