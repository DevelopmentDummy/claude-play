# 세션 상태 쓰기 무결성 — 설계 스펙

- **날짜**: 2026-05-30
- **상태**: 설계 승인됨 (사용자 승인 2026-05-30), 구현 계획 대기
- **범위(Scope B)**: 기반(원자성·SSOT·로깅) + 하위호환 deep-merge/$unset. 세션별 뮤텍스(C)는 제외.
- **출처**: [개선 감사 백로그](./2026-05-30-improvement-audit.md) 발견 #4, #18, #3, (#34/#35 읽기측 일부)

---

## 1. 문제 정의

세션 RP 상태를 쓰는 모든 경로가 **비원자적 `writeFileSync` + top-level shallow merge + 빈 `catch{}`** 패턴을 복붙하고 있다. 결과:

1. **조용한 데이터 유실 (#4)** — `tools/[name]/route.ts`의 변수/데이터 쓰기가 `catch {}`로 감싸여, 깨진 JSON·Windows 파일락(EBUSY/EPERM)·디스크 오류 시 패치가 조용히 드롭되는데도 엔드포인트는 성공을 반환한다. AI/페르소나는 상태가 영속됐다고 믿는다 (가장 추적 어려운 상태 드리프트).
2. **lossy shallow merge + 삭제 불가 (#18)** — `{ variables: { relationship: { trust: 5 } } }` 패치가 `relationship` 객체 전체를 교체해 형제 키(affection, history…)를 날린다. 또한 한 번 설정된 `__competition` 같은 전이 상태를 제거할 방법이 없어 패널/`available_when`이 영구 점등된다.
3. **비원자성** — 크래시가 쓰기 중간에 나면 잘린 JSON이 남고, `buildJsonLint`가 매 턴 경고한다.
4. **SSOT 드리프트 (#3)** — "시스템" JSON 파일 제외집합(`SYSTEM_JSON`)이 4개 파일에 8번 손으로 재정의됐고 **내용이 서로 다르다**. 그래서 훅·패널·persona-info가 같은 디렉터리를 **서로 다른 데이터 뷰**로 본다.

### 현재 쓰기 경로 인벤토리 (전수)

| # | 위치 | 쓰는 파일 | 특수 로직 | 실패 처리(현재) |
|---|---|---|---|---|
| 1 | `src/app/api/sessions/[id]/tools/[name]/route.ts:119-183` | variables.json + 임의 data.json | `__modals` 그룹 auto-close (layout.json 참조) | 빈 `catch {}` (성공 반환) |
| 2 | `src/app/api/sessions/[id]/variables/route.ts:57-92` | variables.json 또는 `?file=` data.json | BOM strip · `__modals` deep-merge · `__refreshPanels` 신호 | 500 반환 |
| 3 | `src/app/api/sessions/[id]/modals/route.ts:49-121` | variables.json (`__modals`만) | 그룹 auto-close | 500 반환 + 로깅 |
| 4a | `src/lib/session-instance.ts:643-660` (`runMessageHooks`) | variables.json + data.json | — | 빈 `catch{}` (outer try 有) |
| 4b | `src/lib/session-instance.ts:709-725` (`runAssistantHooks`) | variables.json + data.json | fireAi | 빈 `catch{}` |
| 4c | `src/lib/session-instance.ts:866` (`runStyleCheckHook`) | variables.json (`__style_check_counter`) | 카운터 increment | 빈 `catch{}` |

> **MCP 서버(`src/mcp/claude-play-mcp-server.mjs`)는 무변경.** 모든 상태 변경을 `requestJson()` HTTP fetch로 위 라우트에 위임하므로 라우트 중앙화로 자동 커버된다. `.mjs`의 `readVariables()`는 스냅샷용 읽기 전용이다.

### SSOT 드리프트 상세 (8개 정의)

| 정의 위치 | 항목 수 | 특이 |
|---|---|---|
| `tools/[name]/route.ts:12` | 14 | policy-context 有, .mcp/style 無 |
| `panel-engine.ts:12` | 13 | comfyui-config/character-tags 有, .mcp/style/policy-context 無 |
| `session-manager.ts:53` | 15 | .mcp/style 有, policy-context 無 |
| `session-instance.ts:618,685,786,904` (훅 ×4) | 11 | comfyui-config/character-tags/.mcp/style/policy-context **전부 無** |
| `session-instance.ts:904` (style-check) | 12 | 11 + style-check.json |
| `session-instance.ts:577` (`buildJsonLint`) | 9 | **의도적으로 다름** — variables/voice/comfyui-config 등을 *린트하려고* 제외 안 함 |

→ 훅의 `data` 맵에는 지금 `comfyui-config/character-tags/.mcp/style/policy-context.json`이 페르소나 데이터로 **샌다**. 반면 session-manager의 persona-info는 시스템으로 취급. 같은 파일을 다른 코드가 다르게 본다.

---

## 2. 목표 / 비목표

**목표**
- 모든 세션 상태 쓰기를 단일 모듈(`src/lib/session-state.ts`)로 통합해 원자성·락재시도·로깅을 일원화.
- `SYSTEM_JSON`을 단일 export 상수(union)로 통합해 드리프트 클래스 제거.
- 하위호환 `$merge:'deep'` / `$unset` 디렉티브로 중첩 클로버·삭제불가 해소.
- 조용한 쓰기 실패를 관측 가능하게(`failed[]` / 로깅 / 500).

**비목표 (이번 웨이브 제외)**
- 세션별 async 뮤텍스(동시 쓰기 직렬화) — 순차 턴 모델에서 효과 낮음(감사 비권장).
- 라우트 통합/리네이밍, API 표면 변경.
- `.mjs` 측 변경, provider 런타임/spawn 변경.
- `buildJsonLint` 린트 정책 변경.

---

## 3. 아키텍처

신규 모듈 **`src/lib/session-state.ts`**. 핵심은 **transform 콜백 프리미티브**로 "원자적 read-modify-write"를 소유하고, 라우트별 특수 로직(`__modals`, `__refreshPanels`, 카운터)은 호출자의 transform 안에 남긴다.

> **⚠️ 동기/비동기 분리 (핵심 정합성 제약)** — `ws-server.ts:299-301`은 `runMessageHooks(text)` **직후** `buildHintSnapshot()`로 방금 쓴 variables.json을 **읽는다**. 현재 훅 쓰기는 동기(`writeFileSync`)라 읽기 전에 완료된다. 따라서 **훅 경로는 동기 완료를 반드시 보존**해야 한다(`mutateSessionJsonSync`). async fire-and-forget로 바꾸면 hint 스냅샷이 stale을 읽는 회귀가 발생한다. 라우트 3종은 이미 async 컨텍스트라 async 변형(`mutateSessionJson`, lock-retry 포함)을 await한다. 이 분리로 ws-server/session-instance 호출처 시그니처는 **불변**.

### 3.1 공개 API

```ts
// ── SSOT 상수 ────────────────────────────────────────────────
/** 세션 디렉터리에서 페르소나 "데이터"가 아닌 시스템 JSON 파일 집합 (union, 17개). */
export const SYSTEM_JSON: ReadonlySet<string>;
/** buildJsonLint 전용 스킵 집합 (현행 9개 — SYSTEM_JSON과 의도적으로 별개). */
export const LINT_SKIP_JSON: ReadonlySet<string>;

export interface PatchResult {
  ok: boolean;
  value?: Record<string, unknown>; // 성공 시 기록된 최종 객체 (라우트 응답 반환용)
  error?: unknown;
}

// ── 원자적 프리미티브 (동기 / 비동기 쌍) ─────────────────────
/**
 * 세션 JSON 파일을 원자적으로 read-modify-write (동기, 단일 시도).
 * - 읽기: BOM strip + parse. 파일이 존재하나 parse 실패 → 쓰지 않고 {ok:false} (덮어쓰기 방지). 없으면 current={}.
 * - transform(current) → next. transform이 throw → {ok:false}.
 * - 쓰기: atomicWriteJsonSync — `${filePath}.<pid>.<seq>.tmp` 기록 → fs.renameSync (단일 시도, lock-retry 없음).
 * - 절대 throw 안 함. 실패는 [session-state] 컨텍스트와 함께 로깅.
 * - 용도: **훅 경로** (동기 완료가 hint-snapshot 읽기 순서에 필수).
 */
export function mutateSessionJsonSync(
  filePath: string,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): PatchResult;

/**
 * 위와 동일하되 쓰기를 retryOnWindowsLock(() => atomicWriteJsonSync(...))로 감싼 비동기 변형.
 * - 용도: **라우트 3종** (이미 async 컨텍스트라 await 가능; EBUSY/EPERM 동시쓰기 흡수).
 */
export async function mutateSessionJson(
  filePath: string,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<PatchResult>;

// ── 순수 패치 의미론 ─────────────────────────────────────────
/**
 * shallow(기본) / $merge:'deep' / $unset 디렉티브 적용. 순수 함수.
 * 디렉티브 키($merge,$unset)는 결과에 영속되지 않음.
 */
export function applyPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown>;

// ── 경로 헬퍼 ────────────────────────────────────────────────
/**
 * sessionDir + fileName → 절대경로. fileName에 .json 자동 부착, traversal(/ \ ..) 차단.
 * 위반 시 null. (시스템/보호 파일 차단은 호출자 책임 — 정책이 라우트=PROTECTED_FILES, 훅=SYSTEM_JSON로 다름.)
 */
export function resolveSessionFilePath(sessionDir: string, fileName: string): string | null;

// ── 읽기측 공유 (5중복 → 1) ──────────────────────────────────
/** 단일 세션 JSON 파일 관용 읽기 (BOM strip + parse). 없으면 null, parse 실패 시 throw. */
export function readSessionJson<T = Record<string, unknown>>(filePath: string): T | null;

/** variables.json + 비시스템 *.json 데이터 맵 로드 (카논 SYSTEM_JSON 사용, parse 오류 관용). 동기. */
export function loadSessionData(sessionDir: string): {
  variables: Record<string, unknown>;
  data: Record<string, unknown>;
};
```

> 편의 래퍼(`patchVariables`/`patchDataFile`)는 의도적으로 두지 않는다 — 동기/비동기 두 변형이 필요해 API가 중복되고, 호출자 4곳이 각자 `__modals`·`PROTECTED_FILES`·카운터 등 고유 정책을 가져 프리미티브를 직접 조합하는 편이 명확하다. 조합 패턴은 §5 참조.

### 3.2 `applyPatch` 의미론

처리 순서:
1. `current` 얕은 복제로 시작.
2. 패치에서 디렉티브 추출(영속화 안 함): `$merge`(`'deep'` | `'shallow'`, 기본 `'shallow'`), `$unset`(`string[]`, dot-path 허용).
3. 나머지 키 병합:
   - `'shallow'`(기본): `{ ...current, ...rest }` (top-level 교체 = **현행과 동일**).
   - `'deep'`: plain object는 재귀 병합, **배열·원시값·null은 교체**(인덱스 병합 안 함).
4. `$unset` 삭제 적용: 각 경로를 dot-path로 해석해 삭제(`"a.b.c"` → `result.a.b`에서 `c` 삭제). 존재 안 하면 무시.
5. 반환.

- 기본 shallow = **완전 하위호환**.
- `$merge` / `$unset`은 `__modals`처럼 **예약 키**. 페르소나 data가 이 이름의 실제 키를 가질 일은 없음(문서화).
- 한 번의 호출(패치) 단위로 모드 결정 — 키 단위 혼합은 v1 미지원.

예시 (패치 객체 — 툴/훅이 반환하거나 PATCH 바디로 전달):
```js
// 형제 키 보존하며 깊은 갱신 → applyPatch(current, patch)
{ $merge: 'deep', relationship: { trust: 5 } }
// 전이 상태 제거
{ $unset: ['__competition', 'flags.temp_buff'] }
```

### 3.3 원자적 쓰기 세부

공유 코어 `atomicWriteJsonSync(filePath, value)` (모듈 내부, 동기):
- tmp 경로: `${filePath}.${process.pid}.${seq++}.tmp` (모듈 레벨 `seq` 카운터로 동일 프로세스 내 충돌 방지). dest와 **같은 디렉터리** → 같은 볼륨 → rename 원자적.
- `writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8'); renameSync(tmp, dest);`. 실패 시 tmp unlink 시도(오류 무시) 후 throw.
- **BOM 없음, 2-space** — 현행 출력 포맷 보존(워처/diff 비교 churn 방지). 읽기는 leading BOM 관용.

- `mutateSessionJsonSync`(훅): 코어를 **단일 시도**로 호출(lock-retry 없음 — 현행 훅도 retry 없었으므로 회귀 아님). 동기 완료 보장.
- `mutateSessionJson`(라우트): `await retryOnWindowsLock(() => atomicWriteJsonSync(filePath, next))`(기존 `src/lib/fs-retry.ts`)로 EBUSY/EPERM/ENOTEMPTY 흡수.
- 두 변형 모두 read·transform 후 코어 호출, throw는 잡아 `{ok:false, error}` + 로깅.
- `.tmp`는 panel-engine 워처가 무시함 — 워처 필터가 `endsWith(".json")`(panel-engine.ts:238)이므로 `.tmp`는 매칭 안 됨. dest의 단일 atomic 교체만 워처에 보인다.

---

## 4. SSOT 상수 통합

- `SYSTEM_JSON` = 8개 정의의 **union(17개)**:
  `variables.json, session.json, builder-session.json, layout.json, chat-history.json, pending-events.json, pending-actions.json, package.json, tsconfig.json, voice.json, chat-options.json, comfyui-config.json, character-tags.json, .mcp.json, style.json, policy-context.json, style-check.json`
- import 처치환:
  - `tools/[name]/route.ts:12` → import (route의 `PROTECTED_FILES`는 별개로 유지 — 쓰기 차단 정책용)
  - `panel-engine.ts:12` → import
  - `session-manager.ts:53` → import
  - `session-instance.ts` 읽기 4곳(618/685/786/904) → `loadSessionData`로 대체되며 자연 제거
- `buildJsonLint`(session-instance.ts:577)는 **건드리지 않음**. `LINT_SKIP_JSON`(현행 9개: session, builder-session, layout, chat-history, pending-events, pending-actions, package, tsconfig, chat-options)을 export해 명명만 정리하되, **SYSTEM_JSON과 합치지 않음**. 이유: 린트는 variables/voice/comfyui-config 등을 *일부러 검사*한다. union으로 바꾸면 해당 린트가 꺼져 동작이 바뀐다.

---

## 5. 호출자 마이그레이션

각 호출자는 **고유 특수 로직을 그대로 보존**하고, 읽기는 `loadSessionData`, 쓰기는 프리미티브(`mutateSessionJson` 라우트 / `mutateSessionJsonSync` 훅)에 `applyPatch`를 조합해 위임한다.

### 5.1 `tools/[name]/route.ts`
- 컨텍스트 빌드(60-77) → `loadSessionData(sessionDir)`.
- 변수 패치(119-165): `__modals`를 patch에서 추출 → 그룹 로직은 **transform 안**으로 이동:
  ```ts
  const r = await mutateSessionJson(varsPath, (cur) => {
    const next = applyPatch(cur, restOfVariables); // __modals 제외분
    if (modalChanges) next.__modals = computeModals(cur.__modals, modalChanges, modalGroups);
    return next;
  });
  ```
- data 패치(168-183): 각 파일에 대해 `PROTECTED_FILES` 가드(현행 유지) + `resolveSessionFilePath`(traversal) 후 `await mutateSessionJson(path, cur => applyPatch(cur, patch))`. 실패는 `failed.push(fileName)`.
- 응답: 기존 바디에 `failed: string[]`(빈 배열이면 생략 가능) **가산**. HTTP 상태 불변(낙관적 UX 보존). 빈 `catch{}` 제거 — 프리미티브가 이미 로깅하므로 route는 `!ok` 집계만.

### 5.2 `variables/route.ts`
- 쓰기(57-77)를 `mutateSessionJson`으로. `__refreshPanels` 추출/스트립과 `__modals` deep-merge는 transform 안에서 수행. 성공 시 `result.value`를 JSON 반환(현행 `return NextResponse.json(merged)` 동등). `!ok` → 500 유지.

### 5.3 `modals/route.ts`
- 그룹 auto-close 계산 로직 유지, 최종 쓰기만 `mutateSessionJson`(드디어 주석대로 진짜 원자적). 성공 시 `{ ok:true, __modals }` 반환. `!ok` → 500.

### 5.4 `session-instance.ts` 훅 3종 — **동기 변형만 사용 (시그니처 불변)**
세 메서드 모두 현행대로 동기(`void`) 시그니처를 유지하고 `mutateSessionJsonSync`를 쓴다. 이로써 호출처(`ws-server.ts:299,317`, `session-instance.ts:1484`)와 직후의 `buildHintSnapshot()` 읽기 순서가 그대로 보존된다.
- `runMessageHooks` / `runAssistantHooks`: 컨텍스트는 `loadSessionData`. 변수 패치 → `mutateSessionJsonSync(varsPath, cur => applyPatch(cur, result.variables))`. data 패치 루프 → `SYSTEM_JSON.has` 가드 유지 + `resolveSessionFilePath` 후 `mutateSessionJsonSync(path, cur => applyPatch(cur, patch))`. fireAi 등 훅 고유 tail 유지.
- `runStyleCheckHook`: 카운터 increment를 `mutateSessionJsonSync(varsPath, cur => { const c=(Number(cur.__style_check_counter)||0)+1; counter=c; return {...cur, __style_check_counter:c}; })`로(원자적). data 컨텍스트는 `loadSessionData`. style-check.json은 union에 포함되므로 자동 제외.

> **순서 보존 확인**: `runMessageHooks`는 동기 완료 → 직후 `buildHintSnapshot()`(ws-server.ts:301)이 갱신된 variables.json을 읽음. 회귀 없음. 비동기로 만들지 않는다.

### 5.5 `.mjs` (MCP) — 무변경.

---

## 6. 엣지 케이스 / 위험

1. **(의도적 동작 변화) 훅 `data` 맵 축소** — union 적용으로 `comfyui-config/character-tags/.mcp/style/policy-context.json`이 더 이상 훅 `data`로 안 샌다. 이 시스템 파일을 페르소나 데이터로 *읽는* 훅이 있으면 영향(현재 알려진 사례 없음). 감사가 "정합성 수정"으로 확인. → 구현 시 `data['comfyui-config']` 등 참조하는 훅 grep로 사전 확인.
2. **(양성 동작 변화) panel-engine 워처** — union 적용으로 워처가 `style/policy-context/.mcp/style-check.json` 변경 시 패널 리렌더를 멈춘다. 이들은 설정 파일이라 **불필요한 리렌더 제거**(개선).
3. **동시 쓰기 lost-update** — 뮤텍스 미포함(B)이라 객체 단위 last-write-wins는 가능하나 **파일은 절대 안 깨짐**(원자성 확보). 순차 턴·단일 사용자에서 수용.
4. **깨진 파일 보호** — parse 실패한 기존 파일은 덮어쓰지 않고 `{ok:false}`. 현행은 조용히 드롭이었으므로 데이터 보존 측면 개선. 단 패치는 적용 안 됨(로깅으로 관측).
5. **예약 키 충돌** — `$merge`/`$unset` 이름의 실제 data 키는 미지원(`__modals` 류와 동일 관례). 문서화.
6. **data 파일 차단 정책** — `resolveSessionFilePath`는 traversal만 방어(+`.json` 부착). SYSTEM/PROTECTED 차단은 호출자(라우트=PROTECTED_FILES, 훅=SYSTEM_JSON)가 호출 전 수행(정책이 의도적으로 다름).
7. **tmp 파일 잔존** — 비정상 종료 시 `*.tmp` 잔여 가능. 무해(워처 무시, 다음 쓰기와 무관). 필요 시 향후 정리 루틴(이번 범위 외).

---

## 7. 검증 계획 (테스트 프레임워크 없음)

1. **순수 로직 단위 테스트** — `src/lib/session-state.test.ts`, Node 내장 `node:test`+`node:assert`(새 의존성 0):
   - `applyPatch`: shallow 기본, `$merge:'deep'` 형제 보존, 배열 교체, `$unset` top-level/dot-path, 디렉티브 키 미영속, 빈 패치 no-op.
   - `mutateSessionJsonSync`: 신규 파일 생성, 기존 갱신 라운드트립, 깨진 파일 abort(미덮어쓰기), transform throw 처리, 2-space/무BOM 출력, BOM 입력 관용. (async `mutateSessionJson`은 동일 코어 + retry 래퍼라 라운드트립 1개로 충분.)
   - `resolveSessionFilePath`: `.json` 부착, traversal(`..`/슬래시) → null.
   - 실행: `npx tsx --test src/lib/session-state.test.ts` (정확한 러너 호출형은 구현 첫 단계에서 확정; 실패 시 폴백: `.mjs` 테스트가 컴파일 산출/동등 로직 검증).
2. **타입/빌드** — `npm run build`(tsc strict) 통과.
3. **수동 스모크**:
   - 툴 액션 1회(변수+data 패치) → 파일 갱신·`failed` 없음 확인.
   - 패널 모달 open→close → `__modals` 그룹 동작·원자적 쓰기 확인.
   - `$merge:'deep'` 패치로 중첩 형제 키 보존, `$unset`로 키 삭제 확인.
   - on-message/on-assistant 훅 보유 페르소나 1개로 훅 쓰기 정상 확인.
   - 출력 파일 포맷(2-space, BOM 없음) 육안 확인 + panel-engine 리렌더 정상.

---

## 8. 변경 파일 요약

**신규**
- `src/lib/session-state.ts`
- `src/lib/session-state.test.ts`

**수정**
- `src/app/api/sessions/[id]/tools/[name]/route.ts`
- `src/app/api/sessions/[id]/variables/route.ts`
- `src/app/api/sessions/[id]/modals/route.ts`
- `src/lib/session-instance.ts` (훅 3종 + `buildJsonLint`는 `LINT_SKIP_JSON` 명명 정리만)
- `src/lib/panel-engine.ts` (SYSTEM_JSON import)
- `src/lib/session-manager.ts` (SYSTEM_JSON import)

**무변경**
- `src/mcp/claude-play-mcp-server.mjs`

---

## 9. 후속 웨이브 (이 스펙 범위 외, 백로그 참조)

본 스펙으로 `loadSessionData`/`mutateSessionJson` 기반이 생기면, 백로그의 인접 항목(#34/#35 훅 컨텍스트 로더 dedup의 나머지, 그리고 다른 차원의 SSOT 항목 #8/#9)이 저비용으로 따라온다. 다음 웨이브 후보는 감사 백로그 랭킹 참조.
