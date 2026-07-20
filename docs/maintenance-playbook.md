# Maintenance Playbook — 유지보수 플레이북

> **독자**: 이 리포를 유지보수하는 모든 AI 에이전트와 사람.
> **목적**: 코드만 읽어서는 알 수 없는 지식 — 함정, 설계 이유, 디버깅 절차 — 를 한곳에 보존한다.
> 이 문서의 각 항목은 실제 장애·디버깅 세션에서 비용을 치르고 얻은 것이다. "이상해 보이는" 코드를 고치기 전에 반드시 여기서 해당 항목을 확인할 것.
>
> 작업 전 필수 절차는 [pre-merge-checklist.md](pre-merge-checklist.md), 미완료 작업 현황은 루트 [HANDOVER.md](../HANDOVER.md) 참고.

## 0. 철칙 (Golden Rules)

1. **모든 코드 변경 후 `npm run typecheck`** (~6초). 머지 전에는 `npm run verify`와 `npm run build`(~62초). 테스트 프레임워크가 없으므로 TS strict가 유일한 자동 게이트다.
2. **production 서버가 살아있는 동안 `npm run build` 금지** — 빌드가 서빙 중인 `.next/`를 덮어쓴다. tsc + 리뷰로 검증하고, 재기동 시점에 빌드하라 (`node scripts/restart.mjs`가 빌드+재기동을 함께 처리).
3. **`data/`는 라이브 유저 데이터다** (gitignored, 재생산 불가). 삭제·초기화 금지. `git clean -fdx`는 `data/`와 `.env.local`을 파괴한다 — 절대 실행 금지.
4. **페르소나 디렉토리 안의 `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`를 손으로 편집 금지** — 빌더 실행 시마다 `builder-prompt.md`로 덮어써진다. 세션 모드 지시문은 `data/sessions/{id}/`에 별도 조립된다.
5. **외부 도구가 읽는 JSON은 node `fs`/Write 도구로만 쓸 것.** PowerShell 5.1 `Set-Content -Encoding utf8`은 BOM을 붙여 Go 파서(agy)를 깨뜨린다 (`settings file is malformed: invalid character '﻿'`). 검출: `npm run lint:data`.
6. **삭제는 soft-delete다.** `DELETE /api/personas/*`, `/api/sessions/*`는 `data/deleted_personas/`, `data/deleted_sessions/`로 이동만 한다. 실제 정리/복구는 그 폴더를 직접 다루되, 반드시 사용자 승인 후에.
7. **동작 변경은 문서 변경을 동반한다.** 무엇을 바꾸면 어떤 문서를 갱신해야 하는지는 [change-propagation.md](change-propagation.md)가 진실의 원천이다.
8. **detached 프로세스는 서버 재시작을 살아남는다** — agy.exe, tts-server.mjs(:3341), restart 오케스트레이터, fire_ai 백그라운드 런. dev 서버를 죽여도 이들은 남는다. 프로세스 트리 종료: `cmd //c "taskkill /T /F /PID X"` (bash에서 `//c`로 이스케이프 우회).
9. **사용자와의 소통은 한국어로.** 코드 식별자·기술 용어는 원문 유지.

## 1. 검증 사다리 (Verification Ladder)

약한 판단력을 보완하는 기계적 검증 수단. 아래 순서로, 위에서부터:

| 단계 | 명령 | 소요 | 언제 |
|------|------|------|------|
| 1 | `npm run typecheck` | ~6s | 모든 코드 편집 직후 |
| 2 | `npm run verify` | ~30s | 커밋 전 (typecheck + lint:data + check:static + smoke 통합 — 리포 코드 게이트) |
| 3 | `npm run build` | ~62s | main 머지 전 (next build 고유 실패 — route export 형태 등 — 를 잡는 유일한 단계) |
| 4 | 라이브 스모크 | 수동 | 세션 런타임·프로바이더·hot-path 파일 변경 시 (아래 §1.2) |

