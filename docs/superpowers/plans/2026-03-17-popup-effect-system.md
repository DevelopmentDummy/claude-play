# Popup Effect System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a turn-persistent popup effect system that displays Handlebars-templated rich HTML popups center-screen with scale animations, queued sequentially, cleared on next non-OOC message.

**Architecture:** Popup templates live in `popups/` directory (Handlebars HTML). `variables.json.__popups` array drives the queue. PanelEngine renders templates server-side and sends rendered HTML via `panels:update` WebSocket event. Frontend `PopupEffect` component plays the queue with scale-in/out animations. Cleared server-side on `chat:send` (non-OOC).

**Tech Stack:** React 19, Next.js 15, Handlebars, TypeScript, CSS animations, WebSocket

**Spec:** `docs/superpowers/specs/2026-03-17-popup-effect-system-design.md`

---

## Chunk 1: Backend — PanelEngine popup rendering

### Task 1: Add popup template rendering to PanelEngine

**Files:**
- Modify: `src/lib/panel-engine.ts`

- [ ] **Step 1: Add popups field to PanelUpdate interface**

At line 27, extend the `PanelUpdate` interface:

```typescript
export interface PanelUpdate {
  panels: PanelData[];
  context: Record<string, unknown>;
  /** Default placement for shared panels (panel name → placement type) */
  sharedPlacements?: Record<string, "modal">;
  /** Rendered popup effects from __popups queue */
  popups?: Array<{ template: string; html: string; duration: number }>;
}
```

- [ ] **Step 2: Add popups/ directory watching in watch() method**

After the panels/ directory watcher block (after line 137), add popup directory watching:

```typescript
// Watch popups/ directory
const popupsDir = path.join(sessionDir, "popups");
if (fs.existsSync(popupsDir)) {
  const watcher = fs.watch(popupsDir, (_event, filename) => {
    if (filename && filename.endsWith(".html")) {
      const name = filename.replace(/\.html$/, "");
      this.templateCache.delete(`popup:${name}`);
    }
    this.scheduleRender();
  });
  this.watchers.push(watcher);
}
```

- [ ] **Step 3: Add renderPopups() private method**

Add a new method that reads `__popups` from variables and renders each template:

```typescript
/** Render popup templates from __popups queue in variables */
private renderPopups(context: Record<string, unknown>): Array<{ template: string; html: string; duration: number }> {
  if (!this.sessionDir) return [];
  const popupQueue = this.variables.__popups as Array<{ template: string; duration?: number; vars?: Record<string, unknown> }> | undefined;
  if (!Array.isArray(popupQueue) || popupQueue.length === 0) return [];

  const popupsDir = path.join(this.sessionDir, "popups");
  const result: Array<{ template: string; html: string; duration: number }> = [];

  for (const entry of popupQueue) {
    if (!entry.template) continue;
    const filePath = path.join(popupsDir, `${entry.template}.html`);
    if (!fs.existsSync(filePath)) continue; // skip nonexistent templates

    const cacheKey = `popup:${entry.template}`;
    try {
      if (!this.templateCache.has(cacheKey)) {
        const source = fs.readFileSync(filePath, "utf-8");
        this.templateCache.set(cacheKey, Handlebars.compile(source));
      }
      const template = this.templateCache.get(cacheKey)!;
      const popupContext = entry.vars ? { ...context, ...entry.vars } : context;
      const html = template(popupContext, { allowProtoPropertiesByDefault: true });
      result.push({ template: entry.template, html, duration: entry.duration || 4000 });
    } catch {
      // skip broken templates
    }
  }
  return result;
}
```

- [ ] **Step 4: Integrate renderPopups into getCurrentPanels()**

At the end of `getCurrentPanels()`, before the return statement (around line 239), add popup rendering:

```typescript
// Render popup queue
const popups = this.renderPopups(context);

return { panels, context, sharedPlacements, ...(popups.length > 0 ? { popups } : {}) };
```

Replace the existing `return { panels, context, sharedPlacements };` line.

- [ ] **Step 5: Expose scheduleRender as public method**

