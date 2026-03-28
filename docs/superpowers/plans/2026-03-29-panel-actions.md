# Panel Actions System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 선택지와 패널 UI 버튼이 동일한 "패널 액션"을 호출하는 통합 액션 시스템을 구축한다. 패널 액션이 공유 로직의 primary이고, UI 버튼과 선택지 모두 이를 래핑한다. ActionHistory도 패널 액션 단위로 기록된다.

**Architecture:** 패널 HTML에 `<panel-actions>` 태그로 메타데이터를 선언하고, `__panelBridge.registerAction()`으로 핸들러를 등록한다. 패널 버튼의 기존 클릭 핸들러는 `registerAction`된 핸들러를 호출하도록 리팩토링된다. 레지스트리가 모든 실행을 기록하여 `[ACTION_LOG]`와 `[AVAILABLE]` 헤더를 생성한다.

**Tech Stack:** React 19, TypeScript, Next.js 15, Shadow DOM, CustomEvent API

**No test framework** configured — verification is manual (dev server + browser).

---

## Architecture Diagram

```
[기존]
패널 버튼 → inline handler (runTool + 애니메이션) → pending-actions.json (tool 기록)
선택지 → runTool("engine", ...) → pending-actions.json (tool 기록)
AI 메시지 ← [ACTION_LOG] tool=engine, action=advance_slot

[변경 후]
패널 버튼 → registry.execute("advance", "advance_slot") → 핸들러 (runTool + 애니메이션)
선택지 → 모달 오픈 → registry.execute("advance", "advance_slot") → 같은 핸들러
                         ↓
              레지스트리가 실행 기록 → pending-actions.json (패널 액션 기록)
AI 메시지 ← [ACTION_LOG] advance.advance_slot
AI 메시지 ← [AVAILABLE] advance.advance_slot(스케줄 진행), schedule.confirm_schedule(스케줄 확정 ...)
```

**핵심:** 패널 액션 핸들러가 유일한 실행 경로. 버튼이든 선택지든 같은 핸들러를 호출.

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Create:** `src/lib/panel-action-registry.ts` | 중앙 레지스트리: 메타데이터, 핸들러, 실행 기록, available/history 헤더 생성 |
| **Modify:** `src/lib/use-panel-bridge.ts` | `registerAction()` + `executeAction()` 메서드 추가 |
| **Modify:** `src/components/ModalPanel.tsx` | `<panel-actions>` 파싱, 패널 이름 컨텍스트, cleanup |
| **Modify:** `src/components/DockPanel.tsx` | 동일 파싱 로직 |
| **Modify:** `src/components/PanelArea.tsx` | 동일 파싱 로직 |
| **Modify:** `src/components/ChatInput.tsx` | `{panel: ...}` 액션 타입 처리 |
| **Modify:** `src/components/ChatMessages.tsx` | `ChoiceAction` 인터페이스 확장 |
| **Modify:** `src/lib/session-instance.ts` | `ActionRecord` → `PanelActionRecord`, `flushActions()` 형식 변경 |
| **Modify:** `src/app/api/sessions/[id]/tools/[name]/route.ts` | 액션 기록을 패널 액션 형식으로 전환 |
| **Create:** `src/app/api/sessions/[id]/panel-actions/route.ts` | 패널 액션 실행 기록 API |
| **Modify:** `src/app/chat/[sessionId]/page.tsx` | 레지스트리 variables 동기화 |
| **Modify:** `session-shared.md` | AI 가이드 업데이트 |
| **Modify:** `data/sample-personas/princessmaker/panels/08-advance.html` | 패널 액션 선언 + 버튼→액션 리팩토링 |
| **Modify:** `data/sample-personas/princessmaker/panels/03-schedule.html` | 패널 액션 선언 + 버튼→액션 리팩토링 |
| **Move:** `data/tools/comfyui/skills/panel-design/` → `data/skills/panel-design/` | 범용 스킬 디렉토리 분리 |
| **Modify:** `src/lib/session-manager.ts` | `copyToolSkills()`에 `data/skills/` 스캔 추가 |
| **Modify:** `data/skills/panel-design/SKILL.md` | 패널 액션 시스템 원칙 반영 |
| **Modify:** `data/skills/panel-design/references/bridge-api.md` | `registerAction`, `executeAction` 메서드 문서 추가 |

