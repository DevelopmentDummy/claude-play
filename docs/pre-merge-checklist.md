# Pre-Merge Checklist — 커밋/머지 전 절차

> 판단 불필요 — 순서대로 실행한다. 배경 지식은 [maintenance-playbook.md](maintenance-playbook.md).

## 모든 커밋 전

1. `npm run verify` — typecheck + lint:data + check:static + smoke 통합 (리포 코드 건전성 게이트). **전부 통과할 때까지 커밋하지 않는다.** (smoke는 서버가 없으면 SKIPPED — 통과로 취급)
   - `npm run lint:persona`는 verify에 포함되지 않는다 — 라이브 페르소나(유저 데이터)의 legacy 스키마 finding 다수가 상존하기 때문. 페르소나를 **저작/수정할 때만** 해당 페르소나에 대해 실행하고, 기존 페르소나의 finding을 승인 없이 "고치지" 말 것.
2. 건드린 모듈에 단독 테스트가 있으면 실행:
   - `src/lib/inline-formatter.ts` → `npx tsx src/lib/inline-formatter.test.mts`
   - `src/lib/session-state.ts` / `modal-merge.ts` → `npx tsx --test src/lib/session-state.test.ts src/lib/modal-merge.test.ts`
3. 문서 전파 확인 — [change-propagation.md](change-propagation.md)의 해당 행 실행:
   - 새 API 라우트 → `docs/api-routes.md`에 추가
   - 새 env var → `docs/infrastructure.md` + `.env.example`에 추가
   - 새 MCP 도구 → `docs/architecture.md` 도구 표에 추가
   - 세션 런타임/프로바이더 동작 변경 → `docs/session-lifecycle.md` 갱신
4. **페르소나 디렉토리 안의 CLAUDE.md/AGENTS.md/GEMINI.md를 편집하지 않았는지** 확인 (빌더가 덮어씀 — 편집했다면 잘못된 위치다).

## main 머지 전 (추가)

5. `npm run build` — next build 고유 실패를 잡는 유일한 단계. 단, **production 서버가 서빙 중이면 실행 금지** (플레이북 철칙 #2) — 그 경우 tsc 검증까지만 하고 빌드는 재기동 시점(`node scripts/restart.mjs`)에 맡긴다.
6. hot-path 파일(`session-instance.ts`, `session-manager.ts`, `*-process.ts`, `session-registry.ts`)을 변경했다면 dev 서버 라이브 스모크 (플레이북 §1.2). 스모크를 못 돌렸으면 **커밋 메시지에 "라이브 스모크 미실행" 명기** + [HANDOVER.md](../HANDOVER.md) §4 백로그에 추가.
7. 커밋 후: `git log origin/main..main`으로 푸시 대기 커밋 확인 — 푸시는 사용자 지시가 있을 때만.