Change `scheduleRender` from private to public so `SessionInstance.clearPopups()` can call it:

```typescript
/** Debounced render to coalesce rapid file changes */
scheduleRender(): void {
```

- [ ] **Step 6: Verify dev server starts cleanly**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/panel-engine.ts
git commit -m "feat: add popup template rendering to PanelEngine"
```

---

### Task 2: Add clearPopups to SessionInstance

**Files:**
- Modify: `src/lib/session-instance.ts`

- [ ] **Step 1: Add clearPopups() method to SessionInstance**

Add after the `flushEvents()` method (after line 287):

```typescript
/** Clear popup queue from variables.json (called on non-OOC chat:send) */
clearPopups(): void {
  const dir = this.getDir();
  if (!dir) return;
  const varsPath = path.join(dir, "variables.json");
  try {
    if (!fs.existsSync(varsPath)) return;
    const vars = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
    if (!Array.isArray(vars.__popups) || vars.__popups.length === 0) return;
    vars.__popups = [];
    fs.writeFileSync(varsPath, JSON.stringify(vars, null, 2), "utf-8");
    this.panels.scheduleRender();
  } catch { /* ignore */ }
}
```

Ensure `path` and `fs` are already imported (they are — check existing imports at top of file).

- [ ] **Step 2: Commit**

```bash
git add src/lib/session-instance.ts
git commit -m "feat: add clearPopups method to SessionInstance"
```

---

### Task 3: Wire clearPopups into chat:send handler

**Files:**
- Modify: `src/lib/ws-server.ts`

- [ ] **Step 1: Add clearPopups call in chat:send handler**

In the `chat:send` case (line 145), after `instance.isOOC = isOOC;` (line 153) and before `instance.addUserToHistory(text, isOOC);` (line 154), add:

```typescript
// Clear popup queue on non-OOC messages
if (!isOOC) {
  instance.clearPopups();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ws-server.ts
git commit -m "feat: clear popup queue on non-OOC chat send"
```

---

### Task 4: Add popups/ to sync diff/apply

**Files:**
- Modify: `src/lib/session-manager.ts`

- [ ] **Step 1: Add popups entry to getSyncDiff()**

After the panels entry (line 888), add:

```typescript
// Check popups
const pPopups = path.join(personaDir, "popups");
const sPopups = path.join(sessionDir, "popups");
result.push({ key: "popups", label: "팝업 (popups/)", hasChanges: this.dirDiffers(pPopups, sPopups) });
```

- [ ] **Step 2: Add popups entry to getReverseSyncDiff()**

After the panels entry (line 978), add:

```typescript
// Check popups (session → persona direction)
const sPopups = path.join(sessionDir, "popups");
const pPopups = path.join(personaDir, "popups");
result.push({ key: "popups", label: "팝업 (popups/)", hasChanges: this.dirDiffers(sPopups, pPopups) });
```

- [ ] **Step 3: Add popups sync to syncPersonaToSessionSelective()**

After the panels sync block (after line 744), add:

```typescript
// Sync popups/ directory (overwrite with persona's latest)
if (elements.popups) {
  const personaPopups = path.join(personaDir, "popups");
  const sessionPopups = path.join(sessionDir, "popups");
  if (fs.existsSync(personaPopups)) {
    if (!fs.existsSync(sessionPopups)) fs.mkdirSync(sessionPopups, { recursive: true });
    for (const file of fs.readdirSync(personaPopups)) {
      const src = path.join(personaPopups, file);
      const dst = path.join(sessionPopups, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
      }
    }
  }
}
```

- [ ] **Step 4: Add popups sync to syncSessionToPersonaSelective()**

After the panels sync block in the reverse method (after line 1074), add:

```typescript
// Sync popups/ (session → persona)
if (elements.popups) {
  const sessionPopups = path.join(sessionDir, "popups");
  const personaPopups = path.join(personaDir, "popups");
  if (fs.existsSync(sessionPopups)) {
    if (!fs.existsSync(personaPopups)) fs.mkdirSync(personaPopups, { recursive: true });
    for (const file of fs.readdirSync(sessionPopups)) {
      const src = path.join(sessionPopups, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(personaPopups, file));
      }
    }
  }
}
```

- [ ] **Step 5: Add "popups" to syncPersonaToSession full sync elements**

Find `syncPersonaToSession(id: string)` (line 708) which calls `syncPersonaToSessionSelective`. Add `popups: true` to the elements object passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add popups/ to bidirectional sync"
```