- 단독 테스트 파일이 몇 개 있다 (프레임워크 없음, 직접 실행): `npx tsx src/lib/inline-formatter.test.mts`, `npx tsx --test src/lib/session-state.test.ts src/lib/modal-merge.test.ts`. 해당 모듈을 건드리면 반드시 실행.
- `npm run lint:persona`는 verify에 **불포함** — 라이브 페르소나(유저 데이터)에 legacy 스키마 finding이 상존한다. 페르소나 저작/수정 시에만 해당 페르소나 대상으로 사용하고, 기존 finding을 승인 없이 고치지 말 것.
- `npm run smoke`는 절대 서버를 직접 띄우지 않는다 (server.ts는 import 시점에 GPU 매니저 포트 킬 + stale agy 킬 부수효과가 있어 두 번째 인스턴스 기동은 라이브 세션을 파괴한다). 로그인 프로브는 실행당 1회 — 분당 5회 rate limit이 있으니 verify를 1분에 4회 이상 돌리지 말 것.
- tsconfig는 `data/`와 `scratch/`를 exclude한다 — RP 세션이 세션 디렉토리에 남긴 `.ts` 파일이 빌드를 깨는 것을 막는 펜스. **typecheck/build가 `data/` 안 파일 때문에 실패한다면 네 코드 탓이 아니라 펜스가 뚫린 것이다.**

### 1.1 hot-path 파일 (tsc만으로 불충분, dev 서버 스모크 필수)

`session-instance.ts`, `session-manager.ts`, `antigravity-process.ts`, `codex-process.ts`, `kimi-process.ts`, `session-registry.ts` — 이들의 동작 변경은 typecheck 통과 ≠ 동작 보장. dev 서버를 띄우고 실제 세션으로 확인하라.

### 1.2 라이브 스모크 절차

```bash
npm run dev          # 또는 npm run dev:lite (TTS/GPU Manager 없이)
npm run smoke        # 서버 헬스 프로브 (서버 없으면 SKIPPED)
```

수동 확인 (변경 부위에 해당하는 것만):
- **세션 open**: 브라우저에서 세션 열기 → 오프닝 렌더 → 메시지 1회 왕복
- **패널**: 변수 바뀌는 행동 → 패널 실시간 갱신 확인 (안 되면 §5.3)
- **MCP**: AI에게 `bridge_status` 호출시켜 도구 목록 확인
- **프로바이더별**: 해당 프로바이더 신규 세션 1회 왕복 + `{provider}-stream.log` 확인

### 1.3 인증 우회 (curl 디버깅)

`ADMIN_PASSWORD`가 설정된 배포에서 쿠키 없는 API 호출은 401. 단, **middleware는 `x-bridge-token` 헤더의 존재만 확인**한다 (Edge Runtime에서 `validateInternalToken` 호출 불가 — 실제 검증은 각 라우트가 명시적으로 할 때만):

```bash
curl -H "x-bridge-token: anything" http://127.0.0.1:3340/api/service/status
```

- 이 특성은 로컬 디버깅용으로 의도된 것이다 (MCP는 로컬 전용, 실토큰은 랜덤 64-hex). **라우트를 하드닝할 때 middleware가 토큰을 검증했다고 가정하지 말 것.**
- `/api/setup/status`는 인증 없이 접근 가능한 가장 싼 헬스 프로브.

## 2. Windows 함정