---

### Task 1: Panel Action Registry 모듈 생성

**Files:**
- Create: `src/lib/panel-action-registry.ts`

클라이언트 사이드 싱글턴. 메타데이터, 핸들러, 실행 기록, available/history 헤더 생성을 담당.

- [ ] **Step 1: 레지스트리 모듈 작성**

```typescript
// src/lib/panel-action-registry.ts

export interface PanelActionMeta {
  id: string;
  panel: string;
  label: string;
  description: string;
  params?: Record<string, string>; // param name → description
  available_when?: string; // expression evaluated against variables
}

export type PanelActionHandler = (params?: Record<string, unknown>) => Promise<void>;

interface RegisteredAction {
  meta: PanelActionMeta;
  handler: PanelActionHandler | null;
}

export interface PanelActionRecord {
  panel: string;
  action: string;
  params?: Record<string, unknown>;
}

class PanelActionRegistry {
  private actions = new Map<string, RegisteredAction>();
  private variables: Record<string, unknown> = {};
  private sessionId: string | null = null;

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Register metadata from <panel-actions> tag */
  registerMeta(panel: string, metas: Array<Omit<PanelActionMeta, "panel">>): void {
    for (const key of this.actions.keys()) {
      if (key.startsWith(panel + ".")) {
        const existing = this.actions.get(key)!;
        // Preserve handler if re-registering meta (panel re-render)
        if (!metas.some(m => `${panel}.${m.id}` === key)) {
          this.actions.delete(key);
        }
      }
    }
    for (const m of metas) {
      const key = `${panel}.${m.id}`;
      const existing = this.actions.get(key);
      this.actions.set(key, {
        meta: { ...m, panel },
        handler: existing?.handler ?? null,
      });
    }
  }

  /** Register runtime handler from panel script */
  registerHandler(panel: string, actionId: string, handler: PanelActionHandler): void {
    const key = `${panel}.${actionId}`;
    const existing = this.actions.get(key);
    if (existing) {
      existing.handler = handler;
    } else {
      this.actions.set(key, {
        meta: { id: actionId, panel, label: actionId, description: "" },
        handler,
      });
    }
    window.dispatchEvent(new CustomEvent("__panel_action_registered", { detail: key }));
  }

  updateVariables(vars: Record<string, unknown>): void {
    this.variables = vars;
  }

  private isAvailable(action: RegisteredAction): boolean {
    const expr = action.meta.available_when;
    if (!expr) return true;
    try {
      const fn = new Function(...Object.keys(this.variables), `return (${expr})`);
      return !!fn(...Object.values(this.variables));
    } catch {
      return false;
    }
  }

  getAvailable(): PanelActionMeta[] {
    const result: PanelActionMeta[] = [];
    for (const entry of this.actions.values()) {
      if (this.isAvailable(entry)) result.push(entry.meta);
    }
    return result;
  }

  /** Build [AVAILABLE] header string */
  buildAvailableHeader(): string {
    const available = this.getAvailable();
    if (available.length === 0) return "";
    const parts = available.map((a) => {
      const paramKeys = a.params ? Object.keys(a.params).join(", ") : "";
      return paramKeys
        ? `${a.panel}.${a.id}(${a.label} ${paramKeys})`
        : `${a.panel}.${a.id}(${a.label})`;
    });
    return `[AVAILABLE] ${parts.join(", ")}`;
  }

  /**
   * Execute a panel action and record it.
   * This is the ONLY execution path — both UI buttons and choices call this.
   */
  async execute(panel: string, actionId: string, params?: Record<string, unknown>): Promise<void> {
    const key = `${panel}.${actionId}`;
    const entry = this.actions.get(key);
    if (!entry?.handler) {
      throw new Error(`Panel action handler not found: ${key}`);
    }
    // Record execution to server
    await this.recordAction({ panel, action: actionId, params });
    // Execute handler
    await entry.handler(params);
  }

  /** Record panel action execution to server (pending-actions.json) */
  private async recordAction(record: PanelActionRecord): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/panel-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch {
      console.warn("[PanelActionRegistry] Failed to record action:", record);
    }
  }

  /** Wait for handler registration (with timeout) */
  waitForHandler(panel: string, actionId: string, timeoutMs = 5000): Promise<void> {
    const key = `${panel}.${actionId}`;
    const entry = this.actions.get(key);
    if (entry?.handler) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("__panel_action_registered", listener);
        reject(new Error(`Timeout waiting for handler: ${key}`));
      }, timeoutMs);

      const listener = (e: Event) => {
        if ((e as CustomEvent).detail === key) {
          clearTimeout(timer);
          window.removeEventListener("__panel_action_registered", listener);
          resolve();
        }
      };
      window.addEventListener("__panel_action_registered", listener);
    });
  }

  clearPanel(panel: string): void {
    for (const key of this.actions.keys()) {
      if (key.startsWith(panel + ".")) this.actions.delete(key);
    }
  }

  clear(): void {
    this.actions.clear();
  }
}

let instance: PanelActionRegistry | null = null;

export function getPanelActionRegistry(): PanelActionRegistry {
  if (!instance) instance = new PanelActionRegistry();
  return instance;
}

/** Parse <panel-actions> JSON from panel HTML string */
export function parsePanelActions(html: string): Array<Omit<PanelActionMeta, "panel">> {
  const openTag = "<panel-actions>";
  const closeTag = "</panel-actions>";
  const idx = html.indexOf(openTag);
  if (idx === -1) return [];
  const start = idx + openTag.length;
  const end = html.indexOf(closeTag, start);
  if (end === -1) return [];
  const jsonStr = html.substring(start, end).trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* invalid JSON */ }
  return [];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/panel-action-registry.ts
git commit -m "feat: add PanelActionRegistry with execute recording and available header generation"
```

