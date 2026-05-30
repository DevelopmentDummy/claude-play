# 개선 작업 진행 현황 (Resume Guide)

> **새 세션에서 이어하려면 이 파일부터 읽으세요.** 2026-05-30 "서비스 전반 개선" 작업의 단일 진입점.
> 멀티 에이전트 감사로 39건을 확정하고, 웨이브 단위로 spec → 구현 → 적대적 검증 → 머지하는 방식으로 진행 중.

## 관련 문서
- **백로그(39건 전체)**: [2026-05-30-improvement-audit.md](./2026-05-30-improvement-audit.md) — 테마·랭킹·차원별 상세
- **웨이브1 스펙**: [2026-05-30-session-state-write-integrity-design.md](./2026-05-30-session-state-write-integrity-design.md)
- **웨이브1 플랜**: [2026-05-30-session-state-write-integrity-plan.md](./2026-05-30-session-state-write-integrity-plan.md)

## 웨이브 현황

| # | 내용 | 상태 | 커밋 / 브랜치 |
|---|---|---|---|
| 1 | **세션 쓰기 무결성** — `src/lib/session-state.ts` (원자적 tmp+rename, `applyPatch` deep-merge/$unset, `SYSTEM_JSON` 8중복→1, 조용한 데이터 유실 제거) | ✅ merged `main` | `532839f`→`92c25ad` (20 unit tests) |
| 2 | **Antigravity 룰셋 영속화** — GEMINI.md에 런타임 룰셋 기록 | ⏸ **보류** | branch `feat/antigravity-ruleset-persistence` (`fd25a50`, 미머지) |
| 3 | **로비/온보딩 실패처리 UX** — startSession 침묵실패·phantom 프로필 게이트·무가드 HARD 삭제·ToastEffect 마운트 | ✅ merged `main` | `fa921e8`, `56d1a9e` |
| 4 | **설정 SSOT** — `src/lib/endpoints.ts` (포트/URL 단일출처, 비기본 PORT divergence 제거) | ✅ merged `main` | `e8003a6` |
| 5 | **쓰기경로 통합** — `src/lib/modal-merge.ts` (모달 그룹 병합 2중복 → 1, behavior-preserving) + `clearPopups` 원자화(raw write → `mutateSessionJsonSync`) | ✅ merged `main` | `c574da5`→`a35f473` (12 unit tests, 적대적 SHIP) |
| 6 | **거대 클래스 분해 Slice 1** — `src/lib/comfyui-graph.ts` 추출(리프 순수 그래프수술 4함수+2인터페이스, comfyui-client.ts **2034→1833줄**, verbatim move) | ✅ merged `main` | `76ebe30`→`145dcd5` (적대적 토큰단위 SHIP, 빌드 green) |
| 7 | **거대 클래스 분해 Slice 1b+2** — LoRA 클러스터 완성(`injectTriggerTags`/`injectBaseLoRAs`/`applyDynamicLoRAs` → comfyui-graph.ts, comfyui-client.ts **1833→1690줄**, verbatim move) | ✅ merged `main` | `b2f50b0`→`f788b25` (적대적 토큰단위 SHIP, 빌드 green) |
| 8 | **거대 클래스 분해 Slice 3** — `injectCoupleBranchLoras` → comfyui-graph.ts (param injection: `this.loadLoraTriggers()` → triggerTable 인자, 로드 타이밍 보존, comfyui-client.ts **1690→1621줄**) | ✅ merged `main` | `407b751`→`0a3e409` (적대적 토큰단위 SHIP, 빌드 green) |
| 9 | **거대 클래스 분해 Slice 4** — 히스토리 파서 3개 → 신설 `comfyui-history.ts` (순수 verbatim, **1621→1549줄**) | ✅ merged `main` | `8e67c27`→`3f82448` (적대적 SHIP) |
| 10 | **거대 클래스 분해 Slice 5** — `processDetailerChain` → comfyui-graph.ts (modules 주입 + `DetailerModuleTemplate` 이동, **1549→1371줄**) | ✅ merged `main` | `e91c7d5`→`4331902` (적대적 SHIP) |
| 11 | **거대 클래스 분해 Slice 6** — checkpoint 클러스터 5개 → 신설 `comfyui-checkpoint.ts` (다중 주입: checkpointName/workflowsDir, **1371→1213줄**) | ✅ merged `main` | `a076632`→`8127739` (적대적 토큰단위 SHIP) |