1. **리포 경로에 공백** (`C:\repository\claude bridge`) — 셸 명령에서 항상 따옴표. codex `-c` TOML 주입이 깨진 원인이기도 하다 (§4.2).
2. **taskkill**: bash 도구에서 `cmd //c "taskkill /T /F /PID X"`.
3. **PS 5.1 BOM**: 철칙 #5. 복구는 node로 선두 `﻿` 제거 후 재기록.
4. **파일 잠금**: 다른 프로세스가 파일을 쥐고 있으면 EBUSY/EPERM/ENOTEMPTY — `src/lib/fs-retry.ts`의 `retryOnWindowsLock<T>()`이 지수 백오프로 흡수한다. 스킬 복사, sync, 페르소나 삭제 경로에 이미 적용됨. 새 파일 조작 코드에도 적용할 것.
5. **미러/퍼블리시 경로는 `*.tmp`(원자적 쓰기 임시파일)와 `background-*.log`를 skip해야 한다** (fs-mirror가 후자는 이미 skip).
6. **Blackwell GPU (RTX 50xx, sm_120)**: `setup.js`의 cudaTag 매핑이 cu124에서 멈춰 있어 50시리즈는 cu126+(권장 cu130) 수동 설치 필요. comfy_kitchen 최적화 백엔드는 cu130 미만에서 비활성. 이 머신: RTX 5070 Ti, ComfyUI는 `f:\repositories\comfyui\comfyui_submodule\` 자체 venv(torch 2.12.0+cu130).

## 3. 흔한 증상 → 첫 확인 지점

| 증상 | 먼저 볼 곳 |
|------|-----------|
| "고쳤는데 여전히 안 됨" (production) | `.next/BUILD_ID` mtime vs 편집 시각 — stale build. `node scripts/restart.mjs`로 재빌드+재기동 (로그: `data/restart-build.log` 등, **repo 루트 아님**) |
| "고쳤는데 여전히 안 됨" (dev) | API 라우트면 `.next/` 삭제 후 재시작; 프론트면 브라우저 하드 리프레시 (Ctrl+Shift+R) |
| agy가 settings 파싱 실패 | JSON 선두 BOM (`npm run lint:data`) |
| 세션 삭제가 EBUSY | 고아 agy.exe가 세션 폴더 점유 — `data/.runtime/agy-procs.json` 레지스트리 기반 reap이 정상 경로지만, 레지스트리 이전/유실 고아는 수동 `taskkill /F /PID` |
| 패널이 갱신 안 됨 | §5.3 (variables.json watch / shared 패널 templateCache) |
| MCP 도구가 안 보임 | 세션 **재-open** 필요 (MCP config·스킬은 open 시에만 재기록/복사). curl 폴백은 해법이 아님 — 브릿지 도구 다수는 REST 등가물이 없고 인증도 MCP 토큰 경유가 정답 |
| API가 전부 401 | §1.3 |
| `[system] 직전 응답이 누락되었습니다…` 유령 메시지 | Antigravity 전용 silent retry — 빈 턴(세그먼트 0, 도구 0)에 1회 nudge하는 정상 동작 (`session-instance.ts` processResult) |
| 이전 이미지가 다음 응답에 또 렌더됨 | agy wake-up echo (§4.4.5) |

## 4. 프로바이더 심화 노트

세션 런타임 5종의 개요는 [session-lifecycle.md](session-lifecycle.md), 모듈 지도는 [architecture.md](architecture.md). 여기는 **왜 그렇게 되어 있는지**와 **디버깅 방법**만 다룬다.

### 4.1 Claude (`claude -p`)

- **AskUserQuestion은 헤드리스에서 턴 내부적으로 자동 거부된다** (CLI가 합성 tool_result `{is_error:"Answer questions?"}` 주입 — TTY picker 없음). 따라서 stdin으로 tool_result를 보내는 것은 죽은 no-op. 해법: `submitToolAnswer`가 답변을 평문 user 메시지 `[질문 응답]\n- <question>: <label>`로 전달 (`session-instance.ts` formatToolAnswerForAI).
- 카드 렌더링 연쇄 함정 (재발 시 체크리스트):
  - `content_block_start`의 tool_use는 **빈 input `{}`** 으로 도착하고 실제 input은 `input_json_delta`로 스트림된다 — tool dedup 로직은 같은 id 항목을 **더 긴 input으로 갱신**해야 한다. 아니면 카드가 generic ToolBlock으로 굳는다.
  - React: **동기적으로 리셋되는 ref를 deferred state updater 안에서 읽지 말 것** — `finishAssistantTurn`이 setMessages 큐잉 후 toolsRef를 동기 리셋 → 턴 종료 시 카드 전멸 버그의 원인이었다.
  - 카드를 렌더하는 모든 페이지는 ① `ChatMessages`에 `sessionId` 전달 (없으면 `/api/sessions//tool-answer` 404로 침묵 실패) ② WS `tool:answered` 이벤트 처리 (없으면 답변 후 카드가 안 접힘) 둘 다 필요.
- **ultracode**: 실체는 `--effort xhigh` + env `CLAUDE_CODE_WORKFLOWS=1`(Workflow 도구 게이트) + append-system-prompt. `resolveClaudeEffort()`가 모델 선택기의 의사-effort `opus:ultracode`를 번역한다 (`ai-provider.ts` 주석에 바이너리 분석 근거). 헤드리스 spawn에서 Workflow 도구 노출은 **라이브 미검증** (HANDOVER 참고).

### 4.2 Codex (`codex app-server`)

