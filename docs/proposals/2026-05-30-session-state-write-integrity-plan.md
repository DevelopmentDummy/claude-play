# 세션 상태 쓰기 무결성 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 세션 RP 상태 쓰기를 단일 모듈로 통합해 원자성·SSOT·하위호환 deep-merge/$unset·관측가능 실패를 확보한다.

**Architecture:** 신규 `src/lib/session-state.ts`가 transform 콜백 기반 원자적 read-modify-write(동기 `mutateSessionJsonSync` / 비동기 `mutateSessionJson`)와 순수 패치 의미론(`applyPatch`), 카논 `SYSTEM_JSON`을 소유한다. 라우트 3종은 async 변형을, 훅 3종은 동기 변형을 쓴다(`buildHintSnapshot` 읽기 순서 보존). `.mjs`는 무변경(HTTP 라우트 경유).

**Tech Stack:** TypeScript(strict), Next.js App Router, Node 22 `node:test`(+ `npx tsx --test`), 기존 `src/lib/fs-retry.ts`.

**스펙:** [2026-05-30-session-state-write-integrity-design.md](./2026-05-30-session-state-write-integrity-design.md)

---

## 파일 구조

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/lib/session-state.ts` | SSOT 상수 · applyPatch · 원자적 mutate · 읽기 헬퍼 | **신규** |
| `src/lib/session-state.test.ts` | 순수 로직 + fs 라운드트립 테스트 | **신규** |
| `src/app/api/sessions/[id]/tools/[name]/route.ts` | 툴 액션 쓰기 → 중앙화 + `failed[]` | 수정 |
| `src/app/api/sessions/[id]/variables/route.ts` | PATCH 쓰기 → 중앙화 | 수정 |
| `src/app/api/sessions/[id]/modals/route.ts` | 모달 쓰기 → 진짜 원자적 | 수정 |
| `src/lib/session-instance.ts` | 훅 3종 읽기/쓰기 중앙화 + buildJsonLint 상수 | 수정 |
| `src/lib/panel-engine.ts` | SYSTEM_JSON import | 수정 |
| `src/lib/session-manager.ts` | SYSTEM_JSON import | 수정 |

테스트 명령(모든 태스크 공통): `npx tsx --test src/lib/session-state.test.ts`
빌드 검증(모든 코드 태스크 공통): `npm run build`

---

## Task 1: SSOT 상수 + `applyPatch` 순수 로직 (TDD)

**Files:**
- Create: `src/lib/session-state.ts`
- Test: `src/lib/session-state.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `src/lib/session-state.test.ts` 생성

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPatch, SYSTEM_JSON, LINT_SKIP_JSON } from "./session-state";

test("applyPatch: shallow 기본은 top-level 키를 교체한다", () => {
  const cur = { a: 1, nested: { x: 1, y: 2 } };
  const out = applyPatch(cur, { nested: { z: 3 } });
  assert.deepEqual(out, { a: 1, nested: { z: 3 } }); // 형제 x,y는 shallow라 사라짐
});

test("applyPatch: $merge:'deep'는 형제 키를 보존한다", () => {
  const cur = { rel: { trust: 1, affection: 5 } };
  const out = applyPatch(cur, { $merge: "deep", rel: { trust: 9 } });
  assert.deepEqual(out, { rel: { trust: 9, affection: 5 } });
});

test("applyPatch: deep merge는 배열을 통째로 교체한다", () => {
  const cur = { list: [1, 2, 3], o: { a: 1 } };
  const out = applyPatch(cur, { $merge: "deep", list: [9], o: { b: 2 } });
  assert.deepEqual(out, { list: [9], o: { a: 1, b: 2 } });
});

test("applyPatch: $unset은 top-level 및 dot-path 키를 삭제한다", () => {
  const cur = { keep: 1, gone: 2, flags: { temp: true, perm: false } };
  const out = applyPatch(cur, { $unset: ["gone", "flags.temp"] });
  assert.deepEqual(out, { keep: 1, flags: { perm: false } });
});

test("applyPatch: 디렉티브 키는 영속되지 않는다", () => {
  const out = applyPatch({}, { $merge: "deep", $unset: ["x"], a: 1 });
  assert.deepEqual(out, { a: 1 });
});

