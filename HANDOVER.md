# HANDOVER — 인수인계 대장

## 2026-09-08 페르소나 스킬 Open 자동 갱신 (소스 수정, 배포 대기)

- 세션 Open에서 `refreshToolSkills(sessionDir, info.persona)` 호출. 원본 skills를 4종 CLI 디렉터리에 갱신한 뒤 기존 글로벌 스킬 우선순위 적용.
- `fs-mirror.ts`의 `refreshDirectoryWithBackups`: 변경 파일은 `.skill-backups/<provider>/skills/`에 SHA256별 원본 바이트 백업. 동일 내용 재쓰기 없음, 세션 전용/원본 삭제 파일 자동 삭제 없음, 링크 경로 거부. RP 상태는 수정하지 않음.
- `fs-mirror.test.ts` 4건 통과: 중첩 리소스/한글·바이너리/백업·멱등성/원본 부재·삭제/링크 거부, 실제 SessionManager를 통한 4종 대상 및 글로벌 충돌 우선순위/RP 상태 보존. typecheck·check:docs 통과.
- **운영 서비스 재빌드·재시작 및 실제 Open HTTP/CLI 재탐색 검증은 아직 하지 않음.** 운영 `.next`를 덮어쓰지 않았으며 서버를 임의 재시작하지 않음. 배포 시 정지→빌드→기동 경로 사용. 실행 중 프로세스를 재사용한 페이지 새로고침은 새 스킬 캐시 갱신을 보장하지 않음.
- 다른 사용자 미커밋 변경은 보존. 커밋/푸시 없음. → **2026-09-12 main에 커밋 완료(푸시 미실행).**

## 2026-09-08 빌더 대화 기록 누락 수정

- **19:33 KST 운영 반영 완료:** 기존 REST 재시작 API로 정지→포트 해제→빌드(37초, 성공)→production 시작. PID 16112, BUILD_ID `FGoDbzpNbuVIfH8pCa6rn`. 재오픈 후 `hist-a-13` 설명이 기록에 한 번 복구되고 draft 삭제, 다음 사용자 `hist-u-14`로 이어짐을 확인. 서버 smoke 5/5 통과. 최초 배포 직전 구 프로세스에는 자동 체크포인트 코드가 없어서 원본 provider 로그의 현재 설명을 일회성 draft로 보존한 뒤 재시작함. 새 프로세스의 자동 저장은 아래 단위 테스트로 검증됨.
- `scripts/restart.mjs`도 정지 후 빌드로 수정. 포트가 해제되지 않으면 빌드하지 않음. 빌드 실패 시 서버는 정지 상태로 남으므로 로그 확인 후 재시도 필요. MCP `bridge_restart_service`의 별도 동기 build-first 경로는 여전히 남아 있으므로 운영 반영에는 REST API를 사용한다.
- 재시작 직전 보였던 assistant 설명이 `chat-history.json`에는 없고 Codex 원본 JSONL에는 존재함을 확인. 사용자 메시지는 저장되어 있었으며, 긴 작업 중 설명이 한 assistant 응답으로 합쳐지는 것은 현재 UI의 기존 동작이다.
- `history-storage.ts`와 `SessionInstance`: 빌더 스트리밍 중 250ms 체크포인트, 블록 완료/종료/파괴 시 즉시 저장, 재오픈 시 안정된 ID로 한 번만 복구. 최종 기록 원자적 교체 및 UTF-8 BOM 보존, 배열 길이 대신 최대 ID 사용, 손상 파일 덮어쓰기 차단. 재시작 API는 체크포인트 실패 시 재시작을 취소한다.
- 테스트 11개와 `npm run verify` 통과. 수정 당시 PID 368에는 미반영이었으나 위 19:33 KST 배포로 해소. 새 자동 저장→재시작의 추가 전 구간 스모크는 별도 수행 가능.
- 기존 기록/프로바이더 로그 백업: `scratch/blender-history-backup-1788862686663/`. `recovered-assistant.json`에는 원본 로그에서 확인된 누락 문장과 시각을 별도 확보. 실행 중인 인스턴스가 덮어쓸 수 있으므로 실제 `chat-history.json`에 임의로 끼워 넣지는 않았다.
- 이전 요청의 API 재시작은 `skipBuild:true`로 08:10 UTC에 수행됨. 재시작 성공과 신규 소스/라우트 배포 완료를 혼동하지 말 것. 커밋/푸시는 하지 않음. → **2026-09-12 main에 커밋 완료(푸시 미실행).**