- **`codex exec`가 아니라 `codex app-server`** (persistent JSON-RPC 2.0). Windows에서 `shell: true` 필수.
- **config는 `$CODEX_HOME/config.toml`에서만 읽는다** — cwd의 `.codex/config.toml`은 **읽지 않는다** (codex-cli 0.124.0 검증). 그래서 spawn 시 `CODEX_HOME`을 세션 `.codex/`로 리포인트하고 `~/.codex/auth.json`을 복사해 넣는다 (`codex-process.ts`). 이걸 모르고 "cwd에 config 있으니 되겠지"라고 가정하면 세션 MCP와 model_instructions_file이 **조용히 죽는다** (실제로 몇 주간 발견 못 한 사고).
- **`-c` 플래그로 TOML 배열 주입 금지**: `shell:true` 하에서 cmd.exe가 TOML 배열 값 내부 따옴표를 벗겨 `expected a sequence` 파스 에러. 스칼라 `-c` 오버라이드(sandbox·model_reasoning_effort·external 게이트웨이 설정)는 현재도 spawn 인자로 사용 중이다 (`codex-process.ts`). 배열이 필요한 per-session 설정(mcp_servers 등)은 언제나 세션 `.codex/config.toml` + CODEX_HOME 리포인트로.
- 외부 게이트웨이 (`external/` prefix 모델): Responses API 필수 — `wire_api="chat"`은 codex-cli 0.124.0+ 미지원. 상세는 [external-llm-routing.md](external-llm-routing.md).
- **선택기에 신규 모델을 추가하기 전에 로컬 CLI 버전을 확인할 것.** 모델 지원은 CLI 버전에 묶여 있고, 구버전은 **thread/start·turn/started까지 정상 진행한 뒤** API가 400으로 거절한다 — UI에서는 "스트리밍이 시작됐다가 응답 없음"으로 보인다. 로그 증거는 세션 `claude-stream.log`의 ``Model metadata for `X` not found`` 경고 + ``The 'X' model requires a newer version of Codex``. 2026-07-21 사고: codex-cli 0.124.0에 `gpt-5.6-sol` 추가 → 전 턴 실패. `scripts/check-static.mjs`의 `MIN_CLI_VERSIONS`에 최소 버전을 걸어두면 커밋 전에 WARN으로 잡힌다(모델 추가 시 이 값도 갱신할 것).
- **`turn/completed`의 결과는 `params.turn` 아래에 중첩된다** (`params.turn.status` / `params.turn.error.message`). 최상위 `params.status`를 읽으면 항상 undefined라 **모든 턴 실패가 조용히 정상 완료로 처리된다** — 위 400 사고에서 사용자에게 아무 에러도 안 보였던 직접 원인(2026-07-21 수정, 회귀 테스트 `src/lib/codex-process.test.mts`). 실패 원인은 `error.message` 안에 JSON *문자열*로 한 겹 더 싸여 있어 `extractCodexErrorMessage()`로 벗겨야 사람이 읽을 수 있다.

### 4.3 Kimi (`kimi --wire`)

- 세션 id 캡처는 **cwd+mtime 휴리스틱** (`findKimiSessionId`). 서브에이전트가 세션 cwd를 공유하므로 메인이 서브의 대화 id를 주울 수 있음 → per-spawn **sticky resolvedSessionId** 가드 (한번 정해지면 이후 휴리스틱 id 무시, `kimi-stream.log`에 `[session] ignored heuristic id X (sticky: Y)` 기록). 잔여 레이스: 서브 있는 kimi 세션의 **첫** open에서 sticky가 잘못 고정될 가능성 — 라이브 미검증. 의심되면 `session.json`의 kimiSessionId가 메인 대화 것인지 위 로그로 확인; 실제로 틀리면 메인 sessionId 방출까지 서브 spawn을 지연시키는 것이 수정 방향.

### 4.4 Antigravity (agy) — 가장 특이한 런타임

agy는 persistent stream이 아니라 **폴링 래퍼**다: PowerShell로 백그라운드 spawn한 agy.exe의 in-process Language Server(HTTPS+ConnectRPC, 랜덤 포트)에 직접 RPC를 친다 — agy가 `--prompt-interactive`로 자동 생성한 캐스케이드를 `GetAllCascadeTrajectories`로 발견 → `SendUserCascadeMessage` → `GetCascadeTrajectory` ~700ms 폴링 (`POLL_INTERVAL_MS`).

#### 4.4.1 spawn — 절대 다른 프로바이더와 통일하지 말 것
agy.exe는 Go bubbletea TUI라 Windows CONIN$/CONOUT$ 콘솔 핸들이 필요하다. Node `child_process.spawn`은 detached/windowsHide 모든 조합에서 실패 (`could not open TTY`, **exit 0이라 성공처럼 보임**). 유일한 해법: **PowerShell `Start-Process -WindowStyle Hidden`**. 한글/비ASCII cwd는 두 겹 대응 필수: ① 생성하는 `.ps1`에 UTF-8 BOM 부착 (없으면 PS 5.1이 CP949로 읽어 mojibake) ② `Start-Process -WorkingDirectory` 대신 `Set-Location -LiteralPath` (전자는 와일드카드 해석을 해서 mojibake 경로에서 실패). spawn 실패 진단: 세션 디렉토리 `antigravity-stream.log`의 `spawn powershell failed:` 라인 (Start-Process 방식이라 agy 자체 stdout은 캡처되지 않는다).