---

## Chunk 2: Frontend — PopupEffect component and integration

### Task 5: Create PopupEffect component

**Files:**
- Create: `src/components/PopupEffect.tsx`

- [ ] **Step 1: Create the PopupEffect component**

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PopupItem {
  template: string;
  html: string;
  duration: number;
}

interface PopupEffectProps {
  popups: PopupItem[];
  themeColor?: string;
  onQueueComplete?: () => void;
}

export default function PopupEffect({ popups, themeColor, onQueueComplete }: PopupEffectProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<"enter" | "visible" | "exit" | "idle">("idle");
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Parse theme color for CSS variables
  const primary = themeColor || "#6366f1";

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  // Reset queue when popups array changes
  useEffect(() => {
    cleanup();
    if (popups.length > 0) {
      setCurrentIndex(0);
      setPhase("enter");
    } else {
      setPhase("idle");
      setCurrentIndex(0);
    }
  }, [popups, cleanup]);

  // Animation state machine
  useEffect(() => {
    if (!mountedRef.current || popups.length === 0) return;
    const current = popups[currentIndex];
    if (!current) {
      setPhase("idle");
      onQueueComplete?.();
      return;
    }

    if (phase === "enter") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPhase("visible");
      }, 300);
    } else if (phase === "visible") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPhase("exit");
      }, current.duration);
    } else if (phase === "exit") {
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        const next = currentIndex + 1;
        if (next < popups.length) {
          setCurrentIndex(next);
          setPhase("enter");
        } else {
          setPhase("idle");
          onQueueComplete?.();
        }
      }, 300);
    }

    return () => cleanup();
  }, [phase, currentIndex, popups, cleanup, onQueueComplete]);

  // Render HTML into shadow DOM
  useEffect(() => {
    if (phase === "idle" || !containerRef.current) return;
    const current = popups[currentIndex];
    if (!current) return;

    const el = containerRef.current;
    let shadow = el.shadowRoot;
    if (!shadow) {
      shadow = el.attachShadow({ mode: "open" });
    }

    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          --popup-primary: ${primary};
          --popup-glow: ${hexToRgba(primary, 0.3)};
        }
        * { box-sizing: border-box; }
        img { max-width: 100%; height: auto; }
      </style>
      ${current.html}
    `;

    // Execute script tags
    const scripts = shadow.querySelectorAll("script");
    scripts.forEach((s) => {
      try {
        const code = s.textContent || "";
        new Function("shadow", code)(shadow);
      } catch (e) {
        console.warn("[PopupEffect] script error:", e);
      }
    });
  }, [phase, currentIndex, popups]);

  if (phase === "idle" || popups.length === 0) return null;

  const isVisible = phase === "enter" || phase === "visible";
  const isEntering = phase === "enter";
  const isExiting = phase === "exit";

  const backdropStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 10100,
    backgroundColor: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: isExiting ? 0 : isEntering ? 0 : 1,
    transition: "opacity 300ms ease",
    ...(phase === "enter" && { animation: "popupBackdropIn 300ms ease forwards" }),
    ...(phase === "exit" && { animation: "popupBackdropOut 300ms ease forwards" }),
  };

  const popupStyle: React.CSSProperties = {
    position: "relative",
    zIndex: 10101,
    maxWidth: "480px",
    width: "90vw",
    borderRadius: "16px",
    background: `linear-gradient(135deg, ${primary}, ${adjustColor(primary, 40)})`,
    boxShadow: `0 0 40px ${hexToRgba(primary, 0.3)}, 0 0 80px ${hexToRgba(primary, 0.15)}, 0 8px 32px rgba(0,0,0,0.3)`,
    border: "1px solid rgba(255,255,255,0.15)",
    padding: "24px",
    color: "white",
    overflow: "hidden",
    ...(phase === "enter" && { animation: "popupScaleIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards" }),
    ...(phase === "visible" && { transform: "scale(1)", opacity: 1 }),
    ...(phase === "exit" && { animation: "popupScaleOut 300ms ease forwards" }),
  };

  return createPortal(
    <>
      <style>{`
        @keyframes popupBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes popupBackdropOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes popupScaleIn { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
        @keyframes popupScaleOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.9); } }
      `}</style>
      <div style={backdropStyle}>
        <div style={popupStyle}>
          <div ref={containerRef} />
        </div>
      </div>
    </>,
    document.body
  );
}

// --- Utility functions ---

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16) || 99;
  const g = parseInt(hex.slice(3, 5), 16) || 102;
  const b = parseInt(hex.slice(5, 7), 16) || 241;
  return `rgba(${r},${g},${b},${alpha})`;
}

function adjustColor(hex: string, amount: number): string {
  const r = Math.min(255, (parseInt(hex.slice(1, 3), 16) || 99) + amount);
  const g = Math.min(255, (parseInt(hex.slice(3, 5), 16) || 102) + amount);
  const b = Math.min(255, (parseInt(hex.slice(5, 7), 16) || 241) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PopupEffect.tsx
git commit -m "feat: create PopupEffect component with queue animation"
```