## 2026-09-08 Blender Master 추가 작업

- `src/lib/persona-mcp.ts` + runtime-config 4종 emitter: 로컬 SHA256 승인된 persona stdio MCP 병합. `runtime-mcp.json`은 SYSTEM_JSON에 추가. `scripts/approve-persona-mcp.mjs`로 선언 검토/승인/취소. 상세: `docs/specs/persona-mcp.md`.
- 머신 로컬 Blender 4.5.13 LTS 설치(`data/tools/blender/`, 바이너리는 내부 .gitignore로 제외). `data/personas/blender_master` 페르소나·전용 MCP·로봇 렌더 생성. 실제 stdio/Blender 생성·재열기·오류/취소·클라이언트 이탈·MCP 종료 테스트 통과. typecheck, 코어 21개 테스트, verify 통과.
- **코어 배포 완료(19:33 KST):** 서비스 정지→build→시작 수행. 실제 새 Astra 작업 세션에서 `studio_status` 확인은 별도로 필요. restart.mjs의 build-before-stop 문제는 위 후속 수정으로 해소.
- 시작부터 모델 선택기 관련 사용자 미커밋 변경이 존재했으며 그대로 보존. 이 작업은 커밋/푸시하지 않음. → **2026-09-12 main에 커밋 완료(푸시 미실행).** 페르소나 lint의 자동 생성 지시문 legacy 예제 15건은 미수정; 작성한 파일 오류는 0.

> **스냅샷 기준일: 2026-09-02** (최초 작성 2026-07-07 Claude Fable 5, 서비스 이관 전 마지막 정비 세션 — 이후 갱신은 §1·§4·§5·§8에 날짜와 함께 누적)
> 이 문서는 **시점 스냅샷**이다 — 리포의 현재 상태·미완료 작업·보류된 결정을 기록한다. 항목을 처리하면 이 문서에서 지우거나 완료 표시할 것.
> 작업 수칙·함정·디버깅 절차는 [docs/maintenance-playbook.md](docs/maintenance-playbook.md), 커밋 전 절차는 [docs/pre-merge-checklist.md](docs/pre-merge-checklist.md) 참고.

## 1. 리포 상태 (2026-09-02 기준)

- `main` == `origin/main` — 2026-09-02 문서 정비 브랜치 `docs/2026-09-02-doc-refresh-and-codebase-map`을 `--no-ff` 머지 후 후속 fixup 2건과 함께 푸시 완료, 브랜치 삭제. 로컬 브랜치는 `main` + `feat/antigravity-ruleset-persistence`.
- 워킹 트리 클린.
- src 코드에 TODO/FIXME 마커 **0개** — 미해결 항목은 전부 이 문서와 docs/에 있다.
- `npm run verify` 통과(2026-09-02, `check:docs` 포함). ⚠️ 2026-09-02 verify 시점에 `data/.server.pid`는 있으나 **포트 3340이 리스닝하지 않았다** (smoke SKIPPED: stale pid file) — 2026-09-01 18:16 기동한 프로덕션 서버가 내려간 상태. 재기동은 `node scripts/restart.mjs`(빌드 포함) 또는 `npm run start`. 서빙 빌드는 최소 `a730ccc` 이상이었다. 문서 전수 대조는 2026-09-02에 재실행(4축 병렬 감사: api-routes / architecture+MCP / frontend+data-model / infra+lifecycle+README+SETUP) — 라우트 80개·MCP 도구 24개·lib 68개·컴포넌트 40개 전부 문서와 일치했고, 설명 드리프트만 수정했다.

## 2. 브랜치·워크트리 (2026-08-26 정리 완료)