---

### Task 2: 패널 액션 기록 API 엔드포인트

**Files:**
- Create: `src/app/api/sessions/[id]/panel-actions/route.ts`
- Modify: `src/lib/session-instance.ts`

프론트엔드의 레지스트리가 액션 실행을 서버에 기록하는 API. `pending-actions.json`에 패널 액션 형식으로 저장.

- [ ] **Step 1: ActionRecord 타입 변경**

`src/lib/session-instance.ts:86-90`에서 ActionRecord를 패널 액션 형식으로 변경:

```typescript
export interface ActionRecord {
  panel: string;
  action: string;
  params?: Record<string, unknown>;
}
```

- [ ] **Step 2: flushActions() 형식 변경**

`src/lib/session-instance.ts:337-347`에서 `[ACTION_LOG]` 형식을 패널 액션 형식으로 변경:

```typescript
  flushActions(): string {
    const actions = this.readPendingActions();
    if (actions.length === 0) return "";
    this.writePendingActions([]);
    return actions
      .map(a => {
        const paramsStr = a.params ? `(${Object.entries(a.params).map(([k,v]) => `${k}=${v}`).join(", ")})` : "";
        return `[ACTION_LOG] ${a.panel}.${a.action}${paramsStr}`;
      })
      .join("\n");
  }
```

- [ ] **Step 3: 패널 액션 기록 API 생성**

