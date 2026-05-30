# 쓰기경로 통합 (Wave 5) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 모달-그룹 병합 중복을 `modal-merge.ts`로 추출하고 `clearPopups`를 원자적 쓰기로 흡수한다 (behavior-preserving).

**Architecture:** 순수 함수 모듈(`modal-merge.ts`) + 2개 라우트 치환 + 1개 메서드 마이그레이션. 핵심 로직은 fs 분리 순수 함수라 `node:test`로 단위검증.

**Tech Stack:** TypeScript(strict), Next.js App Router, `node:test` via `npx tsx --test`.

Spec: [2026-05-31-write-path-consolidation-design.md](./2026-05-31-write-path-consolidation-design.md)

---

### Task 1: `modal-merge.ts` 모듈 + 단위 테스트 (TDD)

**Files:**
- Create: `src/lib/modal-merge.ts`
- Test: `src/lib/modal-merge.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/modal-merge.test.ts`

```ts
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyModalChange, closeAllModals, readModalGroups } from "./modal-merge";

test("applyModalChange: opening a group member closes siblings", () => {
  const groups = { g1: ["a", "b", "c"] };
  const r = applyModalChange({ a: false, b: "dismissible" }, groups, "a", true);
  assert.equal(r.a, true);
  assert.equal(r.b, false);
});

test("applyModalChange: opening a non-group modal sets only itself", () => {
  const groups = { g1: ["a", "b"] };
  const r = applyModalChange({ a: "dismissible", z: false }, groups, "z", "dismissible");
  assert.equal(r.z, "dismissible");
  assert.equal(r.a, "dismissible");
});

test("applyModalChange: falsy value closes self without touching siblings", () => {
  const groups = { g1: ["a", "b"] };
  const r = applyModalChange({ a: true, b: true }, groups, "a", false);
  assert.equal(r.a, false);
  assert.equal(r.b, true);
});

test("applyModalChange: does not mutate input", () => {
  const groups = { g1: ["a", "b"] };
  const input: Record<string, unknown> = { a: false, b: true };
  applyModalChange(input, groups, "a", true);
  assert.equal(input.a, false);
  assert.equal(input.b, true);
});

test("applyModalChange: first matching group only", () => {
  const groups = { g1: ["a", "b"], g2: ["a", "c"] };
  const r = applyModalChange({ a: false, b: true, c: true }, groups, "a", true);
  assert.equal(r.a, true);
  assert.equal(r.b, false);
  assert.equal(r.c, true);
});

test("closeAllModals: closes all except listed", () => {
  const r = closeAllModals({ a: true, b: "dismissible", c: false }, ["b"]);
  assert.equal(r.a, false);
  assert.equal(r.b, "dismissible");
  assert.equal(r.c, false);
});

test("closeAllModals: empty except closes everything", () => {
  const r = closeAllModals({ a: true, b: true });
  assert.equal(r.a, false);
  assert.equal(r.b, false);
});

test("closeAllModals: does not mutate input", () => {
  const input: Record<string, unknown> = { a: true };
  closeAllModals(input);
  assert.equal(input.a, true);
});

test("readModalGroups: reads panels.modalGroups", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"),
      JSON.stringify({ panels: { modalGroups: { g1: ["a", "b"] } } }), "utf-8");
    assert.deepEqual(readModalGroups(dir), { g1: ["a", "b"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: BOM-prefixed layout.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"),
      "﻿" + JSON.stringify({ panels: { modalGroups: { g: ["x"] } } }), "utf-8");
    assert.deepEqual(readModalGroups(dir), { g: ["x"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: missing file → {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try { assert.deepEqual(readModalGroups(dir), {}); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readModalGroups: broken JSON → {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modal-merge-"));
  try {
    fs.writeFileSync(path.join(dir, "layout.json"), "{not json", "utf-8");
    assert.deepEqual(readModalGroups(dir), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 테스트 실패 확인** — Run: `npx tsx --test src/lib/modal-merge.test.ts` → FAIL (모듈 없음).

- [ ] **Step 3: 모듈 구현** — `src/lib/modal-merge.ts`

```ts
import * as fs from "fs";
import * as path from "path";

type Dict = Record<string, unknown>;