test("applyPatch: $unset이 입력을 변형하지 않는다(순수)", () => {
  const cur = { flags: { temp: true } };
  applyPatch(cur, { $unset: ["flags.temp"] });
  assert.deepEqual(cur, { flags: { temp: true } });
});

test("applyPatch: 빈 패치는 no-op 복제", () => {
  assert.deepEqual(applyPatch({ a: 1 }, {}), { a: 1 });
});

test("SSOT: SYSTEM_JSON union(17) + LINT_SKIP_JSON은 variables.json 미포함", () => {
  assert.equal(SYSTEM_JSON.has("comfyui-config.json"), true);
  assert.equal(SYSTEM_JSON.has("style-check.json"), true);
  assert.equal(SYSTEM_JSON.size, 17);
  assert.equal(LINT_SKIP_JSON.has("variables.json"), false);
  assert.equal(LINT_SKIP_JSON.has("voice.json"), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx --test src/lib/session-state.test.ts`
Expected: FAIL — `Cannot find module './session-state'` (또는 export 미존재).

- [ ] **Step 3: 최소 구현** — `src/lib/session-state.ts` 생성

```ts
import * as fs from "fs";
import * as path from "path";
import { retryOnWindowsLock } from "./fs-retry";

type Dict = Record<string, unknown>;

// ── SSOT 상수 ────────────────────────────────────────────────
/** 세션 디렉터리에서 페르소나 "데이터"가 아닌 시스템 JSON 파일 (union, 17). */
export const SYSTEM_JSON: ReadonlySet<string> = new Set([
  "variables.json", "session.json", "builder-session.json", "layout.json",
  "chat-history.json", "pending-events.json", "pending-actions.json",
  "package.json", "tsconfig.json", "voice.json", "chat-options.json",
  "comfyui-config.json", "character-tags.json", ".mcp.json", "style.json",
  "policy-context.json", "style-check.json",
]);

/** buildJsonLint 전용 스킵 (현행 9 — SYSTEM_JSON과 의도적으로 별개). */
export const LINT_SKIP_JSON: ReadonlySet<string> = new Set([
  "session.json", "builder-session.json", "layout.json", "chat-history.json",
  "pending-events.json", "pending-actions.json", "package.json",
  "tsconfig.json", "chat-options.json",
]);

// ── 순수 패치 의미론 ─────────────────────────────────────────
function isPlainObject(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(target: Dict, source: Dict): Dict {
  const out: Dict = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k] as Dict, v);
    else out[k] = v; // 배열·원시값·null → 교체
  }
  return out;
}

function unsetPath(obj: Dict, dotPath: string): void {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur)) return;
    cur = (cur as Dict)[parts[i]];
  }
  if (isPlainObject(cur)) delete (cur as Dict)[parts[parts.length - 1]];
}

/**
 * shallow(기본) / $merge:'deep' / $unset(dot-path) 적용. 순수 함수.
 * 디렉티브 키($merge,$unset)는 결과에 영속되지 않는다.
 */
export function applyPatch(current: Dict, patch: Dict): Dict {
  const mode = patch.$merge === "deep" ? "deep" : "shallow";
  const unset = Array.isArray(patch.$unset) ? (patch.$unset as unknown[]) : [];

  const rest: Dict = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "$merge" || k === "$unset") continue;
    rest[k] = v;
  }

  let next: Dict = mode === "deep" ? deepMerge(current, rest) : { ...current, ...rest };
  if (unset.length) {
    next = structuredClone(next) as Dict; // 중첩 unset이 입력을 변형하지 않도록
    for (const p of unset) if (typeof p === "string" && p) unsetPath(next, p);
  }
  return next;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx --test src/lib/session-state.test.ts`
Expected: PASS — `# pass 8  # fail 0`.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-state.ts src/lib/session-state.test.ts
git commit -m "feat(session-state): applyPatch 순수 로직 + SSOT 상수"
```

---

## Task 2: 원자적 mutate 프리미티브 + 읽기 헬퍼 (TDD)

**Files:**
- Modify: `src/lib/session-state.ts`
- Test: `src/lib/session-state.test.ts`

- [ ] **Step 1: 실패 테스트 추가** — `src/lib/session-state.test.ts` 상단 import 교체 + 테스트 추가

import 줄을 다음으로 교체:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyPatch, SYSTEM_JSON, LINT_SKIP_JSON,
  mutateSessionJsonSync, resolveSessionFilePath, readSessionJson, loadSessionData,
} from "./session-state";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
}
```

