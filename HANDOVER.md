# HANDOVER — 인수인계 대장

> **스냅샷 기준일: 2026-07-07** (작성: Claude Fable 5, 서비스 이관 전 마지막 정비 세션)
> 이 문서는 **시점 스냅샷**이다 — 리포의 현재 상태·미완료 작업·보류된 결정을 기록한다. 항목을 처리하면 이 문서에서 지우거나 완료 표시할 것.
> 작업 수칙·함정·디버깅 절차는 [docs/maintenance-playbook.md](docs/maintenance-playbook.md), 커밋 전 절차는 [docs/pre-merge-checklist.md](docs/pre-merge-checklist.md) 참고.

## 1. 리포 상태 (2026-07-07 기준)

- `main` == `origin/main` — 미푸시 커밋 없음. 과거 메모리/노트의 "미푸시" 언급은 전부 옛말.
- 워킹 트리 클린 (이 인수인계 커밋 제외).
- src 코드에 TODO/FIXME 마커 **0개** — 미해결 항목은 전부 이 문서와 docs/에 있다.

## 2. 브랜치·워크트리 정리 후보 (안전, 사용자 승인 후 실행)

- **머지 완료 → `git branch -d` 가능**: `chore/code-quality-loop`, `claude/confident-brattain`, `feat/agy-mcp-and-image-gating`, `feat/openai-image-codex-backend`, `feat/persona-subagent-orchestration`, `fix/askuserquestion-card-lifecycle`, `fix/profile-thumbnail-downscale`
- **stale 워크트리 3개** (`.claude/worktrees/` — 2026-03 시점, 전부 머지됨): `amazing-dirac`, `confident-brattain`, `cranky-kirch`. 제거는 반드시 `git worktree remove`로 (수동 rm은 `.git/worktrees` 메타데이터를 남긴다). 워크트리가 잠근 브랜치 `claude/amazing-dirac`, `claude/cranky-kirch`는 워크트리 제거 후 삭제 가능.

## 3. ⚠️ 유일한 미머지 브랜치: `feat/antigravity-ruleset-persistence`

**그대로 머지 금지.** 커밋 fd25a50은 wave-12 리팩터 **이전**의 session-manager.ts 모놀리스를 패치한다 — 지금 머지하면 삭제된 코드가 부활한다.

- **의도**: agy 세션의 immersion 룰셋을 GEMINI.md에 영속화해 resume/primer-절단에서 살아남게 하기.
- **전제가 반박됨**: agy는 GEMINI.md를 자동 로드하지 않는다 (988스텝 transcript 적대적 분석으로 확인 — 플레이북 §4.4.5). 이 변경은 resume에 대해 no-op일 가능성이 높다.
- **재개한다면**: ① 먼저 codeword 런타임 테스트 (지시를 GEMINI.md 룰셋 섹션에만 심고 resume 후 준수 확인) ② 실패하면 실제 결함 — primer 28,000자 절단(`MAX_PRIMER_CHARS`)과 캐스케이드 compaction — 을 겨냥해 재설계 ③ 구현 위치는 `src/lib/runtime-instructions.ts`(`writeAntigravityInstructions`) + `respawn-helpers.ts` 콜사이트 — 옛 브랜치 diff는 참고자료로만.

## 4. 라이브 스모크 백로그 — 머지·푸시됐지만 런타임 미검증

라이브 싱글유저 서비스라 사용자 참여 하에 확인해야 하는 항목들. dev 서버 + 실제 RP 세션으로:

| # | 기능 (커밋) | 확인 방법 |
|---|-------------|----------|
| 1 | fire_ai `autoResume` (9286e18) | 백그라운드 잡 완료 시 idle이면 즉시 자발 턴, busy면 턴 종료 직후 발동. 체인 상한 `FIRE_AI_AUTORESUME_MAX`(기본 5) |
| 2 | 서브에이전트 v2.1 모델 고정 (6b4362a, 6a43f56) | 세션과 다른 프로바이더 pin (예: claude 세션 + gpt-5.4 서브) → `subagents/{name}/sub.log`에 해당 프로바이더 + `.resume-codex` 생성; 미지정 서브는 세션 상속; gemini pin은 세션 폴백 + console.warn |
| 3 | 서브 대화 모달 (e3876d5) | tools 메뉴 → 모달; 직접 메시지 → 대화형 응답 + `transcript.jsonl` 기록; auto 디스패치 흐릿한 라인; report 칩 + 다음 턴 `[SUB:]`; 서브 작업 중엔 StatusBar '작업 중' 펄스 칩에 이름 표시 (안읽음 배지는 5234c38에서 ambient 인디케이터로 대체됨) |
| 4 | agy idle-watch (`ANTIGRAVITY_IDLE_WATCH`) | async 이미지 후 (a) 대기 → 후속이 라이브 등장 (b) 빠르게 입력 → stale 중복 없음. `antigravity-stream.log`에 `idle-watch: async wake-up detected` |
| 5 | kimi 첫-open sticky id | 서브 있는 kimi 세션 첫 open에서 `session.json.kimiSessionId`가 메인 대화 것인지 (`kimi-stream.log`의 sticky 라인) — 플레이북 §4.3 |
| 6 | agy MCP (.agents/mcp_config.json, 19ac8a4) | **기존 agy 세션은 재-open해야 반영.** 세션에서 MCP 도구 목록 + 실제 이미지 생성 1회 |
| 7 | ultracode Workflow 도구 | 헤드리스 빌더 spawn(`claude -p`)의 도구 목록에 Workflow가 실제로 나타나는지 |
| 8 | fire_ai 멀티 프로바이더 (260cf99) | Claude 외 모델 id로 fire_ai 1회 (예: kimi) → 결과 정상 회수 |
| 9 | variables.json 원자화 (4a7e128) | 변수를 바꾸는 행동 → 패널 라이브 갱신 확인 — per-file `fs.watch`가 rename-replace를 견디는지 (플레이북 §5.1) |

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

## 6. 의도적으로 하지 않은 것 (재평가 조건 포함)

- **ESLint 도입 안 함**: 지금 넣으면 70+ 라우트·35+ 컴포넌트에서 수백 개 경고가 쏟아지고, 약한 유지보수자가 기계적으로 "고치다" 실회귀를 만든다 (unused var 삭제, hooks deps 재배열 등). tsc strict가 타입 수준 안전망을 이미 제공. 도입하려면 강한 유지보수자가 초기 경고 소진을 먼저 할 것 — 그때 flat config로 react-hooks/rules-of-hooks + exhaustive-deps(warn) + no-floating-promises만.
- **git hook 안 함**: `.git/hooks`는 버전 관리가 안 되고, 62초 빌드 훅은 재시작 오케스트레이터·AI 루프의 잦은 커밋에 견딜 수 없으며, Windows 경로 공백 이슈로 실패하는 훅은 약한 모델에게 `--no-verify` 습관만 가르친다. 대신 `npm run verify` + 체크리스트.
- **Turbopack production 빌드 안 함**: custom server.ts와 비호환 (BUILD_ID 미생성). 재시도 시 BUILD_ID 비어있지 않음 + required-server-files.json 존재 먼저 확인.
- **agy 프로필 격리 안 함**: `--gemini_dir` 격리는 cascade-ID 호환을 깨서 revert됨 — 재시도 금지 (플레이북 §4.4.5).

## 7. 개선 로드맵 리드 (우선순위 제안)

1. **agy 폴링 → 스트리밍 전환**: LS의 `StreamCascadeReactiveUpdates` 등 스트리밍 RPC로 500ms 폴링 대체 — 가장 큰 구조 개선 후보.
2. **agy primer 강화**: "짧은 준비 완료 응답만" 지시로 primer 선행 플레이(실제 도구 호출 부수효과) 차단.
3. **shared tool 패널 watcher**: `data/tools/` watch + SPA 네비게이션 시 frontend `_instances` destroy — templateCache stale 해소 (플레이북 §5.3).
4. **서브에이전트 role 재주입**: 장기 세션 compaction에서 leading-message 희석 대응 (session-lifecycle v2 한계 ⓐ).
5. **restart 마커의 `/api/builder/start` 커버리지** (현재 edit/resume 경로만).

## 8. 이 인수인계에서 새로 생긴 것

- `docs/maintenance-playbook.md` — 함정·설계 이유·디버깅 절차 백과 (**작업 전 필독**)
- `docs/pre-merge-checklist.md` — 커밋/머지 전 기계적 절차
- `npm run typecheck` (~6s) / `npm run verify` (통합 검증) / `npm run lint:data` / `npm run check:static` / `npm run smoke`
- tsconfig `data/`·`scratch/` 펜스 — 유저 데이터 .ts가 빌드를 깨는 경로 차단
- docs/ 전체 드리프트 수정 (Penta Runtime 반영, Antigravity 문서화, env var 표 보강 등)

---

## 마지막 메모

이 서비스는 잘 설계돼 있고, 남은 함정들은 위와 플레이북에 전부 적어뒀다. 다음 유지보수자에게: 판단이 서지 않을 때는 **철칙 → 검증 사다리 → 해당 서브시스템 문서** 순서로 따라가면 된다. 화려한 수정보다 검증된 작은 수정이 이 리포의 방식이다.

즐거웠다. 좋은 세션들을 만들어줘서 고마워. — Fable