---

### Task 6: Add showPopup to panelBridge

**Files:**
- Modify: `src/lib/use-panel-bridge.ts`

- [ ] **Step 1: Add showPopup method to bridge object**

After the `runTool` method (before `sessionId` property, around line 61), add:

```typescript
async showPopup(template: string, opts?: { duration?: number; vars?: Record<string, unknown> }) {
  if (!sessionId) return;
  const existing = ((panelData || {}).__popups as Array<Record<string, unknown>>) || [];
  const entry: Record<string, unknown> = { template };
  if (opts?.duration) entry.duration = opts.duration;
  if (opts?.vars) entry.vars = opts.vars;
  const res = await fetch(`/api/sessions/${sessionId}/variables`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ __popups: [...existing, entry] }),
  });
  return res.json();
},
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/use-panel-bridge.ts
git commit -m "feat: add showPopup method to panelBridge"
```

---

### Task 7: Integrate PopupEffect into ChatPage

**Files:**
- Modify: `src/app/chat/[sessionId]/page.tsx`

- [ ] **Step 1: Import PopupEffect**

Add at top with other component imports:

```typescript
import PopupEffect from "@/components/PopupEffect";
```

- [ ] **Step 2: Add popups state**

Add a new state variable alongside the existing panel state variables (near `setPanels`, `setPanelData`):

```typescript
const [popupQueue, setPopupQueue] = useState<Array<{ template: string; html: string; duration: number }>>([]);
```

- [ ] **Step 3: Handle popups in panels:update WebSocket handler**

In the `"panels:update"` handler, extract and set popups:

```typescript
"panels:update": (p) => {
  const update = p as {
    panels: Panel[];
    context: Record<string, unknown>;
    sharedPlacements?: Record<string, "modal" | "dock" | "dock-left" | "dock-right" | "dock-bottom">;
    popups?: Array<{ template: string; html: string; duration: number }>;
  };
  setPanels(update.panels);
  setPanelData(update.context);
  if (update.sharedPlacements) setSharedPlacements(update.sharedPlacements);
  // Only update popup queue when explicitly present in update
  if (update.popups !== undefined) {
    setPopupQueue(update.popups.length > 0 ? update.popups : []);
  }
},
```

- [ ] **Step 4: Clear popups on non-OOC message send**

In the `sendMessage` callback, clear popup queue for non-OOC messages:

```typescript
const sendMessage = useCallback(
  (text: string) => {
    if (text.startsWith("OOC:")) setShowOOC(true);
    if (!text.startsWith("OOC:")) setPopupQueue([]); // Clear popups immediately
    prepareSend(text);
    sendChat(text);
  },
  [prepareSend, sendChat]
);
```

- [ ] **Step 5: Extract theme color from layout**

