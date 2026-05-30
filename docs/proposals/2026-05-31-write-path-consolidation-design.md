# 쓰기경로 통합 (Wave 5) 설계

> 2026-05-30 "서비스 전반 개선" 작업의 Wave 5. Wave 1(세션 쓰기 무결성)의 후속 정리 항목 두 건을
> behavior-preserving 리팩터로 마감한다. 진입점: [IMPROVEMENT-STATUS.md](./IMPROVEMENT-STATUS.md).

## 목표

1. 모달-그룹 병합 로직의 실질 중복(modals route ↔ tools route)을 단일 모듈로 추출한다.
2. `clearPopups()`의 raw `fs.writeFileSync`를 Wave 1의 원자적 쓰기 경로로 흡수한다.

두 변경 모두 **외부 관찰 동작을 바꾸지 않는다**(refactor-only). 테스트 프레임워크가 없으므로
순수 로직은 `node:test`로 단위검증하고, 통합은 `npm run build`로 확인한다.

## 배경 / 현재 중복

### 모달 그룹 로직
같은 의미("모달을 열면 같은 그룹의 다른 모달은 닫는다")가 두 곳에 서로 다른 모양으로 박혀 있다.

- `src/app/api/sessions/[id]/modals/route.ts` (line 50–87): 전용 엔드포인트.
  layout.json `panels.modalGroups`를 BOM strip하여 읽고, `findGroup`으로 그룹을 찾아
  open/close/closeAll 액션을 처리. open 시 `mode ?? "dismissible"`.
- `src/app/api/sessions/[id]/tools/[name]/route.ts` (line 102–128): 엔진 결과의
  `result.variables.__modals` 변경 객체를 적용. 각 `[name, value]`에 대해 value가 truthy면
  같은 그룹 형제를 닫고 `modals[name] = value`, falsy면 false. layout.json도 inline으로 BOM strip 읽기.

`src/app/api/sessions/[id]/variables/route.ts` (line 60–68)도 `__modals`를 특수 처리하지만,
이것은 **그룹 로직 없는 단순 shallow merge**(`{ ...current.__modals, ...patch.__modals }`)다.
의미가 다르므로 통합 대상에서 제외하고 현행 동작을 보존한다.

### clearPopups
`src/lib/session-instance.ts` (line 902–914)의 `clearPopups()`는 새 유저 메시지 진입 시
ws-server에서 **동기 호출**된다(`ws-server.ts:312`). 현재 raw `JSON.parse(readFileSync)` +
`fs.writeFileSync`로, Wave 1이 도입한 원자적 tmp+rename·Windows 락 재시도·BOM 내성 밖에 있다.

보존해야 할 현행 동작:
- 파일이 없으면 **생성하지 않고** 그냥 반환.
- `__popups`가 배열이 아니거나 빈 배열이면 **쓰지 않고** 반환(렌더 스케줄도 안 함).
- 정리할 게 있을 때만 `__popups = []`로 쓰고 `panels.scheduleRender()` 호출.

## 설계

### 신설 모듈 `src/lib/modal-merge.ts`
모달 그룹 가시성 의미론만 담는 단일 책임 모듈. 핵심 로직은 fs와 분리해 순수 함수로 둔다.

```ts
/** layout.json → panels.modalGroups. BOM 내성, 어떤 오류든 {} 반환. */
export function readModalGroups(sessionDir: string): Record<string, string[]>;

/**
 * 단일 모달 변경 + 그룹 자동닫기. 입력을 변형하지 않고 새 맵을 반환한다(순수).
 *  - value가 truthy: 같은 그룹의 다른 멤버를 모두 false로, 그 후 result[name] = value
 *  - value가 falsy : result[name] = false
 */
export function applyModalChange(
  modals: Record<string, unknown>,
  groups: Record<string, string[]>,
  name: string,
  value: unknown,
): Record<string, unknown>;

/** except에 없는 모든 키를 false로. 새 맵 반환(순수). closeAll 액션용. */
export function closeAllModals(
  modals: Record<string, unknown>,
  except?: string[],
): Record<string, unknown>;
```

의미론 명세(현행 코드와 정확히 일치해야 함):
- `applyModalChange`의 "truthy/falsy" 판정은 JS 기본 truthiness(`if (value)`)를 따른다.
  현행 tools route의 `value && value !== false && value !== null`은 truthy 판정과 동치다
  (`false`·`null`·`0`·`""`·`undefined`는 falsy → false 처리).