파일 끝에 추가:
```ts
test("resolveSessionFilePath: .json 부착", () => {
  assert.equal(resolveSessionFilePath("/s", "inventory"), path.join("/s", "inventory.json"));
});
test("resolveSessionFilePath: traversal 차단 → null", () => {
  assert.equal(resolveSessionFilePath("/s", "../secret"), null);
  assert.equal(resolveSessionFilePath("/s", "a/b.json"), null);
});

test("mutateSessionJsonSync: 신규 파일 2-space, BOM 없음", () => {
  const fp = path.join(tmpDir(), "variables.json");
  const r = mutateSessionJsonSync(fp, (cur) => ({ ...cur, a: 1 }));
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(fp, "utf-8");
  assert.notEqual(raw.charCodeAt(0), 0xfeff);
  assert.equal(raw, '{\n  "a": 1\n}');
});

test("mutateSessionJsonSync: 기존 갱신 + 읽기 BOM strip", () => {
  const fp = path.join(tmpDir(), "v.json");
  fs.writeFileSync(fp, "﻿" + JSON.stringify({ a: 1 }), "utf-8");
  const r = mutateSessionJsonSync(fp, (cur) => applyPatch(cur, { b: 2 }));
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf-8")), { a: 1, b: 2 });
});

test("mutateSessionJsonSync: 깨진 기존 파일은 abort(미덮어쓰기)", () => {
  const fp = path.join(tmpDir(), "v.json");
  fs.writeFileSync(fp, "{ not json", "utf-8");
  const r = mutateSessionJsonSync(fp, () => ({ a: 1 }));
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(fp, "utf-8"), "{ not json");
});

test("mutateSessionJsonSync: transform throw → ok:false, 파일 미생성", () => {
  const fp = path.join(tmpDir(), "v.json");
  const r = mutateSessionJsonSync(fp, () => { throw new Error("boom"); });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(fp), false);
});

test("mutateSessionJsonSync: 성공 후 .tmp 잔여 없음", () => {
  const dir = tmpDir();
  mutateSessionJsonSync(path.join(dir, "v.json"), () => ({ a: 1 }));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("readSessionJson: 없으면 null", () => {
  assert.equal(readSessionJson(path.join(tmpDir(), "nope.json")), null);
});

test("loadSessionData: 비시스템 *.json만 data로, variables 분리", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "variables.json"), JSON.stringify({ hp: 5 }), "utf-8");
  fs.writeFileSync(path.join(dir, "inventory.json"), JSON.stringify({ gold: 10 }), "utf-8");
  fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify({ x: 1 }), "utf-8"); // 시스템
  const { variables, data } = loadSessionData(dir);
  assert.deepEqual(variables, { hp: 5 });
  assert.deepEqual(data, { inventory: { gold: 10 } }); // voice 제외
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx --test src/lib/session-state.test.ts`
Expected: FAIL — `mutateSessionJsonSync`/`resolveSessionFilePath`/`readSessionJson`/`loadSessionData` 미export.

- [ ] **Step 3: 최소 구현** — `src/lib/session-state.ts` 끝에 추가