#### 4.4.2 모델 키는 버전마다 바뀐다 — 하드코딩 금지
모델 id는 `MODEL_PLACEHOLDER_M{N}` 형식인데 N이 agy 버전마다 바뀐다 (1.0.2: Pro High=165 → 1.0.5: 37; 하드코딩했다가 `unknown model key` 로 캐스케이드 전멸). `resolveModelKeyDynamic()`이 매 spawn마다 `GetAvailableModels`의 displayName 매칭으로 재해석하고, **전체 문자열을 그대로** `requestedModel.model`에 넣는다 (숫자만 보내면 실패). 로그와 trajectory에서 같은 캐스케이드가 다른 M-인덱스로 보일 수 있음 — LS 인스턴스별 동적 렌더링이지 에러가 아님.

#### 4.4.3 RPC 입력 스키마 — 조용한 유실 주의
`SendUserCascadeMessage`의 `items`는 `TextOrScopeItem[]` — 정답은 **`items:[{text}]`**. 옛 `items:[{chunk:{text:{content}}}]` 형태는 protobuf DiscardUnknown으로 **200 OK를 반환하면서 조용히 버려져** USER_REQUEST가 비고, 모델은 빈 턴을 받아 파일을 뒤지며 환각한다. **agy 마이너 업그레이드 후에는 반드시** 신규 세션 스모크 + brain transcript의 `<USER_REQUEST>` 비어있지 않음 확인 (1.0.2→1.0.5에서 payload 형태와 모델 키 형식이 둘 다 조용히 깨진 전력).

#### 4.4.4 디버깅 — brain이 진실의 원천
1. 세션 디렉토리 `antigravity-stream.log`는 **우리 래퍼의 폴링 메타데이터만** 담는다 — 실제 스텝 내용 없음.
2. 진실은 agy brain 저장소: `~/.gemini/antigravity-cli/brain/{cascadeId}/.system_generated/logs/transcript.jsonl` + `transcript_full.jsonl` — 에러 포함 전체 스텝 본문, 그리고 모델이 자기 행동을 영어로 해설하는 `thinking` 필드 (이 자기해설이 wake-up echo·첫응답 중복 버그를 풀었다).
3. 라이브 LS 프로브: `curl -sk -X POST -H "Content-Type: application/json" -d '{"cascadeId":"<cascadeId>"}' https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory` — 스텝별 plannerResponse·타임스탬프 (타임스탬프가 중복응답 버그의 결정적 증거였다).
4. LS RPC 메서드 열거: agy.exe 바이너리를 latin1로 읽어 `LanguageServerService/[A-Z]\w+` 패턴 grep. proto 필드명도 같은 방식 (rawDesc 근처 ASCII).
5. **외부에서 LS에 직접 SendUserCascadeMessage를 쏘는 프로브는 무효** — dev 인스턴스가 캐스케이드를 관리 중이라 레이스로 스텝이 안 생긴다. 반드시 우리 경로(`POST /api/sessions/{id}/open` + `POST /api/chat/send`)로 실험할 것.
6. 실험용 spike 스크립트들이 `scripts/spike-agy-*.ts`로 보존돼 있다 (spawn 방식 비교, 프라이머 주입 검증, roundtrip 스모크 등).