```typescript
// src/app/api/sessions/[id]/panel-actions/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const instance = getSessionInstance(id);
  if (!instance) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await req.json();
  const { panel, action, params: actionParams } = body;

  if (!panel || !action) {
    return NextResponse.json({ error: "panel and action required" }, { status: 400 });
  }

  instance.queueAction({
    panel,
    action,
    ...(actionParams && Object.keys(actionParams).length > 0 ? { params: actionParams } : {}),
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: 기존 tool route의 액션 기록 제거 (또는 패널 액션 형식으로 전환)**

`src/app/api/sessions/[id]/tools/[name]/route.ts:175-185`에서 기존 tool 기반 액션 기록 부분을 제거한다. 이제 액션 기록은 프론트엔드 레지스트리의 `execute()`에서 panel-actions API를 통해 수행된다.

기존 코드 제거:
```typescript
    // Queue action for action history (skip MCP-originated and noActionLog)
    const isMcpRequest = validateInternalToken(req);
    const noActionLog = !!(result as Record<string, unknown>)?.noActionLog;
    if (!isMcpRequest && !noActionLog) {
      const actionName = args.action;
      queueActionToFile(sessionDir, {
        tool: name,
        action: typeof actionName === "string" ? actionName : "execute",
        args,
      });
    }
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-instance.ts src/app/api/sessions/[id]/panel-actions/route.ts src/app/api/sessions/[id]/tools/[name]/route.ts
git commit -m "feat: replace tool-based action recording with panel action recording"
```

---

### Task 3: `__panelBridge`에 `registerAction` + `executeAction` 추가

**Files:**
- Modify: `src/lib/use-panel-bridge.ts`

패널 스크립트가 핸들러를 등록하고, UI 버튼에서 액션을 실행할 수 있도록 bridge에 메서드 추가.

- [ ] **Step 1: import 및 메서드 추가**

`src/lib/use-panel-bridge.ts` 상단에 import:

```typescript
import { getPanelActionRegistry, type PanelActionHandler } from "./panel-action-registry";
```

bridge 객체 내부 (`on()` 메서드 뒤)에 추가:

```typescript
      /**
       * Register a panel action handler.
       * panelName is auto-detected from __currentPanelName context.
       */
      registerAction(actionId: string, handler: PanelActionHandler, panelName?: string): void {
        const panel = panelName || (window as unknown as Record<string, unknown>).__currentPanelName as string;
        if (!panel) {
          console.warn("[panelBridge] registerAction: no panel name context");
          return;
        }
        getPanelActionRegistry().registerHandler(panel, actionId, handler);
      },
      /**
       * Execute a registered panel action.
       * This is the primary execution path — UI buttons should call this instead of inline logic.
       * Records the action to history automatically.
       */
      async executeAction(actionId: string, params?: Record<string, unknown>, panelName?: string): Promise<void> {
        const panel = panelName || (window as unknown as Record<string, unknown>).__currentPanelName as string;
        if (!panel) {
          console.warn("[panelBridge] executeAction: no panel name context");
          return;
        }
        await getPanelActionRegistry().execute(panel, actionId, params);
      },
```

- [ ] **Step 2: sessionId를 레지스트리에 전달**

usePanelBridge의 useEffect 내에서 bridge 생성 후:

```typescript
    if (sessionId) {
      getPanelActionRegistry().setSessionId(sessionId);
    }
```

- [ ] **Step 3: sendMessage 억제 플래그 지원**

복합 패널 액션에서 중간 핸들러의 sendMessage를 억제하기 위한 플래그 체크를 `sendMessage`에 추가:

```typescript
      sendMessage(text: string, opts?: { silent?: boolean }) {
        const win = window as unknown as Record<string, unknown>;
        // Suppress during compound panel action execution
        if (win.__panelActionSuppressSend) {
          win.__panelActionSuppressedMsg = { text, opts };
          return;
        }
        const detail = opts?.silent ? { text, silent: true } : text;
        if (win.__popupsPlaying) {
          win.__pendingPanelMsg = detail;
          return;
        }
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail }));
      },
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/use-panel-bridge.ts
git commit -m "feat: add registerAction and executeAction to panel bridge"
```

---

### Task 4: 패널 렌더 컴포넌트에서 `<panel-actions>` 파싱

**Files:**
- Modify: `src/components/ModalPanel.tsx`
- Modify: `src/components/DockPanel.tsx`
- Modify: `src/components/PanelArea.tsx`

패널 HTML 렌더 시 `<panel-actions>` 메타데이터를 파싱하여 레지스트리에 등록하고, 스크립트 실행 전 패널 이름 컨텍스트를 설정.

- [ ] **Step 1: ModalPanel.tsx 수정**

상단 import:

```typescript
import { getPanelActionRegistry, parsePanelActions } from "@/lib/panel-action-registry";
```

shadow content 렌더 effect 내부, `shadow.innerHTML = ...` 직후 & 스크립트 실행 직전에:

```typescript
    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(html);
    if (actionMetas.length > 0) {
      getPanelActionRegistry().registerMeta(name, actionMetas);
    }
    // Set panel name context for registerAction calls
    (window as unknown as Record<string, unknown>).__currentPanelName = name;