- `applyModalChange`는 `name`이 어느 그룹에도 없으면 형제 닫기 없이 해당 키만 설정한다.
- 한 모달이 여러 그룹에 속하면 **처음 매칭된 그룹**만 닫는다(현행 tools route의 `break` 동작과
  modals route의 `findGroup` 첫 매칭 동작 모두 이와 일치).
- 모든 함수는 입력 맵을 변형하지 않고 얕은 복사 후 수정한 새 맵을 반환한다.

### 적용

**modals/route.ts** — transform 내부를 헬퍼로 치환:
- 진입 시 `const groups = readModalGroups(sessionDir)` (transform 밖, 기존과 동일 위치).
- `open`: `modals = applyModalChange(modals, groups, name, mode ?? "dismissible")`
- `close`: `modals = applyModalChange(modals, groups, name, false)`
- `closeAll`: `modals = closeAllModals(modals, except)`
- `findGroup` 지역 함수와 inline BOM strip 읽기 제거.

**tools/[name]/route.ts** — `result.variables.__modals` 적용부:
- inline layout 읽기를 `readModalGroups(sessionDir)`로 치환.
- `for (const [mName, value] of Object.entries(modalChanges))` 루프 본문을
  `modals = applyModalChange(modals, modalGroups, mName, value)` 한 줄로 치환.

**variables/route.ts** — 변경 없음. (단순 shallow merge는 의미가 다르므로 보존.)

### clearPopups 원자화
`readSessionJson`으로 먼저 읽어 현행 early-return을 보존하고, 정리할 게 있을 때만
`mutateSessionJsonSync`로 원자적 쓰기:

```ts
clearPopups(): void {
  const dir = this.getDir();
  if (!dir) return;
  const varsPath = path.join(dir, "variables.json");
  let current: Record<string, unknown> | null;
  try { current = readSessionJson(varsPath); } catch { return; } // corrupt → 보존
  if (!current) return;                                            // 없음 → 생성 안 함
  if (!Array.isArray(current.__popups) || current.__popups.length === 0) return; // 비었으면 no-op
  const r = mutateSessionJsonSync(varsPath, (c) => ({ ...c, __popups: [] }));
  if (r.ok) this.panels.scheduleRender();
}
```

`readSessionJson`/`mutateSessionJsonSync`가 `session-instance.ts`에 이미 import되어 있지 않으면
`@/lib/session-state`에서 추가한다(Wave 1에서 4개 훅이 이미 `mutateSessionJsonSync`를 쓰므로 대개 존재).
정리 케이스에서만 읽기가 2회(check + mutate) 발생하나, 흔한 no-op 경로는 1회 읽고 반환 —
원본과 동일 비용이며 동기 단일 프로세스라 TOCTOU 없음.

## 검증

### 단위 (`src/lib/modal-merge.test.ts`, node:test)
- `applyModalChange`: (a) 그룹 멤버 open → 형제 false + 자신 value, (b) 비그룹 모달 open → 자신만 설정,
  (c) close(false) → 형제 영향 없이 자신 false, (d) 입력 맵 불변(원본 미변형) 확인,
  (e) 다중 그룹 소속 시 첫 매칭만 닫힘.
- `closeAllModals`: except 제외 전부 false, except 보존, 빈 except.
- `readModalGroups`: tmpdir에 layout.json 작성(BOM 유/무) → 그룹 반환; 파일 없음/깨진 JSON → `{}`.

실행: `npx tsx --test src/lib/modal-merge.test.ts` (전부 PASS).

### 통합
`npm run build` — TypeScript strict 통과 + Next 빌드 성공.

### 수동 스모크(선택)
모달 그룹이 정의된 세션에서 모달 열기 → 같은 그룹 다른 모달 닫힘 확인, 유저 메시지 전송 시
`__popups` 비워짐 확인. (헤드리스 검증으로 충분 — 동작 보존이 목표라 새 동작 없음.)

## 비목표 (YAGNI)
- variables route의 `__modals` 의미를 그룹-aware로 바꾸지 않는다(동작 변경).
- 모달 z-index/ESC/dismissible 등 프론트엔드 로직은 건드리지 않는다.
- 더 넓은 panel/variables 쓰기경로 정리는 별도 웨이브.
