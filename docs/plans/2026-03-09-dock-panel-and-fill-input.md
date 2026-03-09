# Dock Panel & fillInput Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new "dock" panel placement that renders between chat and input with tab switching, and a `fillInput` bridge method that inserts text into the input box without sending.

**Architecture:** Dock panels reuse the existing `__modals` visibility mechanism and Shadow DOM rendering from PanelSlot. A new `DockPanel` component handles tab switching and content display, rendered inside the chat column between `ChatMessages` and `ChatInput`. The `fillInput` bridge method dispatches a custom event that ChatInput listens for via an exposed `insertAtCursor` callback.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Shadow DOM, CustomEvent API

---

### Task 1: Add `fillInput` to ChatInput

**Files:**
- Modify: `src/components/ChatInput.tsx`

**Step 1: Add `onFillInput` registration prop and event listener**

ChatInput needs to listen for `__panel_fill_input` custom events and call `insertAtCursor`:

```typescript
// Add to ChatInputProps:
// (no new props needed — ChatInput listens globally)

// Add useEffect inside ChatInput component, after insertAtCursor definition:
useEffect(() => {
  const handler = (e: Event) => {
    const text = (e as CustomEvent).detail;
    if (typeof text === "string") {
      insertAtCursor(text);
    }
  };
  window.addEventListener("__panel_fill_input", handler);
  return () => window.removeEventListener("__panel_fill_input", handler);
}, [insertAtCursor]);
```

**Step 2: Verify** — no type errors: `npx tsc --noEmit`

**Step 3: Commit**
```bash
git add src/components/ChatInput.tsx
git commit -m "feat: ChatInput listens for __panel_fill_input events"
```

---

### Task 2: Add `fillInput` to PanelBridge (PanelSlot + ModalPanel)

**Files:**
- Modify: `src/components/PanelSlot.tsx`
- Modify: `src/components/ModalPanel.tsx`

**Step 1: Add `fillInput` method to bridge in PanelSlot.tsx**

In the bridge object (line 23-38), add:

```typescript
fillInput(text: string) {
  window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
},
```

**Step 2: Add `fillInput` method to bridge in ModalPanel.tsx**

In the bridge object (line 61-83), add:

```typescript
fillInput(text: string) {
  window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
},
```

**Step 3: Verify** — `npx tsc --noEmit`

**Step 4: Commit**
```bash
git add src/components/PanelSlot.tsx src/components/ModalPanel.tsx
git commit -m "feat: add fillInput method to panelBridge API"
```

---

### Task 3: Create DockPanel component

**Files:**
- Create: `src/components/DockPanel.tsx`

**Step 1: Create the component**

DockPanel renders between chat and input. It shows:
- Tab bar when 2+ panels active (tabs showing panel names, active tab highlighted)
- Shadow DOM content area for the active panel
- Dismiss button (X) per tab if dismissible
- Max-height controlled by prop, defaults to content auto-size

