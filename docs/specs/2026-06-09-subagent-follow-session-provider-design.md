# 서브에이전트가 세션 provider를 따라가게 (v2) — 설계

- 날짜: 2026-06-09
- 브랜치: `feat/persona-subagent-orchestration` (v1 위에 이어서)
- 선행 문서: [v1 설계](2026-06-07-persona-subagent-orchestration-design.md), [v1 플랜](../plans/2026-06-07-persona-subagent-orchestration-plan.md)

## 1. 배경 & 동기

v1 서브에이전트는 **Claude provider 전용**이다. 그 제약은 서브가 자기 role을 프로세스의 `append-system-prompt` 인자로 받는데, 그 인자를 실제로 적용하는 게 `ClaudeProcess.spawn`뿐이기 때문에 생겼다.

코드 확인 결과 중요한 사실 두 가지가 드러났다:

1. **서브의 provider는 메인 세션 provider와 완전히 분리돼 있다.** 매니페스트([subagent-manifest.ts:18](../../src/lib/subagent-manifest.ts))에서 항상 `"claude"`로 검증되고, [bridge_define_subagent](../../src/mcp/claude-play-mcp-server.mjs)도 `provider:"claude"`를 하드코딩한다. 서브를 띄우는 [spawnAll()](../../src/app/api/sessions/[id]/open/route.ts)은 메인 provider로 게이트되지 않으며(빌더 모드만 제외), autoTrigger 발화 지점인 `runAssistantHooks`는 5개 provider 공통 경로(`processResult`)에서 호출된다. 따라서 **메인이 비-Claude여도 Claude 서브는 정상 동작한다** — "비-Claude 메인이면 stat-keeper가 안 돈다"는 기존 경고는 부정확하다(서브의 provider가 Claude 전용인 것과 메인 provider를 혼동한 것).

2. 그러나 사용자의 진짜 요구는 **비용/인증 일원화**다: 한 provider만 쓰거나 결제하면서, 서브 때문에 Claude API 비용/인증이 추가로 드는 걸 원치 않는다. 따라서 서브가 **세션과 같은 provider로** 돌아야 하고, **Claude 폴백은 허용되지 않는다**.

### 확정된 결정 (사용자)

| 항목 | 결정 |
|---|---|
| 동기 | 비용/인증 일원화 (Claude 폴백 금지) |
| 서브 provider | **세션 provider에서 파생** (매니페스트에 박지 않음) |
| 서브 모델/effort | **세션과 동일** (provider별 "싼 모델" 맵 불필요) |
| role 전달 메커니즘 | **균일 leading-message** (접근 1) |
| cwd | **세션 디렉토리 공유 유지** (MCP 신원 `basename(dir)=세션id`) |
| Antigravity | **포함** (5개 provider 전부 leading-message) |

## 2. 목표 & 비목표

**목표**
- 세션을 provider P(claude/codex/gemini/kimi/antigravity)로 열면, 그 세션의 서브도 P + 동일 모델/effort로 spawn된다.
- 단일 코드 경로로 5개 provider를 균일하게 처리한다.
- v1의 트리거(autoTrigger·on-assistant `dispatch[]`·`bridge_delegate`)·통지(`report_to_main`)·always-on 수명은 그대로 보존한다.

**비목표 (이번 범위 아님)**
- 서브가 메인과 *다른* provider/모델을 쓰는 혼합 구성(예: 메인 Opus + 서브 Haiku 비용 절감) — 매니페스트 per-sub 오버라이드는 후속.
- leading-message의 긴 세션 compaction 대비 주기적 role 재주입 — 후속.
- 서브↔서브 통신, 관리 UI (v1 비목표 그대로).

## 3. 아키텍처 변경

### 3.1 provider/model 파생 (매니페스트 → 세션)

서브의 provider는 페르소나 빌드 타임 매니페스트에 고정될 수 없다. 같은 페르소나를 세션마다 다른 모델로 열 수 있으므로, provider/model/effort는 **세션 open 시점에 세션 값에서 파생**해야 한다.