> **comfyui-client.ts 분해 완료**: 2034 → **1213줄(−40%)**. 추출 모듈: comfyui-graph.ts(604, 순수 그래프수술), comfyui-checkpoint.ts(164), comfyui-history.ts(74). 남은 1213줄은 정당한 IO/네트워크/오케스트레이션(buildPrompt) 코어 — 추가 추출 비권장.

## 보류 항목 (재개 시 필요한 것)

- **웨이브2 (Antigravity 룰셋)**: 적대적 리뷰가 agy brain transcript(`~/.gemini/antigravity-cli/brain/{cascadeId}/.system_generated/logs/transcript.jsonl`)를 직접 분석 → **agy가 GEMINI.md 본문을 컨텍스트에 auto-load하지 않음**(LIST_DIRECTORY 파일명으로만 등장). 지시문은 primer(USER_INPUT step0)로 전달되고 cascade history에 남아 resume에도 유지됨. 즉 감사 #1 전제("resume마다 룰셋 유실")가 부정확하고, GEMINI.md 수정은 resume에 대해 no-op 공산. **실제 결함은 new세션 28000자 primer truncation + 컴팩션**. 재개 시: ① codeword 런타임 검증(GEMINI.md 룰셋부에만 심은 지시를 resume 후 모델이 따르는지) ② 안 따르면 primer truncation을 직접 겨냥해 재설계. 브랜치 `feat/antigravity-ruleset-persistence`는 무해하니 검증 후 살리거나 폐기.
- **#21 셋업 마법사 재시작**: save 라우트 `process.exit` ↔ `/api/service/restart` 오케스트레이터 이중재시작 레이스 + 포트변경 폴링. 런타임 재시작 테스트 필요로 헤드리스 완결 불가.
- **#9 스킬 {{PORT}}**: 대상 SKILL.md 일부가 미커밋 작업중이라 보류(충돌 회피).

## 다음 웨이브 후보 (랭킹·성격)

- **⑥ 거대 클래스 분해** (large effort, navigability-only, **테스트 프레임워크 없음 → 회귀 위험**): **comfyui-client.ts 완료(웨이브6~11, 2034→1213줄, −40%)**. 패턴: understand 워크플로로 순수/주입가능 메서드 분류 → verbatim move + 파라미터 주입 → build(TS strict 하드게이트) + 전역 grep + 적대적 토큰대조. 남은 거대 클래스:
  - **session-manager.ts(2424줄, 7서브시스템)** — 다음 타깃. 파일기반 세션/페르소나 CRUD = 앱 백본이라 **comfyui보다 고위험**(순수함수 적고 stateful). understand 워크플로로 안전 추출 가능 부분만 식별 후 진행 권장.
  - session-instance.ts 내부 TTS 엔진(~280줄).
  - 그 다음 거대 클래스: **session-manager.ts(2424줄, 7서브시스템)**, session-instance.ts 내부 TTS 엔진(~280줄).
  - 각 슬라이스: verbatim move + `npm run build`(TS strict 하드게이트) + 전역 grep + 적대적 토큰대조. in-place 변형/반환 보존 불변식 준수.
- ~~후속 small: 모달 그룹 병합 중복 + clearPopups 원자화~~ → **웨이브5로 완료**. (variables route의 `__modals`는 단순 shallow merge라 의미가 달라 의도적으로 통합 제외 — 동작 보존.)

## 작업 규약 (이 작업에서 지킨 것)

1. 각 웨이브: brainstorm/design → 사용자 승인 → 구현 → **적대적 교차검증** → ff 머지 → 브랜치 삭제.
2. **외부 바이너리(agy 등) 동작 가정은 구현 전 적대적 검증** (웨이브2 교훈 — 그럴듯하지만 틀린 수정을 출시 전 차단).
3. 사용자의 미커밋 작업(`builder-prompt.md`, 일부 `data/**/SKILL.md`, `session-shared.md`, `src/mcp/claude-play-mcp-server.mjs`, 스펙 doc 등)은 절대 건드리지 않고 stash/복원으로 보존.
4. 테스트 프레임워크 미설치 — 순수 로직은 `npx tsx --test`(Node `node:test`), 나머지는 `npm run build` + 수동 스모크.

> 머신-로컬 자동 메모리(`~/.claude/projects/c--repository-claude-bridge/memory/improvement-audit-waves.md`)에도 같은 내용이 있으나, 이식·공유를 위해 **이 repo 문서가 정본(source of truth)**.