```

스크립트 실행 루프 후:

```typescript
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
```

cleanup effect 추가:

```typescript
  useEffect(() => {
    return () => { getPanelActionRegistry().clearPanel(name); };
  }, [name]);
```

- [ ] **Step 2: DockPanel.tsx에 동일 패턴 적용**

DockPanel의 shadow content 렌더 effect에 동일한 import, 파싱, 컨텍스트 설정/해제, cleanup 추가.

- [ ] **Step 3: PanelArea.tsx에 동일 패턴 적용**

PanelArea의 각 패널 렌더에도 동일 로직 적용.

- [ ] **Step 4: Commit**

```bash
git add src/components/ModalPanel.tsx src/components/DockPanel.tsx src/components/PanelArea.tsx
git commit -m "feat: parse <panel-actions> tags and set panel name context in renderers"
```

---

### Task 5: ChoiceAction 인터페이스 확장

**Files:**
- Modify: `src/components/ChatMessages.tsx`

- [ ] **Step 1: 인터페이스 수정**

`src/components/ChatMessages.tsx:47-51` 변경:

```typescript
export interface ChoiceAction {
  tool?: string;       // legacy: tool name (e.g. "engine")
  panel?: string;      // new: panel name (e.g. "advance", "schedule")
  action: string;
  args?: Record<string, unknown>;
  params?: Record<string, unknown>; // panel action params (alias for args)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ChatMessages.tsx
git commit -m "feat: extend ChoiceAction with panel field for panel action choices"
```

---

### Task 6: ChatInput에서 패널 액션 실행

**Files:**
- Modify: `src/components/ChatInput.tsx`

선택지의 `{panel: "advance", action: "advance_slot"}` 형식 처리. 패널 모달 오픈 → 핸들러 대기 → 레지스트리의 `execute()` 호출.

- [ ] **Step 1: import 추가**

```typescript
import { getPanelActionRegistry } from "@/lib/panel-action-registry";
```

- [ ] **Step 2: handleChoice 함수 수정**

`src/components/ChatInput.tsx:160-214`을 교체:

```typescript
  const handleChoice = useCallback(async (choice: Choice) => {
    if (!choice.actions?.length || !sessionId) {
      onSend(choice.text);
      return;
    }
    setChoiceBusy(true);
    try {
      const registry = getPanelActionRegistry();
      const win = window as unknown as Record<string, unknown>;
      let lastAvailable: Array<{ action: string; label: string; args_hint: string | null }> | null = null;

      const panelActions = choice.actions.filter(a => a.panel);
      const isCompound = panelActions.length > 1;
      let panelActionIndex = 0;

      for (const act of choice.actions) {
        if (act.panel) {
          // ═══ Panel Action ═══
          const isLast = panelActionIndex === panelActions.length - 1;
          panelActionIndex++;

          // Suppress intermediate sendMessage in compound actions
          if (isCompound && !isLast) {
            win.__panelActionSuppressSend = true;
          }

          // 1. Open the panel modal
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/modals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "open", name: act.panel, mode: true }),
          });

          // 2. Wait for handler to be registered
          await registry.waitForHandler(act.panel, act.action, 8000);

          // 3. Execute via registry (records to history + runs handler)
          const params = act.params || act.args;
          await registry.execute(act.panel, act.action, params);

          win.__panelActionSuppressSend = false;

        } else if (act.tool) {
          // ═══ Legacy Tool Action ═══
          const toolRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(act.tool)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ args: { action: act.action, ...(act.args || {}) } }),
          });
          if (!toolRes.ok) {
            const err = await toolRes.json().catch(() => ({ error: "Action failed" }));
            throw new Error(err.error || `Action ${act.action} failed`);
          }
          const toolData = await toolRes.json();
          const hint = toolData.result?.hints?.narrative || toolData.result?.hints?.summary || "completed";
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ header: `[${act.action}] ${hint}` }),
          });
          if (toolData._available_actions?.length) {
            lastAvailable = toolData._available_actions;
          }
        }
      }

      // [AVAILABLE] header: prefer registry, fallback to legacy
      const availableHeader = registry.buildAvailableHeader();
      if (availableHeader) {
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header: availableHeader }),
        });
      } else if (lastAvailable && lastAvailable.length > 0) {
        const parts = lastAvailable.map((a: { action: string; label: string; args_hint: string | null }) =>
          a.args_hint ? `${a.action}(${a.label} ${a.args_hint})` : `${a.action}(${a.label})`
        );
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header: `[AVAILABLE] ${parts.join(", ")}` }),
        });
      }

      // Panel actions: handler calls sendMessage internally (queueEvent + sendMessage)
      // Legacy/no-action: send choice text directly
      const hasPanelAction = choice.actions.some(a => a.panel);
      if (!hasPanelAction) {
        onSend(choice.text);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      console.error("[choice action]", msg);
      showToast(msg, 4000);
    } finally {
      setChoiceBusy(false);
    }
  }, [onSend, sessionId]);
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatInput.tsx
git commit -m "feat: handle panel action choices with registry execution and compound suppression"
```

---

### Task 7: ChatPage에서 레지스트리 variables 동기화 + [AVAILABLE] 자동 큐잉

**Files:**
- Modify: `src/app/chat/[sessionId]/page.tsx`

panelData 변경 시 레지스트리 업데이트. 일반 메시지 전송 시에도 `[AVAILABLE]` 헤더 자동 큐잉.

- [ ] **Step 1: import 및 variables 동기화**

상단 import:

```typescript
import { getPanelActionRegistry } from "@/lib/panel-action-registry";
```

panelData 근처에 effect:

```typescript
  useEffect(() => {
    getPanelActionRegistry().updateVariables(panelData);
  }, [panelData]);