/** layout.json → panels.modalGroups. BOM 내성, 어떤 오류든 {} 반환. */
export function readModalGroups(sessionDir: string): Record<string, string[]> {
  const layoutPath = path.join(sessionDir, "layout.json");
  try {
    let raw = fs.readFileSync(layoutPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const groups = JSON.parse(raw)?.panels?.modalGroups;
    return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
  } catch {
    return {};
  }
}

/** name을 포함하는 첫 그룹의 멤버 배열, 없으면 null. */
function findGroup(groups: Record<string, string[]>, name: string): string[] | null {
  for (const members of Object.values(groups)) {
    if (Array.isArray(members) && members.includes(name)) return members;
  }
  return null;
}

/**
 * 단일 모달 변경 + 그룹 자동닫기. 입력을 변형하지 않고 새 맵 반환.
 *  - value truthy: 같은 그룹 형제 false 처리 후 next[name] = value
 *  - value falsy : next[name] = false
 */
export function applyModalChange(
  modals: Dict,
  groups: Record<string, string[]>,
  name: string,
  value: unknown,
): Dict {
  const next: Dict = { ...modals };
  if (value) {
    const members = findGroup(groups, name);
    if (members) for (const m of members) if (m !== name) next[m] = false;
    next[name] = value;
  } else {
    next[name] = false;
  }
  return next;
}

/** except에 없는 모든 키를 false로. 새 맵 반환. */
export function closeAllModals(modals: Dict, except: string[] = []): Dict {
  const exceptSet = new Set(except);
  const next: Dict = { ...modals };
  for (const key of Object.keys(next)) if (!exceptSet.has(key)) next[key] = false;
  return next;
}
```

- [ ] **Step 4: 테스트 통과 확인** — Run: `npx tsx --test src/lib/modal-merge.test.ts` → 12 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/modal-merge.ts src/lib/modal-merge.test.ts
git commit -m "feat(modal-merge): extract group-aware modal visibility helpers"
```

---

### Task 2: modals/route.ts 치환

**Files:**
- Modify: `src/app/api/sessions/[id]/modals/route.ts`

- [ ] **Step 1: import 교체 + 그룹 읽기 치환**

상단 import에 추가: `import { readModalGroups, applyModalChange, closeAllModals } from "@/lib/modal-merge";`

`try { ... }` 블록 안의 inline layout 읽기(line 51–64, `modalGroups`/`findGroup` 지역 정의)를 제거하고
한 줄로 치환:
```ts
const modalGroups = readModalGroups(sessionDir);
```

- [ ] **Step 2: switch 본문을 헬퍼로 치환**

`mutateSessionJson` transform 내부 switch를:
```ts
let resultModals: Record<string, unknown> = {};
const r = await mutateSessionJson(varsPath, (current) => {
  let modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
  switch (action) {
    case "open":
      modals = applyModalChange(modals, modalGroups, name!, mode ?? "dismissible");
      break;
    case "close":
      modals = applyModalChange(modals, modalGroups, name!, false);
      break;
    case "closeAll":
      modals = closeAllModals(modals, except || []);
      break;
  }
  resultModals = modals;
  return { ...current, __modals: modals };
});
```

- [ ] **Step 3: 빌드/검증** — Run: `npx tsc --noEmit` (또는 Task 4의 build에서 확인). 라우트 응답 형태(`{ ok, __modals }`)·에러 분기 변경 없음 확인.

- [ ] **Step 4: 커밋**

```bash
git add "src/app/api/sessions/[id]/modals/route.ts"
git commit -m "refactor(modals-route): use shared modal-merge helpers"
```

---

### Task 3: tools/[name]/route.ts 치환

**Files:**
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts`

- [ ] **Step 1: import 추가** — 상단에:
```ts
import { readModalGroups, applyModalChange } from "@/lib/modal-merge";
```

- [ ] **Step 2: modalChanges 적용부 치환** (현행 line 103–128)

```ts
if (modalChanges && typeof modalChanges === "object" && !Array.isArray(modalChanges)) {
  let modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
  const modalGroups = readModalGroups(sessionDir);
  for (const [mName, value] of Object.entries(modalChanges)) {
    modals = applyModalChange(modals, modalGroups, mName, value);
  }
  merged.__modals = modals;
}
```

inline layout BOM strip 읽기 블록(line 105–113)은 `readModalGroups` 호출로 흡수되어 제거됨.

- [ ] **Step 3: 검증** — Task 4 build에서 확인. 동작: value truthy → 그룹 형제 닫고 설정, falsy → false (현행과 동일).

- [ ] **Step 4: 커밋**

```bash
git add "src/app/api/sessions/[id]/tools/[name]/route.ts"
git commit -m "refactor(tools-route): use shared modal-merge helpers for __modals"
```

---

### Task 4: clearPopups 원자화

**Files:**
- Modify: `src/lib/session-instance.ts` (clearPopups, 현행 line 902–914)

- [ ] **Step 1: import 확인/추가** — `session-instance.ts` 상단 import에 `readSessionJson`이 없으면
`@/lib/session-state` import 구문에 추가(`mutateSessionJsonSync`는 Wave 1에서 이미 존재할 가능성 높음 — 확인 후 없으면 추가).

- [ ] **Step 2: clearPopups 본문 치환**

```ts
/** Clear __popups from variables.json (called on new user message) */
clearPopups(): void {
  const dir = this.getDir();
  if (!dir) return;
  const varsPath = path.join(dir, "variables.json");
  let current: Record<string, unknown> | null;
  try {
    current = readSessionJson(varsPath);
  } catch {
    return; // corrupt → 덮어쓰지 않고 보존
  }
  if (!current) return; // 없음 → 생성하지 않음
  if (!Array.isArray(current.__popups) || current.__popups.length === 0) return; // 비었으면 no-op
  const r = mutateSessionJsonSync(varsPath, (c) => ({ ...c, __popups: [] }));
  if (r.ok) this.panels.scheduleRender();
}
```

- [ ] **Step 3: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "refactor(clearPopups): route through atomic mutateSessionJsonSync"
```

---

### Task 5: 최종 빌드 검증

- [ ] **Step 1: 단위 테스트 재실행** — Run: `npx tsx --test src/lib/modal-merge.test.ts` → 12 PASS.
- [ ] **Step 2: 프로덕션 빌드** — Run: `npm run build` → TypeScript strict 통과 + Next 빌드 성공.
- [ ] **Step 3: 미커밋 사용자 파일 무오염 확인** — Run: `git status --short` →
  사용자 파일(`builder-prompt.md`, `data/**/SKILL.md`, `session-shared.md`, `src/mcp/claude-play-mcp-server.mjs`,
  스펙 doc)이 여전히 `M` 상태이고 **내 커밋에 포함되지 않았는지** 확인.