```tsx
"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import ImageModal from "./ImageModal";

interface DockPanelEntry {
  name: string;
  html: string;
  dismissible: boolean;
}

interface DockPanelProps {
  panels: DockPanelEntry[];
  maxHeight?: number;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onClose: (name: string) => void;
}

export default function DockPanel({
  panels,
  maxHeight,
  sessionId,
  panelData,
  onClose,
}: DockPanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  // Clamp activeTab if panels shrink
  useEffect(() => {
    if (activeTab >= panels.length && panels.length > 0) {
      setActiveTab(panels.length - 1);
    }
  }, [panels.length, activeTab]);

  const current = panels[activeTab] || panels[0];
  if (!current) return null;

  // Install bridge (same as PanelSlot/ModalPanel)
  useEffect(() => {
    const bridge = {
      sendMessage(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail: text }));
      },
      fillInput(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
      },
      async updateVariables(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      sessionId,
      data: panelData || {},
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
  }, [sessionId, panelData]);

  // Attach shadow DOM (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      shadowRef.current.addEventListener("click", (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG") {
          const src = (target as HTMLImageElement).src;
          if (src) { e.preventDefault(); setModalSrc(src); }
          return;
        }
        const anchor = target.closest("a");
        if (anchor) {
          const href = anchor.getAttribute("href") || "";
          if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(href)) {
            e.preventDefault();
            setModalSrc(anchor.href);
          }
        }
      });
    }
  }, []);

  // Re-render shadow content when active panel changes
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      current.html;

    const scripts = Array.from(shadow.querySelectorAll("script"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        code = code.replace(/document\.currentScript\.getRootNode\(\)/g, "shadow");
        const fn = new Function("shadow", code);
        fn(shadow);
      } catch (e) {
        console.warn(`[DockPanel] Script error in "${current.name}":`, e);
      }
    }
  }, [current.html, current.name, panelData]);

  const showTabs = panels.length > 1;

  return (
    <>
      <div
        className="border-t border-border bg-surface/80 backdrop-blur-[16px] shrink-0 flex flex-col"
        style={{ maxHeight: maxHeight ? `${maxHeight}px` : "50vh" }}
      >
        {/* Tab bar */}
        {showTabs && (
          <div className="flex items-center gap-0 border-b border-border/50 px-2 shrink-0">
            {panels.map((p, i) => (
              <button
                key={p.name}
                onClick={() => setActiveTab(i)}
                className={`relative flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider cursor-pointer transition-colors
                  ${i === activeTab
                    ? "text-accent"
                    : "text-text-dim/50 hover:text-text-dim/80"
                  }`}
              >
                {p.name}
                {p.dismissible && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onClose(p.name); }}
                    className="ml-1 text-text-dim/30 hover:text-text-dim/70 text-[10px]"
                  >
                    ×
                  </span>
                )}
                {i === activeTab && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-full" />
                )}
              </button>
            ))}
          </div>
        )}
        {/* Single panel header with close button (when only 1 panel) */}
        {!showTabs && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0">
            <span
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}
            >
              {current.name}
            </span>
            {current.dismissible && (
              <button
                onClick={() => onClose(current.name)}
                className="text-text-dim/30 hover:text-text-dim/70 transition-colors text-sm cursor-pointer"
              >
                ×
              </button>
            )}
          </div>
        )}
        {/* Content */}
        <div className="overflow-y-auto px-4 py-3 flex-1 min-h-0">
          <div ref={containerRef} />
        </div>
      </div>
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
```

**Step 2: Verify** — `npx tsc --noEmit`

**Step 3: Commit**
```bash
git add src/components/DockPanel.tsx
git commit -m "feat: add DockPanel component with tab switching and Shadow DOM"
```

---

### Task 4: Integrate DockPanel into ChatPage

**Files:**
- Modify: `src/app/chat/[sessionId]/page.tsx`

**Step 1: Import DockPanel**

```typescript
import DockPanel from "@/components/DockPanel";
```

**Step 2: Update placement type and filter dock panels**

Change the placement type to include "dock":

```typescript
// Line 194 — update type
const placement: Record<string, "left" | "right" | "modal" | "dock"> = {};
```

Add dock panel filtering after the existing modal filter (around line 210):

```typescript
const dockPanels = panels.filter((p) => placement[p.name] === "dock");
```

Update `inlinePanels` filter to also exclude dock:

```typescript
const inlinePanels = panels.filter((p) => !placement[p.name]);
```

This already works because `placement[p.name] === "dock"` is truthy, so `!placement[p.name]` is false.

**Step 3: Compute active dock panels (same mechanism as modals)**

After `activeModalPanels` (line 233), add:

```typescript
const activeDockPanels = dockPanels
  .filter((p) => !!modalsState?.[p.name])
  .map((p) => ({
    name: p.name,
    html: p.html,
    dismissible: modalsState?.[p.name] === "dismissible",
  }));
```

**Step 4: Read dockSize from layout**

After `panelSize` (line 187), add:

```typescript
const dockMaxHeight = layout?.panels?.dockSize;
```

