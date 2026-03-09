# Bidirectional Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reverse sync (Session → Persona) and custom data file sync to the existing sync system, with a direction toggle in SyncModal.

**Architecture:** Extend SyncModal with a direction toggle tab. Add `getReverseSyncDiff()` and `syncSessionToPersonaSelective()` to SessionManager. Extend API route with `direction` query/body param. Add custom data files as a sync element in both directions. Variables get 3-mode selection (merge/overwrite/skip) for reverse sync.

**Tech Stack:** Next.js API routes, SessionManager (Node fs), React SyncModal component

---

### Task 1: Add custom data files + character-tags to forward sync (SessionManager)

**Files:**
- Modify: `src/lib/session-manager.ts:666-810` (syncPersonaToSessionSelective + getSyncDiff)

**Step 1: Add helper to list custom data files**

Add after the `variablesDiffer` method (~line 846):

```typescript
/** List custom data file names (*.json excluding system files) in a directory */
private getCustomDataFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter(f => {
      if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) return false;
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}
```

**Step 2: Add custom data files + character-tags to getSyncDiff**

In `getSyncDiff()`, before the `return result` line (~line 809), add:

```typescript
// Check character-tags.json
const pCharTags = path.join(personaDir, "character-tags.json");
const sCharTags = path.join(sessionDir, "character-tags.json");
result.push({ key: "characterTags", label: "캐릭터 태그 (character-tags.json)", hasChanges: this.fileDiffers(pCharTags, sCharTags) });

// Check custom data files (*.json excluding system files)
const allDataFiles = new Set([
  ...this.getCustomDataFiles(personaDir),
  ...this.getCustomDataFiles(sessionDir),
]);
if (allDataFiles.size > 0) {
  let dataChanged = false;
  for (const f of allDataFiles) {
    if (this.fileDiffers(path.join(personaDir, f), path.join(sessionDir, f))) {
      dataChanged = true;
      break;
    }
  }
  result.push({ key: "dataFiles", label: `데이터 파일 (${allDataFiles.size}개)`, hasChanges: dataChanged });
}
```

**Step 3: Add custom data files + character-tags to syncPersonaToSessionSelective**

In `syncPersonaToSessionSelective()`, before the skills sync block (~line 736), add:

```typescript
// Sync character-tags.json
if (elements.characterTags) {
  const src = path.join(personaDir, "character-tags.json");
  const dst = path.join(sessionDir, "character-tags.json");
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

// Sync custom data files
if (elements.dataFiles) {
  for (const f of this.getCustomDataFiles(personaDir)) {
    fs.copyFileSync(path.join(personaDir, f), path.join(sessionDir, f));
  }
}
```

**Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add custom data files and character-tags to forward sync"
```

---

### Task 2: Add reverse sync methods to SessionManager

**Files:**
- Modify: `src/lib/session-manager.ts`

**Step 1: Add getReverseSyncDiff method**

Add after `getSyncDiff()` method:

```typescript
/** Compare session vs persona to show what session has changed (reverse direction) */
getReverseSyncDiff(id: string): Array<{ key: string; label: string; hasChanges: boolean }> {
  const sessionDir = this.getSessionDir(id);
  const metaPath = path.join(sessionDir, "session.json");
  if (!fs.existsSync(metaPath)) return [];

  let meta: SessionMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch { return []; }

  const personaDir = this.getPersonaDir(meta.persona);
  if (!fs.existsSync(personaDir)) return [];

  const result: Array<{ key: string; label: string; hasChanges: boolean }> = [];

  // Check panels (session → persona direction)
  const sPanels = path.join(sessionDir, "panels");
  const pPanels = path.join(personaDir, "panels");
  result.push({ key: "panels", label: "패널 (panels/)", hasChanges: this.dirDiffers(sPanels, pPanels) });

  // Check individual files (compare session file vs persona file)
  const files: Array<{ key: string; label: string; sessionFile: string; personaFile: string }> = [
    { key: "layout", label: "레이아웃 (layout.json)", sessionFile: "layout.json", personaFile: "layout.json" },
    { key: "opening", label: "오프닝 메시지 (opening.md)", sessionFile: "opening.md", personaFile: "opening.md" },
    { key: "worldview", label: "세계관 (worldview.md)", sessionFile: "worldview.md", personaFile: "worldview.md" },
    { key: "variables", label: "변수 (variables.json)", sessionFile: "variables.json", personaFile: "variables.json" },
  ];
  for (const { key, label, sessionFile, personaFile } of files) {
    const src = path.join(sessionDir, sessionFile);
    const dst = path.join(personaDir, personaFile);
    result.push({ key, label, hasChanges: this.fileDiffers(src, dst) });
  }

  // Check skills
  const sSkills = path.join(sessionDir, "skills");
  const pSkills = path.join(personaDir, "skills");
  result.push({ key: "skills", label: "스킬 (skills/)", hasChanges: this.dirDiffers(sSkills, pSkills) });

  // Check instructions (session's session-instructions.md vs persona's)
  const instrSrc = path.join(sessionDir, "session-instructions.md");
  const instrDst = path.join(personaDir, "session-instructions.md");
  result.push({ key: "instructions", label: "인스트럭션 (session-instructions.md)", hasChanges: this.fileDiffers(instrSrc, instrDst) });

  // Check character-tags.json
  const sCharTags = path.join(sessionDir, "character-tags.json");
  const pCharTags = path.join(personaDir, "character-tags.json");
  result.push({ key: "characterTags", label: "캐릭터 태그 (character-tags.json)", hasChanges: this.fileDiffers(sCharTags, pCharTags) });

  // Check custom data files
  const allDataFiles = new Set([
    ...this.getCustomDataFiles(personaDir),
    ...this.getCustomDataFiles(sessionDir),
  ]);
  if (allDataFiles.size > 0) {
    let dataChanged = false;
    for (const f of allDataFiles) {
      if (this.fileDiffers(path.join(sessionDir, f), path.join(personaDir, f))) {
        dataChanged = true;
        break;
      }
    }
    result.push({ key: "dataFiles", label: `데이터 파일 (${allDataFiles.size}개)`, hasChanges: dataChanged });
  }

  return result;
}
```

**Step 2: Add syncSessionToPersonaSelective method**

Add after `getReverseSyncDiff()`:

```typescript
/** Reverse sync — copy selected elements from session back to persona */
syncSessionToPersonaSelective(
  id: string,
  elements: Record<string, boolean>,
  variablesMode?: "merge" | "overwrite" | "skip"
): void {
  const sessionDir = this.getSessionDir(id);
  const metaPath = path.join(sessionDir, "session.json");
  if (!fs.existsSync(metaPath)) return;

  let meta: SessionMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch { return; }

  const personaDir = this.getPersonaDir(meta.persona);
  if (!fs.existsSync(personaDir)) return;

  // Sync panels/ (session → persona)
  if (elements.panels) {
    const sessionPanels = path.join(sessionDir, "panels");
    const personaPanels = path.join(personaDir, "panels");
    if (fs.existsSync(sessionPanels)) {
      if (!fs.existsSync(personaPanels)) fs.mkdirSync(personaPanels, { recursive: true });
      for (const file of fs.readdirSync(sessionPanels)) {
        const src = path.join(sessionPanels, file);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(personaPanels, file));
        }
      }
    }
  }

  // Sync variables.json with mode selection
  if (elements.variables && variablesMode !== "skip") {
    const sessionVarsPath = path.join(sessionDir, "variables.json");
    const personaVarsPath = path.join(personaDir, "variables.json");
    if (fs.existsSync(sessionVarsPath)) {
      try {
        const sessionVars = JSON.parse(fs.readFileSync(sessionVarsPath, "utf-8"));
        if (variablesMode === "overwrite") {
          // Full overwrite — replace persona variables with session values
          fs.writeFileSync(personaVarsPath, JSON.stringify(sessionVars, null, 2), "utf-8");
        } else {
          // "merge" (default) — add new keys only, keep existing persona values
          let personaVars: Record<string, unknown> = {};
          if (fs.existsSync(personaVarsPath)) {
            personaVars = JSON.parse(fs.readFileSync(personaVarsPath, "utf-8"));
          }
          let changed = false;
          for (const [key, val] of Object.entries(sessionVars)) {
            if (!(key in personaVars)) {
              personaVars[key] = val;
              changed = true;
            }
          }
          if (changed) {
            fs.writeFileSync(personaVarsPath, JSON.stringify(personaVars, null, 2), "utf-8");
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // Individual files (session → persona)
  const fileMap: Record<string, string> = {
    layout: "layout.json",
    opening: "opening.md",
    worldview: "worldview.md",
  };
  for (const [key, file] of Object.entries(fileMap)) {
    if (elements[key]) {
      const src = path.join(sessionDir, file);
      const dst = path.join(personaDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
  }

  // Sync skills/ (session → persona)
  if (elements.skills) {
    const sessionSkills = path.join(sessionDir, "skills");
    const personaSkills = path.join(personaDir, "skills");
    if (fs.existsSync(sessionSkills)) {
      if (!fs.existsSync(personaSkills)) fs.mkdirSync(personaSkills, { recursive: true });
      for (const entry of fs.readdirSync(sessionSkills, { withFileTypes: true })) {
        const src = path.join(sessionSkills, entry.name);
        const dst = path.join(personaSkills, entry.name);
        if (entry.isDirectory()) {
          this.copyDirRecursive(src, dst);
        } else {
          fs.copyFileSync(src, dst);
        }
      }
    }
  }

  // Sync instructions (session's session-instructions.md → persona)
  if (elements.instructions) {
    const src = path.join(sessionDir, "session-instructions.md");
    const dst = path.join(personaDir, "session-instructions.md");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Sync character-tags.json
  if (elements.characterTags) {
    const src = path.join(sessionDir, "character-tags.json");
    const dst = path.join(personaDir, "character-tags.json");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Sync custom data files
  if (elements.dataFiles) {
    for (const f of this.getCustomDataFiles(sessionDir)) {
      fs.copyFileSync(path.join(sessionDir, f), path.join(personaDir, f));
    }
  }
}
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add reverse sync (session → persona) methods"
```

---

### Task 3: Extend sync API route for bidirectional support

**Files:**
- Modify: `src/app/api/sessions/[id]/sync/route.ts`

**Step 1: Update GET handler for direction param**

```typescript
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET: Compare persona vs session to show diff */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const direction = url.searchParams.get("direction") || "forward";

  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const diff = direction === "reverse"
    ? svc.sessions.getReverseSyncDiff(id)
    : svc.sessions.getSyncDiff(id);

  return NextResponse.json({ diff });
}
```

**Step 2: Update POST handler for direction + variablesMode**

```typescript
/** POST: Sync selected elements between persona and session */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { elements = {}, direction = "forward", variablesMode } = body as {
    elements?: Record<string, boolean>;
    direction?: "forward" | "reverse";
    variablesMode?: "merge" | "overwrite" | "skip";
  };

  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (direction === "reverse") {
    svc.sessions.syncSessionToPersonaSelective(id, elements, variablesMode);
  } else {
    svc.sessions.syncPersonaToSessionSelective(id, elements);
    // Force panel refresh if panels or variables were synced
    if (elements.panels || elements.variables || elements.layout) {
      svc.panels.reload();
    }
  }

  return NextResponse.json({ ok: true });
}
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/sync/route.ts
git commit -m "feat: extend sync API route for bidirectional support"
```

---

### Task 4: Update SyncModal with direction toggle and variables mode

**Files:**
- Modify: `src/components/SyncModal.tsx`

**Step 1: Rewrite SyncModal with direction toggle + variables mode UI**

Replace entire file with updated version that adds:
- Direction toggle tabs at the top (페르소나 → 세션 / 세션 → 페르소나)
- When direction is "reverse" and variables is selected, show sub-radio for variablesMode
- Fetch diff with direction query param
- Post sync with direction + variablesMode in body
- Description text changes based on direction

Key UI additions:
- Tab-style direction toggle in header area
- Conditional variablesMode radio group (only in reverse mode, only when variables is checked)
- Three radio options: "추가만" (merge), "덮어쓰기" (overwrite), "안 함" (skip)

See full implementation in Step 1 code block below.

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";

interface SyncItem {
  key: string;
  label: string;
  hasChanges: boolean;
}

type Direction = "forward" | "reverse";
type VariablesMode = "merge" | "overwrite" | "skip";

interface SyncModalProps {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onSynced: () => void;
}

export default function SyncModal({ open, sessionId, onClose, onSynced }: SyncModalProps) {
  const [direction, setDirection] = useState<Direction>("forward");
  const [items, setItems] = useState<SyncItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [variablesMode, setVariablesMode] = useState<VariablesMode>("merge");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Fetch diff when opened or direction changes
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/sync?direction=${direction}`)
      .then((r) => r.json())
      .then((data) => {
        const diff = (data.diff || []) as SyncItem[];
        setItems(diff);
        const initial: Record<string, boolean> = {};
        for (const item of diff) {
          initial[item.key] = item.hasChanges;
        }
        setSelected(initial);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [open, sessionId, direction]);

  // Reset variablesMode when direction changes
  useEffect(() => {
    setVariablesMode("merge");
  }, [direction]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const selectAll = useCallback(() => {
    setSelected((prev) => {
      const all: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) all[key] = true;
      return all;
    });
  }, []);

  const selectNone = useCallback(() => {
    setSelected((prev) => {
      const none: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) none[key] = false;
      return none;
    });
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      // For reverse sync with variables unchecked or skip mode, adjust
      const effectiveElements = { ...selected };
      if (direction === "reverse" && variablesMode === "skip") {
        effectiveElements.variables = false;
      }

      const res = await fetch(`/api/sessions/${sessionId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elements: effectiveElements,
          direction,
          ...(direction === "reverse" && selected.variables ? { variablesMode } : {}),
        }),
      });
      if (res.ok) {
        onSynced();
        onClose();
      }
    } finally {
      setSyncing(false);
    }
  }, [sessionId, selected, direction, variablesMode, onSynced, onClose]);

  const anySelected = Object.values(selected).some(Boolean);
  // In reverse mode with only variables selected and mode is skip, nothing effective
  const effectiveSelection = direction === "reverse" && variablesMode === "skip"
    ? Object.entries(selected).some(([k, v]) => v && k !== "variables")
    : anySelected;

  if (!open) return null;

  const isReverse = direction === "reverse";

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[8px] flex items-center justify-center z-[100]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface border border-border/70 rounded-2xl w-[420px] max-w-[92vw] max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-border/40">
          <h3 className="text-sm font-semibold text-text">동기화</h3>
          {/* Direction toggle */}
          <div className="flex mt-2.5 rounded-lg overflow-hidden border border-border/50">
            <button
              onClick={() => setDirection("forward")}
              className={`flex-1 py-1.5 text-[11px] font-medium transition-all cursor-pointer
                ${!isReverse
                  ? "bg-accent/15 text-accent border-r border-accent/30"
                  : "bg-transparent text-text-dim/60 border-r border-border/30 hover:text-text-dim hover:bg-surface-light/50"
                }`}
            >
              페르소나 → 세션
            </button>
            <button
              onClick={() => setDirection("reverse")}
              className={`flex-1 py-1.5 text-[11px] font-medium transition-all cursor-pointer
                ${isReverse
                  ? "bg-accent/15 text-accent"
                  : "bg-transparent text-text-dim/60 hover:text-text-dim hover:bg-surface-light/50"
                }`}
            >
              세션 → 페르소나
            </button>
          </div>
          <p className="text-[11px] text-text-dim/60 mt-2">
            {isReverse
              ? "세션에서 변경된 내용을 페르소나에 반영합니다."
              : "페르소나의 최신 파일을 세션에 반영합니다."
            }
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 rounded-full border-2 border-accent/40 border-t-transparent animate-spin" />
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <button
                  onClick={selectAll}
                  className="text-[10px] text-text-dim/60 hover:text-text cursor-pointer transition-colors"
                >
                  전체 선택
                </button>
                <span className="text-[10px] text-text-dim/30">|</span>
                <button
                  onClick={selectNone}
                  className="text-[10px] text-text-dim/60 hover:text-text cursor-pointer transition-colors"
                >
                  선택 해제
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {items.map((item) => (
                  <div key={item.key}>
                    <label
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-fast
                        ${selected[item.key]
                          ? "bg-accent/8 border border-accent/25"
                          : "bg-transparent border border-transparent hover:bg-surface-light/50"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={!!selected[item.key]}
                        onChange={() => toggle(item.key)}
                        className="w-3.5 h-3.5 rounded accent-[var(--accent)] cursor-pointer"
                      />
                      <span className="flex-1 text-[13px] text-text">{item.label}</span>
                      {item.hasChanges ? (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
                          변경됨
                        </span>
                      ) : (
                        <span className="text-[10px] text-text-dim/40">동일</span>
                      )}
                    </label>
                    {/* Variables mode sub-options (reverse sync only) */}
                    {isReverse && item.key === "variables" && selected.variables && (
                      <div className="ml-9 mt-1 mb-1 flex flex-col gap-1">
                        {([
                          { value: "merge" as const, label: "추가된 값만 추가" },
                          { value: "overwrite" as const, label: "세션 값으로 덮어쓰기" },
                          { value: "skip" as const, label: "변수 동기화 안 함" },
                        ]).map((opt) => (
                          <label
                            key={opt.value}
                            className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-surface-light/30 transition-colors"
                          >
                            <input
                              type="radio"
                              name="variablesMode"
                              value={opt.value}
                              checked={variablesMode === opt.value}
                              onChange={() => setVariablesMode(opt.value)}
                              className="w-3 h-3 accent-[var(--accent)] cursor-pointer"
                            />
                            <span className="text-[11px] text-text-dim">{opt.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border/40 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs text-text-dim border border-border/60 bg-transparent
              cursor-pointer hover:bg-surface-light hover:text-text transition-all duration-fast"
          >
            취소
          </button>
          <button
            disabled={!effectiveSelection || syncing}
            onClick={handleSync}
            className="px-4 py-2 rounded-lg text-xs font-medium text-white bg-accent border border-accent
              cursor-pointer hover:bg-accent-hover transition-all duration-fast
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {syncing ? "동기화 중..." : "동기화"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/components/SyncModal.tsx
git commit -m "feat: add bidirectional sync UI with direction toggle and variables mode"
```

---

### Task 5: Update CLAUDE.md conventions

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update sync-related documentation**

In the Key Conventions section, update or add sync-related entries to document:
- Bidirectional sync support (direction toggle in SyncModal)
- Custom data files included in sync
- Variables 3-mode selection for reverse sync (merge/overwrite/skip)
- character-tags.json included in sync

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with bidirectional sync conventions"
```