- `subagent-manifest.ts`: `PROVIDERS = ["claude"]` 검증 게이트 제거. `provider` 필드는 매니페스트에서 **무시**한다(하위호환 위해 파싱은 하되 런타임에서 세션 값으로 덮어씀). `model`/`effort`도 세션 값을 쓰므로 매니페스트 값은 무시.
- `SubAgentManager` / `SubAgentInstance`: `createProcess(def.provider)` 대신 **세션 provider**로 프로세스를 만들고, spawn 시 **세션 model/effort**를 넘긴다.
- **와이어링**: [open route](../../src/app/api/sessions/[id]/open/route.ts)는 `spawnAll()`을 부르는 지점에서 이미 `provider`/`effectiveModel`/`finalEffort`를 갖고 있다. `SessionInstance`를 거치지 않고 **`spawnAll(provider, model, effort)`로 직접 전달**한다. (대안: `SubAgentManager` 생성자에 세션값 getter를 주입. open route 인자 전달이 더 단순.)
- `bridge_define_subagent` ([MCP 서버](../../src/mcp/claude-play-mcp-server.mjs)): `provider:"claude"` 하드코딩 제거, description의 "v1: Claude provider only" 문구 제거, **`model` 입력 필드 제거**(서브는 세션 모델을 그대로 쓰므로 빌더가 지정할 여지 없음). 서브가 세션 provider/모델을 따라간다는 설명으로 교체.
- `builder-prompt.md`의 `## 서브에이전트` 섹션: "Claude 전용 / claude-haiku 권장" 안내를 "서브는 세션을 연 provider/모델로 자동 실행" 으로 정정.

### 3.2 role 전달: 균일 leading-message

`buildSubSystemPrompt(def, instructions)`가 만드는 role 계약(나레이터 아님 / 공유 상태 액추에이터 / `report_to_main` 통지 등)을 **시스템 프롬프트가 아니라 서브 대화의 첫 메시지로 주입**한다.

- `SubAgentInstance`에 `private primed = false` 추가.
- `dispatch(task)`:
  - 첫 디스패치(`!primed`): `send(roleContract + "\n\n--- TASK ---\n" + task)` 후 `primed = true`.
  - 이후: `send(task)` (resume 히스토리가 role을 유지).
- `start()`의 `appendSystemPrompt` 인자 의존을 제거한다(균일 경로). Claude도 leading-message를 쓴다. (선택: Claude엔 보너스로 system-prompt도 함께 줄 수 있으나, 분기를 없애기 위해 **주지 않는다**.)
- **Antigravity 특이사항**: Antigravity는 spawn primer(process-local)가 자연스러운 leading 채널이다. role을 primer로 실어도 첫 `SendUserCascadeMessage`로 실어도 기능상 동일하다. 구현은 균일 경로(첫 dispatch prepend)를 따르되, primer 자리에는 기존 `_BRIDGE_INIT_` placeholder를 유지한다.

**상속 한계(수용)**: 서브는 공유 cwd에서 메인 나레이터의 instruction 파일(`CLAUDE.md`/`GEMINI.md`/`AGENTS.md`)을 base context로 상속한다. 이는 **v1이 이미 수용한 한계**(메모리: "서브가 narrator CLAUDE.md 상속, role preamble이 가드")이며, leading-message의 role 계약이 동일하게 가드한다. 새로운 문제가 아니다.

### 3.3 파일 충돌 해소 (cwd 공유 유지)

서브와 메인이 cwd(세션 디렉토리)를 공유하므로, 같은 provider일 때 프로세스별 산출 파일이 충돌할 수 있다.

- **로그 (수정 필요)**: v1이 Claude에 `logName` 7번째 인자를 추가했지만, **Gemini/Kimi/Codex/Antigravity는 `logName`을 무시하고 cwd에 `gemini-stream.log`/`kimi-stream.log` 등을 하드코딩**한다([gemini-process.ts:135](../../src/lib/gemini-process.ts), [kimi-process.ts:107](../../src/lib/kimi-process.ts)). 같은 provider 메인+서브가 동시에 같은 로그 파일에 append → 인터리브/혼선. **각 provider의 로그 경로를 `logName`(있으면)으로 배선**한다. 서브는 `subagents/{name}/sub.log`에 기록.
- **Kimi agent-file (자동 해소)**: leading-message로 가면 `--agent-file`을 쓰지 않으므로 `cwd/.kimi/claude-play-agent.yaml` 시스템 프롬프트 파일을 안 쓴다 → 충돌 소멸.
- **MCP 설정 (변경 불필요)**: 공유 cwd에서 모든 provider가 자동 상속한다(Claude `--mcp-config cwd/.mcp.json`, Kimi `--mcp-config-file`, Gemini `.gemini/settings.json`, Codex `.codex/`). 서브는 cwd만 공유하면 MCP 접근을 공짜로 얻는다.
- **resume (변경 불필요)**: `SubAgentInstance`가 provider sessionId를 서브별 `subagents/{name}/.resume`에 격리 저장(이미 됨).