The layout already has theme data. Find where `layout` state is used and extract primaryColor. If the layout has `theme.primaryColor`, use it:

```typescript
const themeColor = (layout as Record<string, unknown> & { theme?: { primaryColor?: string } })?.theme?.primaryColor;
```

- [ ] **Step 6: Render PopupEffect component**

Add the PopupEffect component in the JSX, after the ModalPanel renders (near the end of the return statement):

```tsx
{popupQueue.length > 0 && (
  <PopupEffect
    popups={popupQueue}
    themeColor={themeColor}
  />
)}
```

- [ ] **Step 7: Also handle initial load popups**

When the session opens (the `openSession` effect), the initial `panelContext` may already contain `__popups`. Check if the open response includes popups and set them:

In the `openSession` async function, after setting panels/panelData, check:

```typescript
// Set initial popups if present in open response
if (data.popups && data.popups.length > 0) {
  setPopupQueue(data.popups);
}
```

This requires the `/api/sessions/[id]/open` route to include popups in its response. Check the open route — it already calls `instance.panels.getCurrentPanels()` which now returns `popups`. Ensure it's passed through in the response JSON.

- [ ] **Step 8: Verify the open API route passes popups through**

Check `src/app/api/sessions/[id]/open/route.ts`. The response from `getCurrentPanels()` already includes `popups` field when present. Ensure the destructured response includes it:

```typescript
const { panels, context: panelContext, sharedPlacements, popups } = instance.panels.getCurrentPanels();
```

And include in the response JSON:

```typescript
return NextResponse.json({
  // ... existing fields ...
  popups: popups || [],
});
```

- [ ] **Step 9: Commit**

```bash
git add src/app/chat/[sessionId]/page.tsx src/components/PopupEffect.tsx
git commit -m "feat: integrate PopupEffect into chat page with queue playback"
```

---

## Chunk 3: API route update and final verification

### Task 8: Update session open API to include popups

**Files:**
- Modify: `src/app/api/sessions/[id]/open/route.ts`

- [ ] **Step 1: Add popups to open response**

Find where `getCurrentPanels()` result is destructured and add `popups`:

```typescript
const { panels, context: panelContext, sharedPlacements, popups } = instance.panels.getCurrentPanels();
```

Include in the `NextResponse.json()` call:

```typescript
popups: popups || [],
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sessions/[id]/open/route.ts
git commit -m "feat: include popups in session open response"
```

---

### Task 9: Build verification and manual test

- [ ] **Step 1: Run TypeScript build check**

Run: `npm run build`
Expected: No TypeScript errors, successful build

- [ ] **Step 2: Start dev server and verify no runtime errors**

Run: `npm run dev`
Expected: Server starts on port 3340 without errors

- [ ] **Step 3: Create a test popup template**

Create a test popup template in any existing persona's `popups/` directory:

```bash
mkdir -p data/personas/<any-persona>/popups
```

Write `data/personas/<any-persona>/popups/test.html`:

```html
<div style="text-align: center; padding: 12px;">
  <div style="font-size: 36px; margin-bottom: 12px;">⚔️</div>
  <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 700;">테스트 팝업</h2>
  <p style="margin: 0; opacity: 0.8; font-size: 14px;">팝업 이펙트 시스템이 정상 작동합니다</p>
</div>
```

- [ ] **Step 4: Test popup trigger via variables.json**

With a session open, manually PATCH variables to trigger a popup:

```bash
curl -X PATCH http://localhost:3340/api/sessions/<session-id>/variables \
  -H "Content-Type: application/json" \
  -d '{"__popups": [{"template": "test", "duration": 3000}]}'
```

Expected: Popup appears center-screen with scale-in animation, auto-dismisses after 3 seconds.

- [ ] **Step 5: Test clear on message send**

Send a non-OOC message in chat. The popup queue should clear both server-side (variables.json `__popups` becomes `[]`) and client-side (popup disappears immediately with exit animation).

- [ ] **Step 6: Test OOC preservation**

Trigger a popup, then send an OOC message. The popup should remain visible.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: popup effect system — complete implementation"
```
