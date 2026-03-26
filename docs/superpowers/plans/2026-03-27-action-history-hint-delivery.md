# Action History & Hint Rules Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tool 실행 액션을 자동 추적하고, hint rules 스냅샷과 함께 매 사용자 메시지에 prepend하여 AI에게 상시 컨텍스트를 제공한다.

**Architecture:** SessionInstance에 action queue와 hint snapshot 생성을 추가. Tool 실행 API에서 액션을 파일 기반으로 큐잉하고, 두 채팅 전송 경로(HTTP/WS)에서 메시지 조립 시 event queue + hint snapshot + action history + user text 순서로 합친다. MCP 서버의 기존 `buildSnapshot()` 인라인 함수는 유지한다 (`.mjs`에서 `.ts` import 불가).

**Tech Stack:** TypeScript, Node.js fs, Next.js API routes, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-27-action-history-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/hint-snapshot.ts` | Create | `buildSnapshot()` + `buildHintSnapshotLine()` 로직 — SessionInstance 전용 |
| `src/lib/session-instance.ts` | Modify | `queueAction()`, `flushActions()`, `buildHintSnapshot()` 추가 |
| `src/app/api/sessions/[id]/tools/[name]/route.ts` | Modify | Tool 실행 후 action 파일 기반 큐잉 + SYSTEM_JSON 등록 |
| `src/app/api/chat/send/route.ts` | Modify | 메시지 조립에 hint snapshot + action history 추가 |
| `src/lib/ws-server.ts` | Modify | 메시지 조립에 hint snapshot + action history 추가 (일반 + silent 경로) |
| `src/lib/panel-engine.ts` | Modify | SYSTEM_JSON에 `pending-actions.json` 추가 |
| `src/lib/session-manager.ts` | Modify | SYSTEM_JSON에 `pending-actions.json` 추가 |

Note: MCP 서버(`src/mcp/claude-bridge-mcp-server.mjs`)의 인라인 `readHintRules()` + `buildSnapshot()`은 변경하지 않는다. `.mjs` 파일은 plain `node`로 실행되므로 `.ts` import가 불가능하다. 두 곳에 로직이 중복되지만 passthrough keys 변경 시 양쪽 업데이트 필요하다는 주석을 남긴다.

---

### Task 1: hint-snapshot.ts 공유 모듈 생성

MCP 서버의 `readHintRules()` + `buildSnapshot()` 로직을 TypeScript로 포팅하여 SessionInstance에서 사용한다.

**Files:**
- Create: `src/lib/hint-snapshot.ts`

- [ ] **Step 1: `src/lib/hint-snapshot.ts` 작성**

MCP 서버(`src/mcp/claude-bridge-mcp-server.mjs` lines 839-905)의 로직을 TypeScript로 포팅한다.

```typescript
import fs from "fs";
import path from "path";

export interface HintRule {
  format?: string;
  max?: number;
  max_key?: string;
  tiers?: { max: number; hint: string }[];
  tier_mode?: "percentage" | "value";
}

export type HintRules = Record<string, HintRule>;

export type SnapshotEntry = string | { display: string; hint?: string };
export type Snapshot = Record<string, SnapshotEntry>;

// Keep in sync with src/mcp/claude-bridge-mcp-server.mjs buildSnapshot()
const PASSTHROUGH_KEYS = [
  "location", "owner_location", "time", "outfit",
  "cycle_phase", "cycle_day", "day_number",
];