**Step 5: Render DockPanel between ChatMessages and ChatInput**

Replace the chat column content (lines 274-303) — insert DockPanel between ChatMessages and ChatInput:

```tsx
<ChatMessages
  messages={visibleMessages}
  isStreaming={isStreaming}
  hideTools
  sessionId={sessionId}
  panels={hasPerPanelPlacement ? inlinePanels : panels}
  hasMore={hasMore}
  onLoadMore={loadMore}
  onToggleOOC={toggleMessageOOC}
/>
{activeDockPanels.length > 0 && (
  <DockPanel
    panels={activeDockPanels}
    maxHeight={dockMaxHeight}
    sessionId={sessionId}
    panelData={panelData}
    onClose={(name) => {
      fetch(`/api/sessions/${sessionId}/variables`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ __modals: { ...modalsState, [name]: false } }),
      });
    }}
  />
)}
<ChatInput
  disabled={isStreaming}
  onSend={sendMessage}
  ...
/>
```

**Step 6: Update sharedPlacements type**

In state declaration (line 48):
```typescript
const [sharedPlacements, setSharedPlacements] = useState<Record<string, "modal">>({});
```
Change to:
```typescript
const [sharedPlacements, setSharedPlacements] = useState<Record<string, "modal" | "dock">>({});
```

And in the WS handler (line 69):
```typescript
const update = p as { panels: Panel[]; context: Record<string, unknown>; sharedPlacements?: Record<string, "modal" | "dock"> };
```

**Step 7: Verify** — `npx tsc --noEmit`

**Step 8: Commit**
```bash
git add src/app/chat/[sessionId]/page.tsx
git commit -m "feat: integrate dock panels into chat layout between messages and input"
```

---

### Task 5: Update layout.json types and documentation

**Files:**
- Modify: `src/hooks/useLayout.ts` (if LayoutConfig type needs dock)
- Modify: `panel-spec.md`
- Modify: `builder-prompt.md`
- Modify: `CLAUDE.md`

**Step 1: Check useLayout for LayoutConfig type**

If `LayoutConfig` has a typed `placement` field, add `"dock"` to the union. If it's `Record<string, string>` already, no change needed.

**Step 2: Update panel-spec.md**

Add `"dock"` to placement documentation. Document that dock panels:
- Appear between chat and input
- Controlled by `__modals` (same as modal panels)
- Support tab switching when multiple active
- `dockSize` in layout.json controls max-height (px), defaults to content auto (max 50vh)

**Step 3: Update builder-prompt.md**

Add `"dock"` to placement options in the layout.json section.

**Step 4: Update CLAUDE.md**

Add dock to the "Panel placement types" convention bullet:
```
- **Panel placement types**: `layout.json` `panels.placement` supports `"left"`, `"right"`, `"modal"`, `"dock"`. Panels without placement are inline.
```

Add fillInput to conventions:
```
- **Panel bridge methods**: `sendMessage(text)` sends immediately, `fillInput(text)` inserts at cursor without sending. Both available on `window.__panelBridge`.
```

**Step 5: Commit**
```bash
git add panel-spec.md builder-prompt.md CLAUDE.md src/hooks/useLayout.ts
git commit -m "docs: add dock panel placement and fillInput to specifications"
```

---

### Task 6: Final integration test

**Step 1: Start dev server**
```bash
npm run dev
```

**Step 2: Manual test plan**

1. Create a test panel HTML file with `placement: "dock"` in layout.json
2. Set `__modals: { "test-panel": "dismissible" }` in variables.json
3. Verify panel appears between chat and input
4. Verify dismiss button works
5. Add `fillInput` call in panel HTML: `<button onclick="__panelBridge.fillInput('test text')">Fill</button>`
6. Verify clicking fills input without sending
7. Verify user can append text and send manually
8. Test with 2+ dock panels — verify tab switching
9. Verify `sendMessage` still works from dock panels

**Step 3: TypeScript build check**
```bash
npm run build
```

**Step 4: Commit any fixes**