#### 4.4.5 알려진 미해결·주의 사항
- **wake-up echo**: async 도구(이미지 등) 완료 시 agy가 task-completion 이벤트를 주입하고 모델이 이를 복창하며 `$IMAGE:...$`를 반복 → 직전 이미지가 다음 응답에 또 렌더. `stripSystemMessageEcho`(4종 정규식, 한/영·장/단)가 제거하되, **영어 변형 1종이 미포착** ("All background tasks related to the initial API calls have now completed...") — 단 이 문장이 ERROR_MESSAGE 본문 안에서 발견됐으므로 **나이브하게 strip 패턴을 추가하면 에러 컨텍스트를 삭제할 수 있다**. 수정 시 재시작+라이브 검증 필수. 또한 closing phrase는 별도 패턴이어야 함 (alternation에 넣으면 lazy quantifier가 첫 히트에서 멈춤).
- **primer 선행 플레이**: 신규 세션의 `--prompt-interactive` primer 턴에서 모델이 유저 입력 전에 오프닝 선택지를 먼저 플레이할 수 있고 **실제 MCP 도구 호출까지 한다** (scout_market이 실데이터를 변조한 사례). 중복 누출은 `syncTailBaseline` 3개소로 수정됐지만 **엔진 부수효과는 여전히 가능** — primer를 "짧은 준비 완료 응답만 하라"로 강화하는 것이 후속 과제.
- **GEMINI.md는 agy가 자동 로드하지 않는다** (988스텝 transcript 검증). 지시문은 primer(USER_INPUT step 0)로 전달되고 resume에도 cascade 히스토리로 살아남는다. resumed agy 세션에 영향을 주려고 GEMINI.md를 고치는 것은 no-op일 가능성이 높다. 실제 결함은 primer 28,000자 절단(`MAX_PRIMER_CHARS`, Windows CreateProcess 32767자 한계)과 장기 캐스케이드 compaction. 관련 미머지 브랜치 주의사항은 HANDOVER 참고.
- **격리 시도 금지**: `--gemini_dir`/`--app_data_dir`로 agy를 격리하면 cascade-ID 호환이 깨지고 모델이 환경 탐사 폭주 — 이미 시도·revert됨. 재시도하지 말 것.
- **버전 민감 사항**: 1.0.2에서 Pro Low 티어는 tool-call 인자 손상으로 불안정 (Flash·Pro High는 안정) — agy 업데이트 후 티어 안정성 재확인. agy에는 빌트인 `default_api:generate_image`가 있어 우리 MCP 이미지 도구가 거부/부재면 조용히 그쪽으로 폴백한다.
- **개선 리드**: LS에 스트리밍 RPC가 존재한다 (`StreamCascadeReactiveUpdates` 등) — 폴링 전면 대체 후보.

### 4.5 공통 패턴

- **fire_ai/서브 readiness**: `waitForReady(20s)===false`는 실패가 아니다 — agy는 primer 응답 대기로 20초를 상습 초과한다. **`!isRunning()`일 때만 abort**하고, 살아있으면 `send()`를 그냥 호출 (각 프로바이더의 send가 자체 readiness 대기를 수행). child PID는 spawn 직후 1회 캡처해 둘 것 (settle 시 내부 proc이 null로 바뀌어 나중에 재계산하면 -1).
- **`await waitForIdle()` 후에는 macrotask(`setImmediate`) yield 후 가드 재검사** — 공유 idle/이벤트 신호로 깨어난 코드가 공유 상태(큐, pending 플래그)를 검사하기 전에 microtask들을 전부 배수시켜야 co-waking 유저 턴이 먼저 flush된다. microtask hop 수는 안정된 순서 보장이 아니다 (autoResume 이중발화 버그의 교훈, `9286e18`).

## 5. 서브시스템 지뢰

### 5.1 variables.json 쓰기는 원자화됐다 — 단 per-file watch와의 긴장은 살아있다
`session.json`과 `variables.json` 모두 원자적 tmp+rename으로 쓴다 (훅 경로는 `mutateSessionJsonSync`, 라우트 경로는 `mutateSessionJson`+뮤텍스 — `session-state.ts`의 `atomicWriteJsonSync`). session.json은 SYSTEM_JSON이라 디렉토리-watch에서 skip돼 watcher-safe가 검증됐지만, `variables.json`은 panel-engine이 per-file `fs.watch`로 감시하며 watcher 재장전 로직이 없다 — Windows에서 rename-replace가 per-file watch를 조용히 죽일 수 있다 → 라이브 패널 갱신 정지. **variables 쓰기 경로를 바꾸면 반드시 런타임 검증(변수 변경 → 패널 갱신 확인)을 동반할 것.** 잔여 raw `fs.writeFileSync`는 comfyui update-profile 라우트와 세션 elements sync 경로뿐이다. 함정 경고 주석이 `session-manager.ts`의 patchSessionMeta 근처에 있다.

### 5.2 메인 훅 ↔ 서브에이전트 쓰기 레이스
메인의 `runAssistantHooks`는 동기(`mutateSessionJsonSync`, 뮤텍스 우회), 서브는 라우트 경유 async(뮤텍스 적용)로 `variables.json`을 쓴다. 파일 손상은 없지만(원자적 rename) **lost update** 가능. 회피: 매니페스트 `writes[]`에 맞춰 메인 훅과 서브가 서로 다른 변수/파일을 쓰도록 페르소나를 구성.