```ts
// ── 타입 ─────────────────────────────────────────────────────
export interface PatchResult {
  ok: boolean;
  value?: Dict;
  error?: unknown;
}

// ── 읽기 헬퍼 ────────────────────────────────────────────────
/** 단일 세션 JSON 관용 읽기(BOM strip). 없으면 null, parse 실패 시 throw. */
export function readSessionJson<T = Dict>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw) as T;
}

/** variables.json + 비시스템 *.json 데이터 맵 로드(parse 관용). 동기. */
export function loadSessionData(sessionDir: string): { variables: Dict; data: Dict } {
  let variables: Dict = {};
  try {
    variables = (readSessionJson<Dict>(path.join(sessionDir, "variables.json")) as Dict) || {};
  } catch {
    variables = {};
  }
  const data: Dict = {};
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) continue;
      try {
        const parsed = readSessionJson(path.join(sessionDir, f));
        if (parsed !== null) data[f.replace(/\.json$/, "")] = parsed;
      } catch { /* 파싱 불가 — 스킵 */ }
    }
  } catch { /* 디렉터리 읽기 오류 */ }
  return { variables, data };
}

// ── 경로 헬퍼 ────────────────────────────────────────────────
/** sessionDir + fileName → 절대경로. .json 부착, traversal 차단. 위반 시 null. */
export function resolveSessionFilePath(sessionDir: string, fileName: string): string | null {
  const name = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return path.join(sessionDir, name);
}

// ── 원자적 쓰기 ──────────────────────────────────────────────
let tmpSeq = 0;

/** tmp+rename 원자적 쓰기(동기). 실패 시 tmp 정리 후 throw. */
function atomicWriteJsonSync(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** read + transform 준비(읽기 관용·corrupt abort·transform throw 처리). */
function prepareMutation(
  filePath: string,
  transform: (current: Dict) => Dict,
): { ok: true; next: Dict } | { ok: false; error: unknown } {
  let current: Dict;
  try {
    const v = readSessionJson<Dict>(filePath);
    current = v === null ? {} : v;
  } catch (err) {
    console.error(`[session-state] read/parse failed (not overwriting) ${filePath}:`, err);
    return { ok: false, error: err };
  }
  try {
    return { ok: true, next: transform(current) };
  } catch (err) {
    console.error(`[session-state] transform threw ${filePath}:`, err);
    return { ok: false, error: err };
  }
}

/** 동기 원자적 read-modify-write. 훅 경로용(동기 완료 보장). */
export function mutateSessionJsonSync(
  filePath: string,
  transform: (current: Dict) => Dict,
): PatchResult {
  const p = prepareMutation(filePath, transform);
  if (!p.ok) return { ok: false, error: p.error };
  try {
    atomicWriteJsonSync(filePath, p.next);
  } catch (err) {
    console.error(`[session-state] write failed ${filePath}:`, err);
    return { ok: false, error: err };
  }
  return { ok: true, value: p.next };
}

/** 비동기 원자적 read-modify-write(Windows lock 재시도). 라우트 경로용. */
export async function mutateSessionJson(
  filePath: string,
  transform: (current: Dict) => Dict,
): Promise<PatchResult> {
  const p = prepareMutation(filePath, transform);
  if (!p.ok) return { ok: false, error: p.error };
  try {
    await retryOnWindowsLock(() => atomicWriteJsonSync(filePath, p.next));
  } catch (err) {
    console.error(`[session-state] write failed ${filePath}:`, err);
    return { ok: false, error: err };
  }
  return { ok: true, value: p.next };
}
```

- [ ] **Step 4: 통과 + 빌드 확인**

Run: `npx tsx --test src/lib/session-state.test.ts`
Expected: PASS — `# pass 16  # fail 0`.
Run: `npm run build`
Expected: 타입 에러 없이 빌드 성공.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-state.ts src/lib/session-state.test.ts
git commit -m "feat(session-state): 원자적 mutate 프리미티브 + 읽기/경로 헬퍼"
```

---

## Task 3: 툴 액션 라우트 중앙화 (#4 #18)

**Files:**
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts`

- [ ] **Step 1: import 추가 + 로컬 SYSTEM_JSON 제거**

상단 import 블록에 추가:
```ts
import { mutateSessionJson, applyPatch, loadSessionData, resolveSessionFilePath } from "@/lib/session-state";
```
그리고 로컬 `const SYSTEM_JSON = new Set([...])` (12-18줄) **삭제**. `PROTECTED_FILES`는 유지.

- [ ] **Step 2: 컨텍스트 빌드 교체 (59-77줄)**