- **로컬 브랜치는 `main` + `feat/antigravity-ruleset-persistence` 2개뿐.** 머지 완료된 로컬 브랜치 16개와 워크트리 1개를 이날 전부 제거했다(전부 main에 포함돼 있어 커밋 유실 없음). `feat/openai-image-codex-backend`만 원격 추적 브랜치가 뒤처져 있어 `-D`가 필요했고, tip `12f3f40`이 main의 조상임을 확인 후 삭제했다.
- **워크트리 0개** — `.claude/worktrees/`는 비어 있다. 앞으로도 제거는 반드시 `git worktree remove`로 (수동 rm은 `.git/worktrees` 메타데이터를 남긴다).
- **원격도 `main` 하나뿐.** stale 브랜치 3개(`feat/openai-image-codex-backend`, `fix/askuserquestion-card-lifecycle`, `fix/comfyui-lora-family-visibility`)는 과거 작업 중 푸시해뒀다가 머지 후 방치된 것으로, 전부 main의 조상임을 확인하고 같은 날 원격에서 삭제했다. 앞으로 브랜치를 푸시했다면 머지 직후 `git push origin --delete`까지 하는 것을 기본으로.

## 3. ⚠️ 유일한 미머지 브랜치: `feat/antigravity-ruleset-persistence`

**그대로 머지 금지.** 커밋 fd25a50은 wave-12 리팩터 **이전**의 session-manager.ts 모놀리스를 패치한다 — 지금 머지하면 삭제된 코드가 부활한다.

- **의도**: agy 세션의 immersion 룰셋을 GEMINI.md에 영속화해 resume/primer-절단에서 살아남게 하기.
- **전제가 반박됨**: agy는 GEMINI.md를 자동 로드하지 않는다 (988스텝 transcript 적대적 분석으로 확인 — 플레이북 §4.4.5). 이 변경은 resume에 대해 no-op일 가능성이 높다.
- **재개한다면**: ① 먼저 codeword 런타임 테스트 (지시를 GEMINI.md 룰셋 섹션에만 심고 resume 후 준수 확인) ② 실패하면 실제 결함 — 캐스케이드 compaction (primer 28,000자 절단은 2026-09-14 stdin 전달 전환으로 해소) — 을 겨냥해 재설계 ③ 구현 위치는 `src/lib/runtime-instructions.ts`(`writeAntigravityInstructions`) + `respawn-helpers.ts` 콜사이트 — 옛 브랜치 diff는 참고자료로만.

## 4. 라이브 스모크 백로그 — 머지·푸시됐지만 런타임 미검증

라이브 싱글유저 서비스라 사용자 참여 하에 확인해야 하는 항목들. dev 서버 + 실제 RP 세션으로:

| # | 기능 (커밋) | 확인 방법 |
|---|-------------|----------|
| 1 | fire_ai `autoResume` (9286e18) | 백그라운드 잡 완료 시 idle이면 즉시 자발 턴, busy면 턴 종료 직후 발동. 체인 상한 `FIRE_AI_AUTORESUME_MAX`(기본 5) |
| 2 | 서브에이전트 v2.1 모델 고정 (6b4362a, 6a43f56) | 세션과 다른 프로바이더 pin (예: claude 세션 + gpt-5.4 서브) → `subagents/{name}/sub.log`에 해당 프로바이더 + `.resume-codex` 생성; 미지정 서브는 세션 상속; gemini pin은 세션 폴백 + console.warn |
| 3 | 서브 대화 모달 (e3876d5) | tools 메뉴 → 모달; 직접 메시지 → 대화형 응답 + `transcript.jsonl` 기록; auto 디스패치 흐릿한 라인; report 칩 + 다음 턴 `[SUB:]`; 서브 작업 중엔 StatusBar '작업 중' 펄스 칩에 이름 표시 (안읽음 배지는 5234c38에서 ambient 인디케이터로 대체됨) |
| 4 | agy stream-json 전환 (2026-09-14, `3eaf079`) | agy 1.2.2 CSRF로 LS RPC 전멸 → `-p "" --input-format stream-json` 파이프 상주로 교체. **2026-09-14 서버 재시작 후 사용자 실세션 동작 확인됨.** 세부 항목별 재확인이 필요하면: (a) 첫 응답 정상·primer 비노출 (b) MCP 이미지 생성 1회 (`.agents/plugins/claude-play`) (c) async 이미지 완료 후 wake-up 턴이 라이브 등장 (`antigravity-stream.log`에 `spontaneous turn started`) (d) 개입(steer) 1회 (e) fire_ai·서브 agy 1회. 단독 드라이버로는 primer·플러그인 MCP·steer·resume 검증 완료 |
| 5 | kimi 첫-open sticky id | 서브 있는 kimi 세션 첫 open에서 `session.json.kimiSessionId`가 메인 대화 것인지 (`kimi-stream.log`의 sticky 라인) — 플레이북 §4.3 |
| 6 | agy MCP (workspace plugin `.agents/plugins/claude-play/`) | agy 1.2는 `.agents/mcp_config.json`을 안 읽음 → 플러그인으로 등록. **기존 agy 세션은 재-open해야 파일이 생성됨.** 위 #4와 함께 확인 |
| 7 | ultracode Workflow 도구 | 헤드리스 빌더 spawn(`claude -p`)의 도구 목록에 Workflow가 실제로 나타나는지 |
| 8 | fire_ai 멀티 프로바이더 (260cf99) | Claude 외 모델 id로 fire_ai 1회 (예: kimi) → 결과 정상 회수 |
| 9 | variables.json 원자화 (4a7e128) | 변수를 바꾸는 행동 → 패널 라이브 갱신 확인 — per-file `fs.watch`가 rename-replace를 견디는지 (플레이북 §5.1) |
| 11 | 선택지 적중 판정 `[CHOICE_MISS]` | **기존 세션은 재-open해야 새 지시문 반영.** (a) 선택지 클릭 → 다음 턴 프롬프트에 헤더 **없음** (b) 직접 입력 → `[CHOICE_MISS] 직전 제안: ...` 1줄 + 다음 선택지가 그 톤·소재로 조정되는지 (c) 연속 빗나감 시 `x2`/`x3` 증가 (d) 헤더 문구가 캐릭터 응답에 누출되지 않는지 |
| 12 | 세션 메모 자동 갱신 (2026-07-29) | **기존 세션은 재-open해야 MCP 도구 반영.** 비-OOC 턴 10회 진행 후 ① 다음 유저 턴에 `[MEMO]` 헤더 병합 ② AI가 `bridge_set_session_memo` 호출 ③ 로비 카드에 `autoMemo`가 흐린 이탤릭으로 표시 ④ 수동 `memo`가 있는 세션은 수동 값 그대로 유지 ⑤ 헤더 문구가 캐릭터 응답에 누출되지 않는지. 옵트아웃은 `session.json`에 `"memoAuto": false` 후 재확인 |
| 10 | 외부 MCP 실소비 검증 (feat/external-mcp) | 브릿지 쪽 스모크는 통과(2026-07-15: tools/list·health·generate 직하 저장). 남은 것: **실제 외부 프로젝트**에서 `docs/external-setup-guide.md`대로 셋업 → Claude Code가 `.mcp.json` HTTP 서버로 붙어 `comfyui_health`/`comfyui_generate` 호출. 프로덕션 서버는 재시작해야 엔드포인트 반영 |
| 13 | 세션 수명 6시간 + 수동 종료 (c3ecf75) | 재시작·라우트/빌드 반영은 확인됨(close 200, traversal 400, 청크에 216e5, smoke 5 pass). 남은 것: **실제 세션에서** (a) ☰ → "세션 종료" → confirm → CLI 프로세스가 실제로 내려가는지(`/api/service/status`의 `activeInstances` 감소) (b) 모바일에서 브라우저 닫고 10분 이상 뒤 재접속 → 세션이 살아있는지 (c) 파이프라인 스케줄러는 의도대로 끊김 즉시 정지하고 재접속으로 되살아나지 **않는지** |
| 14 | 인라인 이미지 재로딩 제거 (a730ccc) | OOC 토글을 반복해도 이미지가 스피너로 되돌아가지 않고 재요청이 없는지(DevTools Network 304 또는 요청 없음). 이미지가 실제로 삭제된 경우엔 종전대로 에러 카드로 떨어지는지 |
| 15 | H3 영상 25스텝 기본값 (a9bc5ba) | 다음 영상 생성 1회 — steps=25로 나가는지, 소요 시간이 20스텝 대비 수용 가능한지. 신규 패키지 `minimax-h3-latent-upscale`/`-video-nsfw`는 실험 상태 |
| 16 | 영상 스킬 MCP 수정 반영 (구 §4-B) | 브랜치 자체는 main 머지·푸시 완료(라이브 검증 끝남). 남은 것: **기존 세션은 재-open**해야 내부 MCP 수정이 반영된다 |
| 17 | 턴 중 개입(interject/steer) | 토글 ON → AI 응답 중 메시지 전송. (a) Claude/Codex 세션: **2026-09-12 턴 분할로 동작 변경** — 개입 시 그때까지 나온 응답이 *위*에 얼어붙고 유저 메시지가 그 뒤에 오며, 이어지는 응답이 새 버블로 열리는지 / 재로드 후에도 `[유저][앞부분][개입][뒷부분]` 순서가 유지되는지(서버 `splitAssistantTurnForInterject`가 history를 쪼갬) / 얼린 버블에 `chat:split` id가 붙어 TTS·OOC 토글이 동작하는지 / 분할 직전 carry 문자가 유실되지 않는지 / 본문 없이(툴 실행 중) 개입하면 종전대로 라이브 버블 위에 삽입되는지. 기존 항목: 스트리밍이 끊기지 않는지, 재로드 후 순서 일치. 추가 확인: **두 클라이언트 동시 접속 시 비-발신 클라에서도** 같은 분할 순서 + 얼린 버블에 id 부여(`chat:user` → `chat:split` 순서 의존) / 분할된 턴의 **TTS·on-assistant 훅·문체검토·메모가 앞부분까지 합친 전체 본문**을 받는지(`turnSplitPrefix`) / 알려진 엣지: `<dialog_response>` 태그가 열리기 전 프리앰블 상태에서 개입하면 그 프리앰블이 독립 버블로 남아 RP 모드에서도 원문이 보일 수 있음(저장 내용 자체는 종전과 동일, 항목만 둘로 쪼개짐) — **두 클라이언트(데스크톱+폰) 동시 접속 시 비-발신 클라이언트에서도** 라이브 버블 위에 끼워지고 두 번째 stream 버블이 생기지 않는지(2026-09-02 `addUserMessage` 수정, 라이브 스모크 미실행); **취소(Stop) 후 재전송** 시 유저 메시지가 취소된 버블 *뒤*에 오고 취소 버블의 부분 텍스트가 보존되는지(`handleCancelled`가 live를 지우도록 수정) (b) **agy 세션: 미검증 — queued user input이 실제로 소비되는지**, 안 되면 `SendAllQueuedMessages` 명시 호출 추가; 추가 리스크(2026-09-02 리뷰): 큐잉된 user step이 turn 중 trajectory에 붙으면 `emitNewChunks`가 `lastSeenMessageCount`/tail baseline을 그 user step으로 옮겨 진행 중이던 assistant step의 잔여 delta가 유실될 수 있다 — `antigravity-stream.log`에서 `steer: queued` 직후 RUNNING 상태로 step 수가 늘어나는지 확인, 늘어나면 tail-delta를 마지막 assistant step 기준으로 바꿔야 한다 (c) codex 세션: `codex-stream.log`에 `[steer]` 라인 + 같은 턴에서 소비 (프로토콜 자체는 app-server 프로브로 검증 완료) (d) 빌더(상시 ON) 각 프로바이더 (e) Kimi는 폴백 send — 큐잉/에러 여부 확인 |