### 3.4 reap / 수명

- 서브는 spawn 직후 `registerSubProc(pid, sessionId, name, sessionDir)`로 PID를 등록하고 destroy/exit에서 해제한다(정상 경로 변경 없음).
- **비-Claude orphan**: cmdline-dir 기반 2차 reap은 비-Claude 프로세스(특히 file-based MCP라 cmdline에 세션dir이 안 들어가는 경우)를 못 잡을 수 있다. 정상 경로(PID 등록/해제)는 동작하므로 dev 서버 재시작 중 죽은 고아만 영향. 문서화하고 후속 과제로 남긴다.
- **Antigravity orphan**: 기존 `data/.runtime/agy-procs.json` 등록 + `killAgyForDir`가 dir 단위로 모든 agy를 reap하므로 메인+서브 agy 모두 커버된다([antigravity-orphan-pid-registry 노트]). 서브 agy도 spawn 시 동일 레지스트리에 등록되는지 확인.

## 4. 영향 받는 파일

| 파일 | 변경 |
|---|---|
| `src/lib/subagent-manifest.ts` | `PROVIDERS` 게이트 제거; `provider`/`model`/`effort` 매니페스트 값 무시(파싱은 유지) |
| `src/lib/subagent-instance.ts` | 세션 provider로 `createProcess`; leading-message(`primed`); spawn에서 세션 model/effort 사용; `appendSystemPrompt` 의존 제거 |
| `src/lib/subagent-manager.ts` | `spawnAll(provider, model, effort)` 시그니처; 서브에 세션값 전달 |
| `src/app/api/sessions/[id]/open/route.ts` | `spawnAll(provider, effectiveModel, finalEffort)` 호출 |
| `src/lib/gemini-process.ts` | `logName` 배선(로그 경로) |
| `src/lib/kimi-process.ts` | `logName` 배선; (agent-file은 leading-message 시 자연 미사용) |
| `src/lib/codex-process.ts` | `logName` 배선 |
| `src/lib/antigravity-process.ts` | `logName` 배선; primer 흐름 확인 |
| `src/mcp/claude-play-mcp-server.mjs` | `bridge_define_subagent`에서 `provider`/`model` 제거, description 정정 |
| `data/builder_skills/.../builder-prompt.md` (또는 소스) | `## 서브에이전트` 섹션 정정 |
| `docs/session-lifecycle.md` | v2 동작 + 잔여 한계 갱신 |

## 5. 테스트 / 검증

자동 테스트 프레임워크는 없다. 검증은 (a) `tsc` 그린, (b) **라이브 스모크**로 한다.

- `npm run build`는 라이브 `.next` 때문에 자제 → 최소 `npx tsc --noEmit`로 타입 그린 확인.
- **라이브 스모크 (provider별 1회)**: 서브 1개를 가진 페르소나를 각 provider 모델로 세션 생성/Open → 메인 1턴 → autoTrigger로 서브 dispatch → 서브가 MCP로 variables 변경 → `[SUB:name]` 요약이 다음 유저 턴에 합류하는지 확인. 같은 provider 메인+서브 조합에서 로그 충돌(인터리브) 없는지 `subagents/{name}/sub.log` 분리 확인.
- 단일 사용자 라이브 서비스이므로 스모크는 **사용자가 수동 실행**(자율 실행 안 함).

## 6. 리스크 & 완화

- **leading-message 고정력 < 시스템 프롬프트**: 단호한 문구 + 첫 dispatch 재주입으로 완화. 긴 세션 compaction 시 희석 가능 → 주기적 재주입은 후속.
- **Antigravity 불안정성**: PowerShell spawn·primer·Pro Low tool-call 깨짐이 서브에서도 그대로 드러남. Flash/Pro High 권장은 메인과 동일하게 적용. 라이브 스모크 부담 큼.
- **비-Claude orphan reap 공백**: §3.4 문서화. 정상 경로는 OK.
- **하위호환**: 기존 v1 페르소나의 `subagents.json`은 `provider:"claude"`를 갖지만 무시되고 세션 provider로 덮어쓰므로, Claude 세션에서 종전과 동일하게 동작한다.

## 7. 롤아웃

브랜치 `feat/persona-subagent-orchestration`에 이어서 커밋. v1과 함께 사용자 라이브 검증 후 main 머지(아직 미배포 상태).