```

- [ ] **Step 2: [AVAILABLE] 헤더 자동 큐잉**

메시지 전송 함수를 래핑하여, 전송 직전에 available 헤더를 큐잉:

```typescript
  const queueAvailableHeader = useCallback(async () => {
    if (!sessionId) return;
    const header = getPanelActionRegistry().buildAvailableHeader();
    if (!header) return;
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ header }),
    });
  }, [sessionId]);
```

기존 send 핸들러에서 `queueAvailableHeader()`를 호출 후 전송. (구체적인 삽입 위치는 기존 handleSend/onSend 래퍼에 의존.)

- [ ] **Step 3: Commit**

```bash
git add src/app/chat/[sessionId]/page.tsx
git commit -m "feat: sync registry variables and auto-queue [AVAILABLE] header on send"
```

---

### Task 8: 08-advance.html 패널 리팩토링

**Files:**
- Modify: `data/sample-personas/princessmaker/panels/08-advance.html`

기존의 advBtn 인라인 핸들러를 `registerAction` 핸들러로 이동. 버튼 클릭이 `executeAction`을 호출.

- [ ] **Step 1: `<panel-actions>` 태그 추가**

파일 최상단 (`<style>` 바로 위):

```html
<panel-actions>
[
  {
    "id": "advance_slot",
    "label": "스케줄 진행",
    "description": "현재 슬롯의 활동을 실행한다 (일별 시뮬레이션 애니메이션 포함)",
    "available_when": "turn_phase === 'executing' && current_slot < 3"
  }
]
</panel-actions>
```

- [ ] **Step 2: 핸들러를 registerAction으로 이동**

기존 `advBtn?.addEventListener('click', async function() { ... })` 내부의 전체 로직(runTool + 애니메이션 + finalize)을 `registerAction` 핸들러로 이동:

```javascript
    // Register advance_slot as panel action — this is the primary execution path
    __panelBridge.registerAction('advance_slot', async (params) => {
      if (_running) return;
      _running = true;
      _animating = true;
      if (advBtn) {
        advBtn.disabled = true;
        advBtn.textContent = '⏳ 진행 중...';
      }

      let res;
      try {
        res = await __panelBridge.runTool('engine', { action: 'advance_slot' });
      } catch(e) {
        _running = false;
        if (advBtn) { advBtn.disabled = false; advBtn.textContent = '▶ 스케줄 진행'; }
        return;
      }
      if (!res.result?.success) {
        _running = false;
        if (advBtn) { advBtn.disabled = false; advBtn.textContent = '▶ 스케줄 진행'; }
        return;
      }
      const r = res.result;

      // ... (기존 애니메이션 로직 전체 — daily sim, battle, gauges, finalize 등) ...
    });

    // Button click delegates to panel action
    advBtn?.addEventListener('click', async function() {
      if (this.disabled) return;
      await __panelBridge.executeAction('advance_slot');
    });