export function readHintRules(sessionDir: string): HintRules | null {
  const rulesPath = path.join(sessionDir, "hint-rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

export function buildSnapshot(
  vars: Record<string, unknown>,
  hintRules: HintRules
): Snapshot {
  const snapshot: Snapshot = {};

  for (const [key, rule] of Object.entries(hintRules)) {
    const value = vars[key];
    if (value === undefined) continue;

    const entry: { display: string; hint?: string } = { display: "" };

    if (rule.format) {
      let formatted = rule.format;
      formatted = formatted.replace("{value}", String(value));
      if (rule.max_key && vars[rule.max_key] !== undefined) {
        formatted = formatted.replace("{max}", String(vars[rule.max_key]));
      } else if (rule.max !== undefined) {
        formatted = formatted.replace("{max}", String(rule.max));
      }
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      if (typeof value === "number" && typeof maxVal === "number" && maxVal > 0) {
        const pct = Math.round((value / maxVal) * 100);
        formatted = formatted.replace("{pct}", String(pct));
      }
      entry.display = formatted;
    } else {
      entry.display = String(value);
    }

    if (Array.isArray(rule.tiers) && typeof value === "number") {
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      const pct = typeof maxVal === "number" && maxVal > 0
        ? (value / maxVal) * 100
        : value;
      const checkValue = rule.tier_mode === "percentage" ? pct : value;
      for (const tier of rule.tiers) {
        if (checkValue <= tier.max) {
          entry.hint = tier.hint;
          break;
        }
      }
    }

    snapshot[key] = typeof value === "string" ? entry.display : entry;
  }

  for (const passKey of PASSTHROUGH_KEYS) {
    if (vars[passKey] !== undefined && !(passKey in snapshot)) {
      snapshot[passKey] = String(vars[passKey]);
    }
  }

  return snapshot;
}

/**
 * Build a one-line [STATE] string for chat message prepending.
 * Returns empty string if no hint-rules.json exists.
 */
export function buildHintSnapshotLine(sessionDir: string): string {
  const rules = readHintRules(sessionDir);
  if (!rules) return "";

  const varsPath = path.join(sessionDir, "variables.json");
  let vars: Record<string, unknown> = {};
  try {
    if (fs.existsSync(varsPath)) {
      vars = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
    }
  } catch { /* ignore */ }

  const snapshot = buildSnapshot(vars, rules);
  if (Object.keys(snapshot).length === 0) return "";

  const parts: string[] = [];
  for (const [key, entry] of Object.entries(snapshot)) {
    if (typeof entry === "string") {
      parts.push(`${key}=${entry}`);
    } else {
      const hint = entry.hint ? `(hint: "${entry.hint}")` : "";
      parts.push(`${key}=${entry.display}${hint}`);
    }
  }

  return `[STATE] ${parts.join(", ")}`;
}
```

- [ ] **Step 2: MCP 서버에 동기화 주석 추가**

`src/mcp/claude-bridge-mcp-server.mjs`의 `readHintRules()` 함수(line 839) 위에 주석 추가:

```javascript
// Keep in sync with src/lib/hint-snapshot.ts (cannot import .ts from .mjs)
```

- [ ] **Step 3: 커밋**

```bash
git add src/lib/hint-snapshot.ts src/mcp/claude-bridge-mcp-server.mjs
git commit -m "feat: create hint snapshot module for chat message state delivery"
```

---

### Task 2: SessionInstance에 Action Queue + Hint Snapshot 추가

이벤트 큐와 대칭적인 액션 큐 메서드와 hint snapshot 메서드를 추가한다.

**Files:**
- Modify: `src/lib/session-instance.ts` (이벤트 큐 메서드 `getPendingEvents()` 아래에 추가)

- [ ] **Step 1: 상단에 import 추가**

```typescript
import { buildHintSnapshotLine } from "./hint-snapshot";
```

- [ ] **Step 2: `ActionRecord` 타입을 export로 파일 상단(또는 클래스 외부)에 정의**

```typescript
export interface ActionRecord {
  tool: string;
  action: string;
  args?: Record<string, unknown>;
}
```

- [ ] **Step 3: 액션 큐 메서드 추가**

`getPendingEvents()` 메서드 아래에 추가:

```typescript
// --- Action history queue ---

private get pendingActionsPath(): string | null {
  const dir = this.getDir();
  return dir ? path.join(dir, "pending-actions.json") : null;
}

private readPendingActions(): ActionRecord[] {
  const fp = this.pendingActionsPath;
  if (!fp) return [];
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

private writePendingActions(actions: ActionRecord[]): void {
  const fp = this.pendingActionsPath;
  if (!fp) return;
  try {
    if (actions.length === 0) {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } else {
      fs.writeFileSync(fp, JSON.stringify(actions), "utf-8");
    }
  } catch { /* ignore */ }
}

queueAction(record: ActionRecord): void {
  const actions = this.readPendingActions();
  actions.push(record);
  this.writePendingActions(actions);
}

flushActions(): string {
  const actions = this.readPendingActions();
  if (actions.length === 0) return "";
  this.writePendingActions([]);
  return actions
    .map(a => {
      const argsStr = a.args ? `, args=${JSON.stringify(a.args)}` : "";
      return `[ACTION_LOG] tool=${a.tool}, action=${a.action}${argsStr}`;
    })
    .join("\n");
}

getPendingActions(): ActionRecord[] {
  return this.readPendingActions();
}
```

- [ ] **Step 4: `buildHintSnapshot()` 메서드 추가**

```typescript
buildHintSnapshot(): string {
  const dir = this.getDir();
  if (!dir) return "";
  return buildHintSnapshotLine(dir);
}
```

- [ ] **Step 5: 커밋**

```bash
git add src/lib/session-instance.ts
git commit -m "feat: add action queue and hint snapshot to SessionInstance"
```

---

### Task 3: SYSTEM_JSON 제외 목록 업데이트

세 곳의 SYSTEM_JSON 세트에 `pending-actions.json`을 추가한다. tools route에는 누락된 `pending-events.json`도 함께 추가.

**Files:**
- Modify: `src/lib/panel-engine.ts:12-25`
- Modify: `src/lib/session-manager.ts:53-59`
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts:11-16`

- [ ] **Step 1: panel-engine.ts — `"pending-events.json"` 뒤에 추가**

```typescript
"pending-actions.json",
```

- [ ] **Step 2: session-manager.ts — `"pending-events.json"` 뒤에 추가**

```typescript
"pending-actions.json",
```

- [ ] **Step 3: tools/[name]/route.ts — `"policy-context.json"` 뒤에 추가**

```typescript
"pending-events.json", "pending-actions.json",
```

(이 파일에는 `pending-events.json`이 누락되어 있었으므로 둘 다 추가 — 기존 버그 수정 포함)

- [ ] **Step 4: 커밋**

```bash
git add src/lib/panel-engine.ts src/lib/session-manager.ts "src/app/api/sessions/[id]/tools/[name]/route.ts"
git commit -m "chore: add pending-actions.json to SYSTEM_JSON exclusion lists

Also adds missing pending-events.json to tools route SYSTEM_JSON."
```

---

### Task 4: Tool 실행 API에서 액션 큐잉

Tool 실행 후 `noActionLog: true`가 아니고 MCP 경유가 아니면 액션을 `pending-actions.json`에 직접 기록한다.

**주의**: 이 route에는 `SessionInstance`에 대한 참조가 없다. `sessionDir`을 이용해 파일에 직접 쓴다.

**Files:**
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts`

- [ ] **Step 1: import 추가 + 헬퍼 함수 작성**

상단에 import 추가:

```typescript
import { validateInternalToken } from "@/lib/auth";
```

SYSTEM_JSON 세트 아래에 헬퍼 함수 추가:

```typescript
function queueActionToFile(
  sessionDir: string,
  record: { tool: string; action: string; args?: Record<string, unknown> }
): void {
  const fp = path.join(sessionDir, "pending-actions.json");
  try {
    let actions: unknown[] = [];
    if (fs.existsSync(fp)) {
      actions = JSON.parse(fs.readFileSync(fp, "utf-8"));
    }
    actions.push(record);
    fs.writeFileSync(fp, JSON.stringify(actions), "utf-8");
  } catch { /* ignore */ }
}
```

(`path`와 `fs` import가 이미 있는지 확인, 없으면 추가)

- [ ] **Step 2: Tool 실행 결과 처리 후 액션 큐잉 추가**

Variables/data merge 로직 이후, response 반환 전에 추가:

```typescript
// Queue action for action history (skip MCP-originated and noActionLog)
const isMcpRequest = validateInternalToken(req);
const noActionLog = !!(result as Record<string, unknown>)?.noActionLog;
if (!isMcpRequest && !noActionLog) {
  const actionName = (args as Record<string, unknown>)?.action;
  queueActionToFile(sessionDir, {
    tool: name,
    action: typeof actionName === "string" ? actionName : "execute",
    args: args as Record<string, unknown> | undefined,
  });
}
```

- [ ] **Step 3: 커밋**

```bash
git add "src/app/api/sessions/[id]/tools/[name]/route.ts"
git commit -m "feat: queue tool executions to action history file"
```

---

### Task 5: 채팅 전송 시 메시지 조립

두 전송 경로(HTTP + WebSocket)에서 event queue + hint snapshot + action history + user text를 조립한다.

**Files:**
- Modify: `src/app/api/chat/send/route.ts:17-19`
- Modify: `src/lib/ws-server.ts:145-178`

- [ ] **Step 1: HTTP 경로 수정 (`chat/send/route.ts`)**

기존 코드 (lines 17-19):
```typescript
const eventHeaders = isOOC ? "" : instance.flushEvents();
const aiText = eventHeaders ? `${eventHeaders}\n${text}` : text;
instance.claude.send(aiText);
```

변경:
```typescript
const eventHeaders = isOOC ? "" : instance.flushEvents();
const hintSnapshot = isOOC ? "" : instance.buildHintSnapshot();
const actionHistory = isOOC ? "" : instance.flushActions();
const parts = [eventHeaders, hintSnapshot, actionHistory, text].filter(Boolean);
instance.claude.send(parts.join("\n"));
```

- [ ] **Step 2: WebSocket silent 경로 수정 (`ws-server.ts`)**

기존 코드 (lines 155-159):
```typescript
const eventHeaders = instance.flushEvents();
const aiText = `${eventHeaders}${eventHeaders ? "\n" : ""}${text}`;
instance.claude.send(aiText);
```

변경:
```typescript
const eventHeaders = instance.flushEvents();
const hintSnapshot = instance.buildHintSnapshot();
const actionHistory = instance.flushActions();
const parts = [eventHeaders, hintSnapshot, actionHistory, text].filter(Boolean);
instance.claude.send(parts.join("\n"));
```

- [ ] **Step 3: WebSocket 일반 경로 수정 (`ws-server.ts`)**

기존 코드 (lines 170-174):
```typescript
const eventHeaders = isOOC ? "" : instance.flushEvents();
const oocHint = isOOC ? "[OOC 메시지입니다. RP 응답(dialog_response)을 포함하지 마세요. 메타/시스템 수준으로만 응답하세요.]\n" : "";
const aiText = `${oocHint}${eventHeaders}${eventHeaders ? "\n" : ""}${text}`;
instance.claude.send(aiText);
```

변경:
```typescript
const eventHeaders = isOOC ? "" : instance.flushEvents();
const hintSnapshot = isOOC ? "" : instance.buildHintSnapshot();
const actionHistory = isOOC ? "" : instance.flushActions();
const oocHint = isOOC ? "[OOC 메시지입니다. RP 응답(dialog_response)을 포함하지 마세요. 메타/시스템 수준으로만 응답하세요.]\n" : "";
const parts = [oocHint, eventHeaders, hintSnapshot, actionHistory, text].filter(Boolean);
instance.claude.send(parts.join("\n"));
```

- [ ] **Step 4: 커밋**

```bash
git add src/app/api/chat/send/route.ts src/lib/ws-server.ts
git commit -m "feat: assemble hint snapshot and action history into chat messages"
```

---

### Task 6: 빌드 검증 및 통합 테스트

타입 체크 + 실제 세션에서 전체 흐름을 수동 검증한다.

- [ ] **Step 1: 타입 체크**

```bash
npm run build
```

타입 에러가 있으면 수정 후 커밋.

- [ ] **Step 2: dev 서버 시작 및 hint rules 확인**

```bash
npm run dev
```

1. `hint-rules.json`이 있는 페르소나로 세션 생성
2. 채팅 메시지 전송
3. AI 응답에서 `[STATE]` 정보가 반영되는지 확인

- [ ] **Step 3: 선택지 액션 → ACTION_LOG 확인**

1. AI가 선택지(actions 포함)를 제시하면 클릭
2. 다음 채팅 메시지 전송
3. `[ACTION_LOG]` 줄이 메시지에 포함되는지 확인

- [ ] **Step 4: noActionLog 테스트**

1. Tool에서 `{ noActionLog: true }` 반환하도록 임시 수정
2. 해당 tool 실행 후 다음 메시지에 ACTION_LOG가 없는지 확인

- [ ] **Step 5: OOC 메시지에서 flush 안 되는지 확인**

1. 액션 실행 후 OOC 메시지 전송 → ACTION_LOG 미포함 확인
2. 이후 일반 메시지 전송 → ACTION_LOG 포함 확인