### 4-A. 앱 모드 플랫폼 확장 (브랜치 `feat/app-mode-platform`, **미머지**)

앱 모드 전체가 **라이브 미검증**이다. 단위 테스트 39건 + 월드 계약 회귀 8건은 통과했고 `npm run verify`도 통과하지만,
스레드 루프·프로세스 스폰·앱 슬롯 렌더는 실제 세션 없이는 확인되지 않는다.

**왜 안 돌렸나**: `reapOrphanSubProcs()`(server.ts 부팅 시)가 `data/.runtime/subagent-procs.json`의 살아있는 서브 PID를
**서버 구분 없이** 죽이고 레지스트리를 비운다. 스모크 당시 프로덕션 서버(pid 30540, port 3340)에 세션 1개·클라이언트 2개가
붙어 있어서, 두 번째 서버를 띄우면 사용자가 쓰고 있을 세션의 서브에이전트를 죽인다. 서비스 재시작은 사용자 확인 사안이라 중단했다.

**돌리는 법**: 프로덕션을 멈춘 뒤 `scripts/fixtures/app-mode-stub/`를 새 페르소나에 복사하고 세션 생성 → Open.
체크리스트는 `scripts/fixtures/app-mode-stub/README.md`.

특히 확인해야 할 것:
- 앱 HUD의 "1회 마운트" 시각이 상태 변경에도 바뀌지 않는지 (재마운트하면 게임 루프가 못 산다)
- 컨텍스트 리셋(`resetEveryTurns: 10`) 후 스레드가 자기 `entityId`를 유지하는지 — `resetContext()`의 프로세스 교체 경로
- 바쁜 스레드 despawn 시 `subagent-procs.json`에 고아 PID가 남지 않는지
- 기존(앱 모드 아닌) 페르소나 세션이 무영향인지