### 5.3 패널 갱신이 멈추는 두 가지 경로
1. **variables.json watch 단절** (§5.1의 리스크가 현실화된 경우) — 세션 재-open.
2. **shared 패널 templateCache**: `data/tools/{tool}/panels/*.html`은 **모든** 페르소나 세션에 자동 mount되는데 이 디렉토리는 watch 대상이 아니다 — 파일 이동/수정 후 세션 재-open 또는 서버 재시작 필요. 그리고 **페르소나 전용 패널을 `data/tools/`에 두면 절대 안 된다**: 그 패널의 actions가 전 세션에 등록돼 `[AVAILABLE]` 헤더가 유저 메시지를 묻어버린다. `data/tools/`에는 action 없는 진짜 공용 패널만 (service-status, profile-crop). 잘못 등록된 것은 `data/tools/{tool}/panels.removed/`로 soft-delete.

### 5.4 이미지 생성 게이트 — 4개소 동시 수정 규칙
기본 이미지 백엔드는 ComfyUI(`generate_image`)뿐이고 Gemini/GPT는 **사용자가 콕 집어 요청할 때만**. 이 게이트는 4곳에 분산돼 있어 함께 고쳐야 한다: 스킬 2개(`data/tools/comfyui/skills/generate-image-gemini`·`data/tools/openai/skills/generate-image-openai`의 SKILL.md desc+본문) + MCP 도구 desc 2개(`claude-play-mcp-server.mjs`). ⚠️ `data/tools/gemini/skills/generate-image-gemini/SKILL.md`에 게이트 없는 동명 사본이 남아 있고, 세션 open 복사가 알파벳 순 덮어쓰기라 세션에는 이 무게이트 사본이 최종 반영된다 — 게이트 수정 시 이 사본도 함께 정리할 것. 스킬/MCP desc는 세션 재-open에만 반영된다.

### 5.5 OpenAI 이미지 = Codex 구독 백엔드 (기본)
`OPENAI_IMAGE_BACKEND=codex`(기본)는 `codex exec`의 빌트인 image_gen으로 렌더 (건당 $0, 느림 — 이미지당 codex 에이전트 풀 턴, 플랜 rate limit 소모). 함정: ① `OPENAI_IMAGE_MODEL`은 **오케스트레이션 모델**(gpt-5.5 등)이지 이미지 모델이 아니다 (api 백엔드 전용, codex 백엔드 미사용) — `gpt-image-*`를 넣으면 렌더러로 간주하고 오케스트레이션을 gpt-5.5로 폴백하는 자가 교정이 있다 (렌더러 핀은 `OPENAI_IMAGE_TOOL_MODEL`) ② 빈 temp cwd에서 실행 (AGENTS.md 오염 방지), prompt는 stdin (긴 argv는 shell:true에서 깨짐), child env에서 `OPENAI_API_KEY` **삭제** (구독 전용 렌더 강제) ③ `$CODEX_HOME/generated_images/`에서 mtime 스냅샷 diff로 `ig_*.png` 하베스트 — 동시 생성 시 오귀속 가능 (싱글유저라 수용).

### 5.6 스킬 전파는 세션 open 시점
`data/skills/*`(글로벌) + `data/tools/{name}/skills/*`(도구)가 세션 open 시 `refreshToolSkills()`로 복사되고 `SKILL.md`/`*.sh`의 `{{PORT}}`가 치환된다. `data/builder_skills/*`(빌더)는 별개 경로다 — `/api/builder/start`·`/edit`가 페르소나 dir의 `.claude/skills/`로 복사하며 `{{PORT}}` 치환은 없다. **소스 편집은 즉시 반영 안 됨 — 세션(빌더 스킬은 빌더) 재-open 필요.**

### 5.7 inline-formatter (RP 인라인 마크다운 파서)
`src/lib/inline-formatter.ts` — CommonMark 스타일 delimiter-stack, `*` 강조 전용. 불변식: ① `processEmphasis`의 openers_bottom 버킷은 **`closer.orig`(불변 원본 런 길이)로 키잉** — 가변 잔여 카운트로 키잉하면 부분 소비된 multi-star closer가 버킷을 갈아타며 매칭 누락 ② thought-quote 닫힘은 **양쪽 이웃이 모두 Latin 문자일 때만 차단** (`don't`/`it's` 리터럴 유지 vs 한국어 조사 `'검사실'이`는 닫힘 — 이것이 유일한 구분 신호) ③ `buildNextClose`가 next-closable-quote를 선형 1패스로 예계산 — 없으면 미닫힘 따옴표마다 EOF 재스캔 = O(n²) 동기 렌더 행 (158KB가 34초). 변경 검증: `npx tsx src/lib/inline-formatter.test.mts` (30케이스).