다음 블록(varsPath 읽기 + data 루프)을:
```ts
  const varsPath = path.join(sessionDir, "variables.json");
  let variables: Record<string, unknown> = {};
  try {
    variables = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
  } catch {}

  const data: Record<string, unknown> = {};
  try {
    for (const f of fs.readdirSync(sessionDir)) {
      if (f.endsWith(".json") && !SYSTEM_JSON.has(f)) {
        try {
          data[f.replace(".json", "")] = JSON.parse(
            fs.readFileSync(path.join(sessionDir, f), "utf-8")
          );
        } catch {}
      }
    }
  } catch {}
```
다음으로 교체:
```ts
  const varsPath = path.join(sessionDir, "variables.json");
  const { variables, data } = loadSessionData(sessionDir);
```

- [ ] **Step 3: 변수/데이터 쓰기 교체 (118-183줄)**

`// Apply variables patch` ~ `// Apply data file patches` 블록 전체를 다음으로 교체:
```ts
    const failed: string[] = [];

    // Apply variables patch (중앙화 + __modals 그룹 로직 보존)
    if (result?.variables && typeof result.variables === "object") {
      const modalChanges = result.variables.__modals as Record<string, unknown> | undefined;
      delete result.variables.__modals;
      const restVars = result.variables as Record<string, unknown>;
      const vr = await mutateSessionJson(varsPath, (current) => {
        const merged = applyPatch(current, restVars);
        if (modalChanges && typeof modalChanges === "object" && !Array.isArray(modalChanges)) {
          const modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
          let modalGroups: Record<string, string[]> = {};
          const layoutPath = path.join(sessionDir, "layout.json");
          try {
            if (fs.existsSync(layoutPath)) {
              let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
              if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
              modalGroups = JSON.parse(layoutRaw)?.panels?.modalGroups || {};
            }
          } catch {}
          for (const [mName, value] of Object.entries(modalChanges)) {
            if (value && value !== false && value !== null) {
              for (const members of Object.values(modalGroups)) {
                if (members.includes(mName)) {
                  for (const member of members) if (member !== mName) modals[member] = false;
                  break;
                }
              }
              modals[mName] = value;
            } else {
              modals[mName] = false;
            }
          }
          merged.__modals = modals;
        }
        return merged;
      });
      if (!vr.ok) failed.push("variables.json");
    }

    // Apply data file patches
    if (result?.data && typeof result.data === "object") {
      for (const [rawKey, patch] of Object.entries(result.data)) {
        if (!patch || typeof patch !== "object") continue;
        const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
        if (PROTECTED_FILES.has(fileName)) continue;
        const filePath = resolveSessionFilePath(sessionDir, fileName);
        if (!filePath) continue;
        const dr = await mutateSessionJson(filePath, (current) =>
          applyPatch(current, patch as Record<string, unknown>),
        );
        if (!dr.ok) failed.push(fileName);
      }
    }
```

- [ ] **Step 4: 응답에 failed 가산 (235-239줄)**

```ts
    return NextResponse.json({
      ok: true,
      result: result?.result ?? null,
      _available_actions: result?._available_actions ?? null,
    });
```
를:
```ts
    return NextResponse.json({
      ok: true,
      result: result?.result ?? null,
      _available_actions: result?._available_actions ?? null,
      ...(failed.length ? { failed } : {}),
    });
```

- [ ] **Step 5: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공(미사용 `fs` import 경고 없으면 OK — `fs`는 layout 읽기/existsSync로 여전히 사용됨).

- [ ] **Step 6: 커밋**

```bash
git add "src/app/api/sessions/[id]/tools/[name]/route.ts"
git commit -m "refactor(tools-route): 상태 쓰기 중앙화 + 원자성 + failed[] 노출"
```

---

## Task 4: variables / modals 라우트 중앙화

**Files:**
- Modify: `src/app/api/sessions/[id]/variables/route.ts`
- Modify: `src/app/api/sessions/[id]/modals/route.ts`

- [ ] **Step 1: variables 라우트 import 추가**

`src/app/api/sessions/[id]/variables/route.ts` 상단에 추가:
```ts
import { mutateSessionJson, applyPatch } from "@/lib/session-state";
```

- [ ] **Step 2: variables 라우트 쓰기 교체 (57-92줄)**