```

핵심: 기존 클릭 핸들러의 **전체** 로직이 `registerAction` 핸들러로 이동. 클릭 이벤트는 단순히 `executeAction`을 호출.

- [ ] **Step 3: dev 서버에서 동작 확인**

Run: `npm run dev` → princessmaker 세션 → executing 페이즈 → ▶ 버튼 클릭
Expected: 기존과 동일한 애니메이션 + 결과 표시 + sendMessage. 추가로 `[ACTION_LOG] advance.advance_slot` 기록.

- [ ] **Step 4: Commit**

```bash
git add data/sample-personas/princessmaker/panels/08-advance.html
git commit -m "feat: refactor advance panel to use registerAction as primary execution path"
```

---

### Task 9: 03-schedule.html 패널 리팩토링

**Files:**
- Modify: `data/sample-personas/princessmaker/panels/03-schedule.html`

schedule 확정 버튼의 로직을 `registerAction` 핸들러로 이동.

- [ ] **Step 1: `<panel-actions>` 태그 추가**

파일 최상단:

```html
<panel-actions>
[
  {
    "id": "confirm_schedule",
    "label": "스케줄 확정",
    "description": "3슬롯 스케줄을 설정하고 확정한다. 실행 페이즈로 전환됨",
    "params": {
      "schedule_1": "활동 ID (상순)",
      "schedule_2": "활동 ID (중순)",
      "schedule_3": "활동 ID (하순)"
    },
    "available_when": "turn_phase === 'setup'"
  }
]
</panel-actions>
```

- [ ] **Step 2: 핸들러를 registerAction으로 이동**

기존 `#advBtn` 클릭 핸들러 (스케줄 확정 로직)를 `registerAction`으로 이동:

```javascript
    // Register confirm_schedule as panel action
    __panelBridge.registerAction('confirm_schedule', async (params) => {
      // If params provided (from choice), set schedule slots first
      if (params) {
        const patch = {};
        if (params.schedule_1) patch.schedule_1 = params.schedule_1;
        if (params.schedule_2) patch.schedule_2 = params.schedule_2;
        if (params.schedule_3) patch.schedule_3 = params.schedule_3;
        await __panelBridge.updateVariables(patch);
        // Re-read slots after update
        slots = [patch.schedule_1 || slots[0], patch.schedule_2 || slots[1], patch.schedule_3 || slots[2]];
      }

      // Queue schedule info (existing logic from #advBtn handler)
      if (locked > 0) {
        const changes = [];
        for (let i = locked; i < 3; i++) {
          const aid = slots[i];
          const a = aid !== 'none' ? all[aid] : null;
          changes.push(`${LBL[i+1]}: ${a ? a.name : '(없음)'}`);
        }
        await __panelBridge.queueEvent(
          `[SCHEDULE_MODIFIED] ${d.current_year}년차 ${d.current_month}월 남은 스케줄 수정\n${changes.join('\n')}`
        );
      } else {
        const sNames = slots.map((aid, i) => {
          const a = aid !== 'none' ? all[aid] : null;
          return `${LBL[i+1]}: ${a ? a.name : '(없음)'}`;
        });
        await __panelBridge.queueEvent(
          `[SCHEDULE_SET] ${d.current_year}년차 ${d.current_month}월 스케줄 확정\n${sNames.join('\n')}`
        );
      }
      await __panelBridge.updateVariables({
        turn_phase: 'executing',
        __refreshPanels: ['advance']
      });
      await __panelBridge.openModal('advance', true);
    });

    // Button click delegates to panel action
    shadow.querySelector('#advBtn')?.addEventListener('click', async function() {
      if (this.disabled) return;
      this.disabled = true;
      await __panelBridge.executeAction('confirm_schedule');
    });
```