**2026-09-12 라이브 스모크 1차 통과 (kingdom 페르소나, 세션 `kingdom-2026-09-12T12-50-17`)**: 앱 슬롯 마운트, world tick 진행, 주민 스레드 3개 90초 주기 정책 제출, 메인 `dialogue_reply` 제출까지 실세션에서 확인. 전제 조건이었던 `readLayout()`의 `app` 누락 버그 수정(`session-config-io.ts` + 회귀 테스트, 플레이북 §5.11). 상세는 `data/personas/kingdom/HANDOVER.md` §9. **남은 갭**: ① `chat.mode: hidden` 경로 미검증(dock으로만 확인) ② `emitSummary:false`가 `report_to_main` 도구를 막지 않아 스레드가 자발 호출하면 `[SUB:*]`가 메인에 큐잉됨 — 코어 게이트 필요 ③ 위 "특히 확인해야 할 것" 4항목(1회 마운트 시각·resetEveryTurns·고아 PID·비앱 세션 무영향)은 아직 미확인.

## 5. 사용자 결정 대기

1. **soft-delete 누적**: `data/deleted_sessions` **163개 / 4.47GB** (2026-06-06의 52개/2.4GB에서 3배). 복구 지향 설계라 자율 정리 금지 — 보존 기간/정책 결정 필요. `data/deleted_personas`는 24개/0.13GB.
2. **variables.json 원자화 후속 검증**: 원자화 자체는 랜딩됨(4a7e128, 052ccdf) — 남은 것은 per-file panel watch가 rename-replace를 견디는지의 런타임 확인 (§4 백로그 #9, 플레이북 §5.1). 패널 갱신이 멈추면 watcher 재장전 로직이 필요.
3. **개선 감사 잔여 항목** #2/#5/#26/#28/#29/#30/#10/#21 + TTS 엔진 추출 + agy primer 절단 재설계 — 전부 dev 서버 스모크나 사용자 확인 필요 (백로그: `docs/proposals/2026-05-30-improvement-audit.md`). 안전·헤드리스 항목은 소진됨.
4. **code-quality 보류 항목** (동작 변경이라 승인 필요): malformed `req.json()` 500→400 통일; "session not found" 상태코드 통일 (404/409/200 혼재); ChatInput useCallback의 죽은 voiceChat dep.
5. **`.env.local`의 OPENAI_API_KEY**: 2026-06-30에 실키 노출이 확인돼 로테이션 권고했으나 실행 확인 안 됨.
6. **setup.js cudaTag**: cu124에서 멈춤 — RTX 50시리즈(sm_120)는 cu126/cu128/cu130 매핑 추가 필요 (플레이북 §2.6).
7. **agy wake-up echo 영어 변형 미포착** — ERROR_MESSAGE 본문 안이라 나이브 strip 위험, 라이브 검증 동반 수정 필요 (플레이북 §4.4.5).
8. **🐛 `update_variables` 유령 MCP 도구 (2026-07-07 감사에서 발견)**: `builder-prompt.md`(2곳)·`panel-spec.md:1198`·`data/style-check/defaults.md`·`review-prompt.md`가 검토/세션 LLM에게 `update_variables` MCP 호출을 지시하지만, `claude-play-mcp-server.mjs`에 그런 도구는 **등록돼 있지 않다**. style-check의 `style_drift_verdict`/`style_warning`이 실제로 영속화되는지 라이브 검증 필요 — 안 되면 도구를 실제로 추가하거나 프롬프트 4곳을 실존 경로(`run_tool` 등)로 고쳐야 한다 (프롬프트 수정은 RP 동작 변경이라 사용자 확인 필요).
9. **slave_trainer 레거시 이중 style-check**: 페르소나 `hooks/on-assistant.js`에 자체 주기 드리프트 평가(10턴, style-drift-report.md 기록)가 남아 신규 on-style-check lifecycle(12턴)과 공존 — 둘 다 발화하면 백그라운드 검토 비용 2배. 레거시 블록 제거는 페르소나 데이터 수정이라 사용자 승인 필요.
10. **lint:persona 상존 finding**: 라이브 페르소나 23개에서 284 error / 90 warning (legacy choice 스키마, inline runTool 등 — 대부분 탐정·에이미 등 구세대 페르소나). 유저 데이터라 자율 수정 금지 — 마이그레이션 여부/우선순위 결정 필요. 이 때문에 `npm run verify`에서 lint:persona는 의도적으로 제외돼 있다.
11. **npm audit 11건 (2026-09-02, `--omit=dev`)**: `next` 15.5.18(→15.5.25, DoS/SSRF), `ws` 8.20.0(→8.21.3, 메모리 노출/DoS), `postcss`, `nanoid`, `fast-uri`, `ip-address`, `hono`(MCP SDK 경유), `qs`, `body-parser` — 전부 semver 범위 내 `npm audit fix`로 해결 가능. `sharp` 0.34.5→0.35.x는 **major**라 별도 검토. 프로덕션 서버가 `node_modules`를 로드 중이라 갱신은 재기동 직전에 실행할 것(`npm audit fix` → `npm run verify` → `node scripts/restart.mjs`). `npm outdated` 상 major 대기: next 16, tailwind 4, typescript 7, uuid 14, @types/node 26 — 전부 보류(마이그레이션 비용 > 이득).

## 6. 의도적으로 하지 않은 것 (재평가 조건 포함)

- **ESLint 도입 안 함**: 지금 넣으면 70+ 라우트·35+ 컴포넌트에서 수백 개 경고가 쏟아지고, 약한 유지보수자가 기계적으로 "고치다" 실회귀를 만든다 (unused var 삭제, hooks deps 재배열 등). tsc strict가 타입 수준 안전망을 이미 제공. 도입하려면 강한 유지보수자가 초기 경고 소진을 먼저 할 것 — 그때 flat config로 react-hooks/rules-of-hooks + exhaustive-deps(warn) + no-floating-promises만.
- **git hook 안 함**: `.git/hooks`는 버전 관리가 안 되고, 62초 빌드 훅은 재시작 오케스트레이터·AI 루프의 잦은 커밋에 견딜 수 없으며, Windows 경로 공백 이슈로 실패하는 훅은 약한 모델에게 `--no-verify` 습관만 가르친다. 대신 `npm run verify` + 체크리스트.
- **Turbopack production 빌드 안 함**: custom server.ts와 비호환 (BUILD_ID 미생성). 재시도 시 BUILD_ID 비어있지 않음 + required-server-files.json 존재 먼저 확인.
- **agy 프로필 격리 안 함**: `--gemini_dir` 격리는 cascade-ID 호환을 깨서 revert됨 — 재시도 금지 (플레이북 §4.4.5).

## 7. 개선 로드맵 리드 (우선순위 제안)

1. ~~agy 폴링 → 스트리밍 전환~~ — 2026-09-14 headless stream-json 파이프로 완료 (라이브 스모크는 §4-4).
2. **agy primer 강화**: "짧은 준비 완료 응답만" 지시로 primer 선행 플레이(실제 도구 호출 부수효과) 차단.
3. **shared tool 패널 watcher**: `data/tools/` watch + SPA 네비게이션 시 frontend `_instances` destroy — templateCache stale 해소 (플레이북 §5.3).
4. **서브에이전트 role 재주입**: 장기 세션 compaction에서 leading-message 희석 대응 (session-lifecycle v2 한계 ⓐ).
5. **restart 마커의 `/api/builder/start` 커버리지** (현재 edit/resume 경로만).
6. **모바일 후속 개선** (2026-07-11 `cc22488`에서 CSS 레벨 quick-win 완료 — 모달 뷰포트 가드·핀치줌 허용·`PANEL_DEFENSIVE_STYLE`·StatusBar min-w-0·SubAgentChatModal 칩 스트립). 남은 항목:
   - 모바일 상시 상태 패널: 사이드 패널이 드로어 뒤에 숨음 → 컴팩트 상단 스트립 or bottom-sheet peek 검토
   - dock-bottom을 모바일에서 모달 승격 대신 bottom-sheet로 유지 (`chat page.tsx:866-891`)
   - TTS audio-unlock 프라이밍 (모바일 브라우저 제스처 제약, `chat page.tsx:209-241`)
   - WS `visibilitychange` 즉시 재연결 (`useWebSocket.ts` 2초 폴링)
   - (인프라 결정 필요) TLS/HTTPS → PWA manifest — 외부 접속 필요성 확정 후

## 8. 이 인수인계에서 새로 생긴 것

- `docs/maintenance-playbook.md` — 함정·설계 이유·디버깅 절차 백과 (**작업 전 필독**)
- `docs/pre-merge-checklist.md` — 커밋/머지 전 기계적 절차
- `npm run typecheck` (~6s) / `npm run verify` (통합 검증) / `npm run lint:data` / `npm run check:static` / `npm run smoke`
- tsconfig `data/`·`scratch/` 펜스 — 유저 데이터 .ts가 빌드를 깨는 경로 차단
- docs/ 전체 드리프트 수정 (Penta Runtime 반영, Antigravity 문서화, env var 표 보강 등)

### 2026-09-02 문서 정비에서 새로 생긴 것

- `docs/codebase-map.md` — **새 작업 요청의 첫 진입점.** 요청 어휘(선택지·OOC·메모·개입·패널·서브에이전트·이미지·agy…) → 서버→클라이언트 진입 파일 → grep 앵커(WS 이벤트명·헤더 토큰·한국어 UI 문자열) → 플레이북 § → change-propagation 행 → 검증 단계. 큰 파일 4개의 구역 앵커 표 포함. 줄 번호는 의도적으로 없음.
- `npm run check:docs` (`scripts/check-docs.mjs`) — verify 체인에 편입. 라우트·lib·컴포넌트·훅·MCP 도구·외부 MCP 툴이 해당 문서에 없으면 에러, 문서 표의 유령 항목도 에러, `codebase-map.md`의 죽은 경로도 에러, 미문서화 env var는 WARN. git hook이 아니라 verify 단계인 이유는 §6의 "git hook 안 함" 결정과 같다.
- 드리프트 수정: architecture(ws-server "5초 유예"→6시간 위임, external-mcp 4파일 표), api-routes(`/ws`, builder/edit 실제 동작, open body, files/images/status 쿼리), frontend(메모 칩·세션 종료·InlineImage 미디어·모델 선택기 3곳·"오토 메시지 프리셋" 개명), data-model(external-mcp-token·`.agy-profile`·워크플로 패키지·`.thumbs`·`import-meta.json`·variables.json·로그 파일명), infrastructure(`CODEX_HOME`), README(24 tools·Node 18.18+·문서 표 6종), SETUP(13단계 표·TTS 메뉴·save 후 종료·401 성공 신호·Blackwell cu130·COMFYUI_AUTOSTART), shared-documents(비전파 루트 문서 주석), pre-merge/playbook(smoke WARN=exit 1).
- `package.json` `engines.node >= 18.18.0` + `setup.js` Step 1 게이트를 18.18로 상향 (사용자 자율 진행 지시로 같은 날 처리). npm은 engine-strict가 아니면 경고만 내므로 기존 환경에 영향 없음.

---

## 마지막 메모

이 서비스는 잘 설계돼 있고, 남은 함정들은 위와 플레이북에 전부 적어뒀다. 다음 유지보수자에게: 판단이 서지 않을 때는 **철칙 → 검증 사다리 → 해당 서브시스템 문서** 순서로 따라가면 된다. 화려한 수정보다 검증된 작은 수정이 이 리포의 방식이다.

즐거웠다. 좋은 세션들을 만들어줘서 고마워. — Fable