`try { ... } catch { ... }` 블록(읽기→merge→writeFileSync→refreshPanels→return) 전체를 다음으로 교체:
```ts
  const r = await mutateSessionJson(filePath, (current) => {
    const merged = applyPatch(current, patch);
    if (
      patch.__modals && typeof patch.__modals === "object" && !Array.isArray(patch.__modals) &&
      typeof current.__modals === "object" && !Array.isArray(current.__modals) && current.__modals !== null
    ) {
      merged.__modals = {
        ...(current.__modals as Record<string, unknown>),
        ...(patch.__modals as Record<string, unknown>),
      };
    }
    return merged;
  });
  if (!r.ok) {
    return NextResponse.json({ error: `Failed to update ${fileName}` }, { status: 500 });
  }

  if (Array.isArray(refreshPanels) && refreshPanels.length > 0) {
    const instance = getSessionInstance(id);
    if (instance) {
      for (const name of refreshPanels) instance.panels.invalidatePanel(name);
    }
  }

  return NextResponse.json(r.value);
```

> 주: `delete patch.__refreshPanels` 줄(54-55)은 그대로 유지 — applyPatch 호출 전에 patch에서 제거되어 영속되지 않음.

- [ ] **Step 3: modals 라우트 import 추가**

`src/app/api/sessions/[id]/modals/route.ts` 상단에 추가:
```ts
import { mutateSessionJson } from "@/lib/session-state";
```

- [ ] **Step 4: modals 라우트 쓰기 교체 (49-121줄)**

`try { ... } catch (err) { ... }` 블록 전체를 다음으로 교체:
```ts
  try {
    // modal groups (layout.json) — variables와 독립이라 transform 밖에서 읽음
    const layoutPath = path.join(sessionDir, "layout.json");
    let modalGroups: Record<string, string[]> = {};
    if (fs.existsSync(layoutPath)) {
      try {
        let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
        if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
        modalGroups = JSON.parse(layoutRaw)?.panels?.modalGroups || {};
      } catch { /* groups 없이 진행 */ }
    }
    const findGroup = (m: string): string | null => {
      for (const [g, members] of Object.entries(modalGroups)) if (members.includes(m)) return g;
      return null;
    };

    let resultModals: Record<string, unknown> = {};
    const r = await mutateSessionJson(varsPath, (current) => {
      const modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
      switch (action) {
        case "open": {
          const group = findGroup(name!);
          if (group) for (const member of modalGroups[group] || []) if (member !== name) modals[member] = false;
          modals[name!] = mode ?? "dismissible";
          break;
        }
        case "close":
          modals[name!] = false;
          break;
        case "closeAll": {
          const exceptSet = new Set(except || []);
          for (const key of Object.keys(modals)) if (!exceptSet.has(key)) modals[key] = false;
          break;
        }
      }
      resultModals = modals;
      return { ...current, __modals: modals };
    });
    if (!r.ok) {
      return NextResponse.json({ error: "Failed to update modals" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, __modals: resultModals });
  } catch (err) {
    console.error("[modals] error:", err);
    return NextResponse.json({ error: "Failed to update modals" }, { status: 500 });
  }
```

> 주: 기존 변수 선언 `const varsPath = ...` 와 그 존재 확인(`if (!fs.existsSync(varsPath)) ...`)은 위 블록 앞에 그대로 유지. `vars.__modals` 직접 쓰기 로직만 제거되어 transform 안으로 이동.

- [ ] **Step 5: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add "src/app/api/sessions/[id]/variables/route.ts" "src/app/api/sessions/[id]/modals/route.ts"
git commit -m "refactor(state-routes): variables/modals 쓰기 원자화"
```

---

## Task 5: session-instance 훅 3종 + buildJsonLint 중앙화

**Files:**
- Modify: `src/lib/session-instance.ts`

- [ ] **Step 1: import 추가**

`src/lib/session-instance.ts` 상단 import 영역에 추가:
```ts
import {
  mutateSessionJsonSync, applyPatch, loadSessionData,
  resolveSessionFilePath, SYSTEM_JSON, LINT_SKIP_JSON,
} from "./session-state";
```

- [ ] **Step 2: buildJsonLint 로컬 set 교체 (577-581줄)**

```ts
    const SYSTEM_JSON = new Set([
      "session.json", "builder-session.json", "layout.json",
      "chat-history.json", "pending-events.json", "pending-actions.json",
      "package.json", "tsconfig.json", "chat-options.json",
    ]);