- [ ] **Step 3: Commit**

```bash
git add data/sample-personas/princessmaker/panels/03-schedule.html
git commit -m "feat: refactor schedule panel to use registerAction as primary execution path"
```

---

### Task 10: session-shared.md AI 가이드 업데이트

**Files:**
- Modify: `session-shared.md`

선택지 시스템 문서를 패널 액션 형식으로 업데이트.

- [ ] **Step 1: 선택지 형식 업데이트**

`session-shared.md`의 `### 선택지 시스템` 내 `액션 선택지:` 섹션 전체 교체.

변경 요약:
1. `actions[].tool` → `actions[].panel` (패널 이름)
2. `actions[].args` → `actions[].params` (패널 액션 파라미터)
3. 예시 코드 교체:
```
{"panel": "advance", "action": "advance_slot"}
{"panel": "schedule", "action": "confirm_schedule", "params": {"schedule_1": "...", ...}}
```
4. `[AVAILABLE]` 형식 설명: `panel.action(label params)`
5. `[ACTION_LOG]` 형식 설명: `panel.action(param=value, ...)`
6. 규칙: `[AVAILABLE]`에 있는 패널 액션만 선택지에 포함

- [ ] **Step 2: Commit**

```bash
git add session-shared.md
git commit -m "docs: update choice system guide for panel action format"
```

---

### Task 11: 통합 검증

**Files:** (수정 없음)

- [ ] **Step 1: 빌드 확인**

Run: `npm run build`
Expected: TypeScript 에러 없이 성공

- [ ] **Step 2: 기능 검증 체크리스트**

1. **패널 버튼**: advance ▶ 클릭 → 애니메이션 정상 → sendMessage → `[ACTION_LOG] advance.advance_slot` 기록됨
2. **스케줄 확정**: schedule 확정 클릭 → 페이즈 전환 → `[ACTION_LOG] schedule.confirm_schedule` 기록됨
3. **선택지 (패널 액션)**: `{panel: "advance", action: "advance_slot"}` 선택지 → 모달 오픈 → 애니메이션 → sendMessage
4. **선택지 (레거시)**: `{tool: "engine", ...}` 선택지 → 기존 동작 유지
5. **[AVAILABLE] 헤더**: 메시지 전송 시 available 패널 액션이 헤더로 포함
6. **[ACTION_LOG]**: 패널 버튼/선택지 모두 같은 형식으로 기록

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "feat: panel actions system — complete integration"
```

---

## Migration Notes

- **하위 호환**: `{tool: "engine", ...}` 형식은 legacy 분기에서 유지. 기존 세션 깨지지 않음.
- **점진적 마이그레이션**: 각 패널에 `<panel-actions>` + `registerAction` 추가하며 전환.
- **ActionRecord 포맷 변경**: `pending-actions.json`의 `{tool, action, args}` → `{panel, action, params}`. 기존 파일은 flushActions 시 자동 소비되므로 마이그레이션 불필요.
- **패널 버튼 리팩토링 패턴**: 인라인 로직 → `registerAction()` 핸들러 이동 → 클릭에서 `executeAction()` 호출.