### 5.8 TTS는 독립 서버로 남겨둘 것
`node-edge-tts`의 `ws` 의존성이 Next.js 런타임과 충돌한다 (in-process·child 모두 실패) — 그래서 `tts-server.mjs`가 완전 독립 HTTP 서버(PORT+1)이고 server.ts가 TTS 라우트를 인터셉트해 plain Node 컨텍스트에서 실행한다. Next 프로세스로 되돌리려 하지 말 것. `session-instance.ts`의 TTS 엔진 추출(~220줄)도 평가 후 **의도적으로 보류** — job 클로저가 매 await마다 live `this.*`를 읽어 verbatim-move 검증이 불가능한 설계 수준 리팩터다.

### 5.9 빌드 file tracer가 data/를 삼키지 않게 하라 (경로 리터럴 금지)
`next build`의 file tracer(@vercel/nft)는 번들된 라우트 코드에서 `path.join(process.cwd(), "data", ...)` 같은 **정적으로 평가 가능한 경로 표현식을 에셋 참조로 간주해 해당 디렉터리를 통째로 걷는다.** data/가 15GB(파일 수백만)라 이것만으로 빌드가 55초→4분대로 폭증했다 (2026-07-12 진단: nft.json에 691만 항목, deleted_sessions만 531만).
- **방어**: `src/lib/data-dir.ts`의 `DATA_DIR_NAME = Buffer.from([0x64,0x61,0x74,0x61]).toString()` — "data" 리터럴을 런타임 조립해 nft 정적 분석을 차단한다. **이상해 보여도 지우지 말 것.** personas images 라우트의 `IMAGES_SEG`도 동일 방어(부분 글롭 `**/images/*` 차단).
- **규칙**: 서버 코드에서 데이터 경로는 반드시 `getDataDir()` 경유. `process.cwd()`+`"data"` 리터럴 직접 조합 금지 (2026-07-12에 8개소 일괄 제거).
- **함정**: `outputFileTracingExcludes`는 결과 필터일 뿐 **디렉터리 워크 비용을 막지 못한다** (2026-05-28 "효과 없음" 실측과 일치). 재발 검사: 빌드 후 `.next/**/*.nft.json`에서 data/ 경로 항목 수 집계 — 라우트당 수 개 이하가 정상.
- 증상 재발 시 원인 탐색: `grep -rnE 'cwd\(\)[^\n]*data' src` + nft.json에서 어떤 라우트가 대량 항목을 갖는지 확인.

## 6. 작업 방법론

### 6.1 대형 파일 분해 규율 (waves 6–12에서 무회귀 검증된 방법)
테스트 없는 리포에서 안전한 분해법: **verbatim-movable leaf cluster만 추출**; public 메서드는 얇은 위임 래퍼 유지(`import { x as XxxImpl }`), private은 제거 후 콜사이트 리포인트; this-의존성은 파라미터 주입; 공유 상수는 모듈로 (type-only import로 런타임 순환 방지); 매 슬라이스마다 `tsc --noEmit` + **이동 전 커밋과의 적대적 토큰 수준 diff**. 구조 변경이 필요한 추출(라이브 this.*를 읽는 stateful 클로저 — 예: TTS 엔진)은 거부하라 — 토큰 diff 검증이 불가능해진다.

### 6.2 git 규칙
- `git stash pop`은 **자신의 push가 실제로 stash를 만들었을 때만** — 클린 트리에서 no-op push 후 pop하면 남의 기존 WIP stash를 잡아 컨플릭트를 만든다.
- 스펙/플랜을 리포에 남기려면 `docs/specs/`·`docs/plans/`에 쓸 것 — **`docs/superpowers/`는 gitignored** (절대경로·페르소나명 포함 개인 노트용)라 거기 쓴 문서는 이 머신에만 존재한다.

### 6.3 무엇을 건드리기 전에 무엇을 읽나
- 세션/프로바이더 런타임 → [session-lifecycle.md](session-lifecycle.md) + 이 문서 §4
- API 라우트 추가/변경 → [api-routes.md](api-routes.md) + [change-propagation.md](change-propagation.md)
- 데이터 파일 형식 → [data-model.md](data-model.md)
- env var 추가 → [infrastructure.md](infrastructure.md) + `.env.example`
- 패널/프론트 → [frontend.md](frontend.md), `panel-spec.md`