```
삭제하고, 585줄의 `if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) continue;` 를
`if (!f.endsWith(".json") || LINT_SKIP_JSON.has(f)) continue;` 로 변경.

- [ ] **Step 3: runMessageHooks 읽기/쓰기 교체 (612-660줄)**

`varsPath` 선언 유지. 그 아래 `let variables ...` 부터 로컬 SYSTEM_JSON + data 루프(614-630)를 다음으로 교체:
```ts
      const { variables, data } = loadSessionData(dir);
```
이후 `const result = fn({ variables: { ...variables }, data, sessionDir: dir, message: messageText });` 는 그대로.
변수/데이터 쓰기(642-660)를 다음으로 교체:
```ts
      if (result.variables && typeof result.variables === "object") {
        mutateSessionJsonSync(varsPath, (current) => applyPatch(current, result.variables as Record<string, unknown>));
      }

      if (result.data && typeof result.data === "object") {
        for (const [rawKey, patch] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
          if (!patch || typeof patch !== "object") continue;
          const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
          if (SYSTEM_JSON.has(fileName)) continue;
          const fp = resolveSessionFilePath(dir, fileName);
          if (!fp) continue;
          mutateSessionJsonSync(fp, (current) => applyPatch(current, patch));
        }
      }
```

- [ ] **Step 4: runAssistantHooks 읽기/쓰기 교체 (680-725줄)**

`varsPath` 선언 유지. 로컬 변수 읽기 + SYSTEM_JSON + data 루프(681-697)를:
```ts
      const { variables, data } = loadSessionData(dir);
```
`const result = fn({ variables: { ...variables }, data, sessionDir: dir, response: responseText });` 그대로.
변수/데이터 쓰기(709-725)를 다음으로 교체:
```ts
      if (result.variables && typeof result.variables === "object") {
        mutateSessionJsonSync(varsPath, (current) => applyPatch(current, result.variables as Record<string, unknown>));
      }

      if (result.data && typeof result.data === "object") {
        for (const [rawKey, patch] of Object.entries(result.data as Record<string, Record<string, unknown>>)) {
          if (!patch || typeof patch !== "object") continue;
          const fileName = rawKey.endsWith(".json") ? rawKey : `${rawKey}.json`;
          if (SYSTEM_JSON.has(fileName)) continue;
          const fp = resolveSessionFilePath(dir, fileName);
          if (!fp) continue;
          mutateSessionJsonSync(fp, (current) => applyPatch(current, patch));
        }
      }
```
(fireAi tail 759줄 이하 그대로 유지.)

- [ ] **Step 5: runStyleCheckHook 카운터/컨텍스트 교체 (859-917줄)**

`varsPath` 선언 유지. 변수 읽기 + 카운터 쓰기(859-866)를 다음으로 교체:
```ts
      let counter = 0;
      const cr = mutateSessionJsonSync(varsPath, (current) => {
        counter = (Number(current.__style_check_counter) || 0) + 1;
        return { ...current, __style_check_counter: counter };
      });
      if (!cr.ok) return;
      const variables = cr.value || {};
```
`if (counter % interval !== 0) return;` 그대로 유지.
로컬 SYSTEM_JSON(904-909) + data 루프(910-917)를 다음으로 교체:
```ts
      const { data } = loadSessionData(dir);
```
이후 `const result = fn({ variables: { ...variables }, data, ... });` 의 `variables`는 위 `cr.value`를 그대로 사용(시그니처 불변).

- [ ] **Step 6: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공. (미사용 `fs` 경고가 나면, session-instance가 다른 곳에서 `fs`를 광범위하게 쓰므로 무관.)

- [ ] **Step 7: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "refactor(session-instance): 훅 3종 read/write 중앙화 + buildJsonLint 상수화"
```

---

## Task 6: panel-engine / session-manager SYSTEM_JSON SSOT import

**Files:**
- Modify: `src/lib/panel-engine.ts`
- Modify: `src/lib/session-manager.ts`

- [ ] **Step 1: panel-engine 로컬 set → import (12-26줄)**

```ts
/** System JSON files that should NOT be loaded as data */
const SYSTEM_JSON = new Set([ ... ]);
```
삭제하고 상단 import에 추가:
```ts
import { SYSTEM_JSON } from "./session-state";
```
(238/443/492줄의 `SYSTEM_JSON` 참조는 그대로 동작.)

- [ ] **Step 2: session-manager 로컬 set → import (52-59줄)**

```ts
/** System JSON files excluded from custom data file loading */
const SYSTEM_JSON = new Set([ ... ]);
```
삭제하고 상단 import에 추가:
```ts
import { SYSTEM_JSON } from "./session-state";
```

- [ ] **Step 3: 순환 의존 없음 확인 + 빌드**

`session-state.ts`는 `fs-retry`만 import하므로 panel-engine/session-manager와 순환 없음.
Run: `npm run build`
Expected: 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add src/lib/panel-engine.ts src/lib/session-manager.ts
git commit -m "refactor(ssot): panel-engine/session-manager SYSTEM_JSON 단일출처 import"
```

---

## Task 7: 전체 검증 (테스트 + 빌드 + 수동 스모크)

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 단위 테스트 전체**

Run: `npx tsx --test src/lib/session-state.test.ts`
Expected: `# pass 16  # fail 0`.

- [ ] **Step 2: 풀 빌드**

Run: `npm run build`
Expected: 타입 에러 0, 빌드 성공.

- [ ] **Step 3: 사전 안전 점검 — 시스템파일을 data로 읽는 훅 존재 여부**

Run(검색): 세션/페르소나 `hooks/` 및 `tools/`에서 다음 참조가 있는지 확인 —
`data['comfyui-config']`, `data['character-tags']`, `data['policy-context']`, `data['style']`, `data['.mcp']`.
Expected: 참조 없음(있으면 해당 훅은 union 적용 후 해당 키를 못 받게 되므로 스펙 §6.1 위험 재평가).

- [ ] **Step 4: 수동 스모크 (dev 서버)**

```bash
npm run dev
```
세션 1개를 열고 확인:
1. 툴 액션(변수+data 패치) 실행 → 파일 갱신, 응답에 `failed` 없음.
2. 패널 모달 open→close → `__modals` 그룹 동작, variables.json 정상.
3. `$merge:'deep'` 패치로 중첩 형제 키 보존, `$unset`으로 키 삭제 확인.
4. on-message 훅 보유 페르소나 1개 → 훅 쓰기 후 다음 턴 [STATE] 헤더에 갱신 반영(순서 보존).
5. 출력 파일 육안 확인: 2-space, BOM 없음, `.tmp` 잔여 없음. panel-engine 리렌더 정상.

- [ ] **Step 5: 최종 커밋(필요 시) + 브랜치 정리**

스모크에서 수정이 있었다면 커밋. 없으면 완료. `superpowers:finishing-a-development-branch`로 머지/PR 결정.

---

## Self-Review 결과

- **스펙 커버리지**: §3.1 API→T1·T2 / §3.2 applyPatch→T1 / §3.3 원자쓰기→T2 / §4 SSOT→T1(상수)·T5(buildJsonLint)·T6(import) / §5.1 tools→T3 / §5.2 variables→T4 / §5.3 modals→T4 / §5.4 훅→T5 / §6 위험→T7 Step3 / §7 검증→T7. 누락 없음.
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드 포함. "적절히 처리" 류 없음.
- **타입 일관성**: `PatchResult{ok,value?,error?}`·`mutateSessionJson(Sync)`·`applyPatch`·`loadSessionData`·`resolveSessionFilePath`·`SYSTEM_JSON`·`LINT_SKIP_JSON` 시그니처가 T1·T2 정의와 T3~T6 사용처에서 일치.
- **회귀 방지**: 훅은 동기(`mutateSessionJsonSync`)라 `buildHintSnapshot` 순서 보존(스펙 §3 핵심 제약).
