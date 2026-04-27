# Session Resume Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Sessions" menu in the chat StatusBar (☰ dropdown) that opens a modal listing prior sessions for the current persona, sorted by last activity, with metadata (title, last-activity time, context size, last-message preview, provider). Clicking an item routes to that session and triggers the existing `--resume` flow.

**Architecture:** New `GET /api/personas/{slug}/sessions` endpoint backed by `src/lib/session-list.ts` that scans `data/sessions/`, reads each `session.json`, enriches with provider-specific context-file stats and chat-history last message, and returns items sorted by `lastActivityAt` desc. Frontend adds `SessionListModal` component and wires it through `StatusBar` → `chat/[sessionId]/page.tsx`.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind 3, TypeScript (strict), Node.js fs APIs.

---

## File Structure

**New files:**
- `src/lib/session-list.ts` — list/enrich logic (~200 lines)
- `src/app/api/personas/[slug]/sessions/route.ts` — thin Next.js route (~30 lines)
- `src/components/SessionListModal.tsx` — modal UI (~180 lines)

**Modified files:**
- `src/components/StatusBar.tsx` — add `onSessionList` prop, dropdown item
- `src/app/chat/[sessionId]/page.tsx` — modal state, persona slug fetch, handler wiring
- `docs/api-routes.md` — document new endpoint

---

## Task 1: Backend — `session-list.ts` core (no provider stats)

**Files:**
- Create: `src/lib/session-list.ts`

- [ ] **Step 1: Write the module skeleton with types and base scan**

```ts
// src/lib/session-list.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sessionsRoot } from "./paths";

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: number;
  contextSizeBytes: number | null;
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
  model: string;
  provider: "claude" | "codex" | "gemini";
  isCurrent: boolean;
}

interface SessionMeta {
  persona?: string;
  title?: string;
  createdAt?: string;
  model?: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  geminiSessionId?: string;
}

function readMeta(folderPath: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(path.join(folderPath, "session.json"), "utf-8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

function detectProvider(model?: string): "claude" | "codex" | "gemini" {
  if (!model) return "claude";
  const lower = model.split(":")[0].toLowerCase();
  if (/^(gpt-5|codex-mini|o3|o4)/.test(lower)) return "codex";
  if (/^gemini/.test(lower)) return "gemini";
  return "claude";
}

export function listSessionsForPersona(
  slug: string,
  currentId?: string,
): SessionListItem[] {
  const root = sessionsRoot();
  let folders: string[];
  try {
    folders = fs.readdirSync(root);
  } catch {
    return [];
  }
  const items: SessionListItem[] = [];
  for (const folder of folders) {
    const dir = path.join(root, folder);
    const meta = readMeta(dir);
    if (!meta || meta.persona !== slug) continue;
    items.push(enrichSession(folder, dir, meta, currentId));
  }
  items.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return items;
}

function enrichSession(
  id: string,
  dir: string,
  meta: SessionMeta,
  currentId?: string,
): SessionListItem {
  const provider = detectProvider(meta.model);
  // Provider-specific stats added in Task 2
  const contextSizeBytes: number | null = null;
  const contextMtime: number | null = null;

  const historyPath = path.join(dir, "chat-history.json");
  const historyMtime = safeMtime(historyPath);
  const sessionJsonMtime = safeMtime(path.join(dir, "session.json"));
  const createdAtMs = meta.createdAt ? Date.parse(meta.createdAt) : Date.now();

  const lastActivityAt =
    contextMtime ?? historyMtime ?? sessionJsonMtime ?? createdAtMs;

  const lastMessage = readLastMessage(historyPath);

  return {
    id,
    title: meta.title || id,
    createdAt: meta.createdAt || new Date(createdAtMs).toISOString(),
    lastActivityAt,
    contextSizeBytes,
    lastMessage,
    model: meta.model || "",
    provider,
    isCurrent: id === currentId,
  };
}

function safeMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readLastMessage(
  historyPath: string,
): { role: "user" | "assistant"; preview: string } | null {
  try {
    const raw = fs.readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<{ role?: string; content?: unknown; text?: string }>;
    if (!Array.isArray(parsed)) return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const m = parsed[i];
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = extractText(m);
      if (!text) continue;
      const oneLine = text.replace(/\s+/g, " ").trim();
      const preview = oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
      return { role: m.role as "user" | "assistant", preview };
    }
    return null;
  } catch {
    return null;
  }
}

function extractText(m: { content?: unknown; text?: string }): string {
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text || ""))
      .join(" ");
  }
  return "";
}
```

Note: imports `sessionsRoot` from `./paths` — verify the helper exists and exports the right thing first.

- [ ] **Step 2: Verify `paths.ts` exports `sessionsRoot()`**

Run:
```bash
grep -n "sessionsRoot\|sessionsDir\|sessions" "C:/repository/claude bridge/src/lib/paths.ts"
```

If `sessionsRoot` doesn't exist, find the correct export name (likely `sessionsDir` or similar) and update the import. If no path helper exists, hardcode `path.resolve(process.cwd(), "data", "sessions")` instead.

- [ ] **Step 3: Verify chat-history.json shape**

Read one real chat-history.json to confirm the shape used in `extractText`/`readLastMessage`:

```bash
head -200 "C:/repository/claude bridge/data/sessions/be_a_god-2026-04-21T19-18-59/chat-history.json"
```

If messages use `parts: [{type:"text", text}]` instead of `content`/`text`, extend `extractText` to handle that variant too. If the role values differ (e.g., `"opening"`, `"system"`), ensure the filter still finds user/assistant turns.

- [ ] **Step 4: Manual smoke check**

Run:
```bash
cd "C:/repository/claude bridge" && npx tsx -e "import { listSessionsForPersona } from './src/lib/session-list'; console.log(JSON.stringify(listSessionsForPersona('be_a_god').slice(0,2), null, 2));"
```

Expected: array of 1+ items with `title`, `lastActivityAt`, `lastMessage`. `contextSizeBytes` will be `null` for now.

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-list.ts
git commit -m "feat(session-list): scan + enrich session metadata (no provider stats yet)"
```

---

## Task 2: Backend — provider context-file stats

**Files:**
- Modify: `src/lib/session-list.ts`

- [ ] **Step 1: Add Claude cwd encoder + lookup**

Insert above `enrichSession`:

```ts
// Claude Code encodes the cwd path by replacing every char outside [A-Za-z0-9_]
// with "-". Multiple consecutive non-alnum chars therefore collapse into runs of "-".
// Example: "C:\repository\claude bridge\data\sessions\be_a_god-2026-04-21T19-18-59"
//       => "C--repository-claude-bridge-data-sessions-be_a_god-2026-04-21T19-18-59"
function encodeCwd(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9_]/g, "-");
}

function claudeContextFile(sessionDir: string, claudeSessionId: string): string | null {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  // Primary: encoded session-dir folder
  const primary = path.join(projectsRoot, encodeCwd(sessionDir), `${claudeSessionId}.jsonl`);
  if (fs.existsSync(primary)) return primary;
  // Fallback: scan all project subfolders for the session-id file (handles
  // hash collisions when persona slug contains non-alnum chars like Korean).
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(projectsRoot, d, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
```

- [ ] **Step 2: Add Codex context lookup**

```ts
// Codex stores rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-...-{threadId}.jsonl
// We narrow the search by createdAt date (and a couple adjacent days for safety).
function codexContextFile(threadId: string, createdAtIso: string): string | null {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const created = new Date(createdAtIso);
  if (Number.isNaN(created.getTime())) return null;
  const candidates: Array<{ y: string; m: string; d: string }> = [];
  for (const offset of [0, -1, 1]) {
    const dt = new Date(created);
    dt.setDate(dt.getDate() + offset);
    candidates.push({
      y: String(dt.getFullYear()),
      m: String(dt.getMonth() + 1).padStart(2, "0"),
      d: String(dt.getDate()).padStart(2, "0"),
    });
  }
  for (const { y, m, d } of candidates) {
    const dayDir = path.join(root, y, m, d);
    let entries: string[];
    try {
      entries = fs.readdirSync(dayDir);
    } catch {
      continue;
    }
    const hit = entries.find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
    if (hit) return path.join(dayDir, hit);
  }
  return null;
}
```

- [ ] **Step 3: Wire context lookups into `enrichSession`**

Replace the placeholder block (`const contextSizeBytes: number | null = null; const contextMtime: number | null = null;`) with:

```ts
let contextPath: string | null = null;
if (provider === "claude" && meta.claudeSessionId) {
  contextPath = claudeContextFile(dir, meta.claudeSessionId);
} else if (provider === "codex" && meta.codexThreadId && meta.createdAt) {
  contextPath = codexContextFile(meta.codexThreadId, meta.createdAt);
}
// Gemini: location not yet identified; leave null. Future work.

let contextSizeBytes: number | null = null;
let contextMtime: number | null = null;
if (contextPath) {
  try {
    const st = fs.statSync(contextPath);
    contextSizeBytes = st.size;
    contextMtime = st.mtimeMs;
  } catch {
    // file removed between exists() and stat() — just leave null
  }
}
```

- [ ] **Step 4: Manual smoke check**

```bash
cd "C:/repository/claude bridge" && npx tsx -e "import { listSessionsForPersona } from './src/lib/session-list'; const r = listSessionsForPersona('be_a_god'); console.log(r.length, r.slice(0,3).map(x => ({id:x.id, size:x.contextSizeBytes, lastActivity: new Date(x.lastActivityAt).toISOString()})));"
```

Expected: at least one item shows a non-null `contextSizeBytes` (the Claude session that has a `claudeSessionId`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-list.ts
git commit -m "feat(session-list): resolve Claude/Codex context file size + mtime"
```

---

## Task 3: API route

**Files:**
- Create: `src/app/api/personas/[slug]/sessions/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { listSessionsForPersona } from "@/lib/session-list";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!slug || slug.includes("/") || slug.includes("..") || slug.includes("\\")) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }
  const currentId = req.nextUrl.searchParams.get("currentId") || undefined;
  const items = listSessionsForPersona(slug, currentId);
  return NextResponse.json({ items });
}
```

- [ ] **Step 2: Smoke-test via curl (dev server running)**

```bash
curl -s "http://localhost:3340/api/personas/be_a_god/sessions" | head -c 500
```

Expected: `{"items":[{...}, ...]}` JSON with the persona's sessions.

If dev server isn't running, skip this step — the modal smoke-test in Task 5 will exercise it.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/personas/[slug]/sessions/route.ts
git commit -m "feat(api): GET /api/personas/[slug]/sessions"
```

---

## Task 4: Modal component

**Files:**
- Create: `src/components/SessionListModal.tsx`

- [ ] **Step 1: Verify the modal pattern used in this codebase**

Read one existing modal to follow the same pattern (overlay, ESC close, etc.):

```bash
grep -l "createPortal\|fixed inset-0" "C:/repository/claude bridge/src/components/SyncModal.tsx" "C:/repository/claude bridge/src/components/UsageModal.tsx"
```

Skim `SyncModal.tsx` for the close pattern and styling tokens. Reuse the same overlay/panel classes for consistency.

- [ ] **Step 2: Write the component**

```tsx
"use client";

import { useEffect, useState } from "react";

interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt: number;
  contextSizeBytes: number | null;
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
  model: string;
  provider: "claude" | "codex" | "gemini";
  isCurrent: boolean;
}

interface SessionListModalProps {
  open: boolean;
  onClose: () => void;
  personaSlug: string;
  currentSessionId: string;
  onPick: (sessionId: string) => void;
}

const PROVIDER_BADGE: Record<SessionListItem["provider"], string> = {
  claude: "bg-[#4a2a1a]/60 text-[#ff9f43]/80 border-[#ff9f43]/15",
  codex: "bg-[#2a5a3a]/60 text-[#4dff91]/80 border-[#4dff91]/15",
  gemini: "bg-[#1a3a5c]/60 text-[#64b5f6]/80 border-[#64b5f6]/15",
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "방금";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}주 전`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SessionListModal({
  open,
  onClose,
  personaSlug,
  currentSessionId,
  onPick,
}: SessionListModalProps) {
  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    const ctrl = new AbortController();
    fetch(
      `/api/personas/${encodeURIComponent(personaSlug)}/sessions?currentId=${encodeURIComponent(currentSessionId)}`,
      { signal: ctrl.signal },
    )
      .then((r) => r.json())
      .then((data) => setItems(data.items || []))
      .catch((e) => {
        if (e.name !== "AbortError") setError(String(e));
      });
    return () => ctrl.abort();
  }, [open, personaSlug, currentSessionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[min(640px,92vw)] max-h-[80vh] bg-[#14141a] border border-white/[0.08]
          rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h2 className="text-sm font-medium text-text">이전 세션 불러오기</h2>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text text-lg leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-2">
          {error && (
            <div className="px-3 py-4 text-xs text-error">불러오기 실패: {error}</div>
          )}
          {!error && items === null && (
            <div className="px-3 py-4 text-xs text-text-dim">로딩 중…</div>
          )}
          {items && items.length === 0 && (
            <div className="px-3 py-6 text-xs text-text-dim text-center">세션이 없습니다.</div>
          )}
          {items && items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => { if (!it.isCurrent) onPick(it.id); }}
              disabled={it.isCurrent}
              className={`w-full text-left px-3 py-2.5 rounded-lg flex flex-col gap-1
                transition-colors duration-fast border border-transparent
                ${it.isCurrent
                  ? "opacity-50 cursor-default"
                  : "hover:bg-plum-soft hover:border-white/[0.08] cursor-pointer"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-text font-medium truncate flex-1">{it.title}</span>
                {it.isCurrent && (
                  <span className="text-[9px] text-accent border border-accent/40 rounded px-1 py-0">현재</span>
                )}
                <span className={`inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold border ${PROVIDER_BADGE[it.provider]}`}>
                  {it.provider}
                </span>
              </div>
              {it.lastMessage && (
                <div className="text-[11px] text-text-mute truncate">
                  <span className="text-text-dim/80">{it.lastMessage.role === "user" ? "나" : "AI"}:</span>{" "}
                  {it.lastMessage.preview}
                </div>
              )}
              <div className="text-[10px] text-text-mute flex items-center gap-2">
                <span>{relativeTime(it.lastActivityAt)}</span>
                <span className="w-[3px] h-[3px] rounded-full bg-white/30" />
                <span>{formatSize(it.contextSizeBytes)}</span>
                <span className="w-[3px] h-[3px] rounded-full bg-white/30" />
                <span className="truncate">{it.model}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Visual sanity check**

Run dev server (if not running):
```bash
cd "C:/repository/claude bridge" && npm run dev
```

Then load any chat session in the browser, open devtools, and verify imports compile (no TS errors yet — modal isn't wired in).

- [ ] **Step 4: Commit**

```bash
git add src/components/SessionListModal.tsx
git commit -m "feat(ui): SessionListModal component"
```

---

## Task 5: Wire into StatusBar + chat page

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx`

- [ ] **Step 1: Add `onSessionList` prop to StatusBar**

Edit `StatusBar.tsx`:

In the props interface (after `onContext?:` block, around line 33):
```ts
  /** Open prior-sessions list modal */
  onSessionList?: () => void;
```

In the destructured props of the function signature, add `onSessionList,`.

In the `hasDebugItems` line (around line 133), include the new prop:
```ts
const hasDebugItems = onUsage || onCompact || onContext || onReinit || (!isBuilderMode && onSync) || onForceInputToggle || onSessionList;
```

In the dropdown JSX, add a new menu item right after the `onUsage` block (before `onForceInputToggle`):
```tsx
{onSessionList && (
  <button
    onClick={() => { onSessionList(); setDebugOpen(false); }}
    className={menuBtnClass}
  >
    Sessions
  </button>
)}
```

- [ ] **Step 2: Wire modal state into chat page**

Edit `src/app/chat/[sessionId]/page.tsx`:

Find an existing modal state (e.g. `syncModalOpen`) and add nearby:
```ts
const [sessionListOpen, setSessionListOpen] = useState(false);
const [personaSlug, setPersonaSlug] = useState<string>("");
```

Find where session metadata is loaded (search for where `setTitle(...)` is called — likely inside a `loadSession`/effect that fetches `/api/sessions/[id]` or similar). Add a sibling setter to capture the persona slug from the same response. If the response doesn't include persona, fall back to:

```ts
fetch(`/api/sessions/${sessionId}`)
  .then((r) => r.json())
  .then((data) => { if (data?.persona) setPersonaSlug(data.persona); });
```

(Verify the actual session metadata route by reading the existing code first — don't add a duplicate fetch if persona is already returned.)

- [ ] **Step 3: Pass `onSessionList` to `StatusBar` and mount the modal**

Find the `<StatusBar` JSX in the chat page and add:
```tsx
onSessionList={() => setSessionListOpen(true)}
```

Below the existing modals (e.g. near `<SyncModal …>`), add:
```tsx
<SessionListModal
  open={sessionListOpen}
  onClose={() => setSessionListOpen(false)}
  personaSlug={personaSlug}
  currentSessionId={sessionId}
  onPick={(id) => {
    setSessionListOpen(false);
    router.push(`/chat/${id}`);
  }}
/>
```

Add the import at the top:
```tsx
import SessionListModal from "@/components/SessionListModal";
```

- [ ] **Step 4: Manual smoke test**

1. Run dev server: `npm run dev`
2. Open any existing session in the browser
3. Click `☰` (Debug/Tools) → click "Sessions"
4. Verify modal opens with the same persona's sessions, sorted newest first
5. Verify metadata: title, last-message preview, relative time, size, provider badge
6. Verify the current session shows "현재" label and is non-clickable
7. Click a different session → URL changes to `/chat/{newId}` and chat loads with prior history (resume)
8. ESC, X button, and overlay click all close the modal

If any step fails, fix and re-test before committing.

- [ ] **Step 5: Commit**

```bash
git add src/components/StatusBar.tsx src/app/chat/\[sessionId\]/page.tsx
git commit -m "feat(chat): Sessions menu in status bar opens session resume modal"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/api-routes.md`

- [ ] **Step 1: Add the new endpoint to api-routes.md**

Read the existing structure first:
```bash
head -40 "C:/repository/claude bridge/docs/api-routes.md"
```

Insert a new row in the personas section matching the existing format. Example (adapt to actual table structure):
```markdown
| GET    | `/api/personas/[slug]/sessions`        | List sessions for persona, sorted by last activity (Sessions resume menu) |
```

- [ ] **Step 2: Commit**

```bash
git add docs/api-routes.md
git commit -m "docs: add /api/personas/[slug]/sessions to api-routes"
```

---

## Self-Review

**Spec coverage:**
- "현재 페르소나 세션만" → Task 1 filters by `meta.persona === slug` ✓
- "마지막 활동 시간 (provider 컨텍스트 mtime → fallback)" → Task 2 + Task 1 fallback chain ✓
- "컨텍스트 파일 용량 (provider별)" → Task 2 ✓
- "마지막 메시지 미리보기 (chat-history.json)" → Task 1 `readLastMessage` ✓
- "최신순 정렬" → Task 1 sort by `lastActivityAt` desc ✓
- "모달 UI" → Task 4 ✓
- "StatusBar ☰ 드롭다운에 신규 항목" → Task 5 ✓
- "클릭 시 해당 세션으로 라우팅 + resume" → Task 5 `router.push` (resume은 기존 open 라우트가 처리) ✓
- "현재 세션 표시 (비활성)" → Task 4 `isCurrent` 처리 ✓
- "보안: slug traversal" → Task 3 ✓
- "Gemini는 1차 구현에서 '—'" → Task 2 ✓

**Placeholder scan:** None. Each step has concrete code or commands.

**Type consistency:** `SessionListItem` shape used identically in `session-list.ts`, the API route (returned via JSON), and `SessionListModal.tsx`. Provider strings (`"claude" | "codex" | "gemini"`) consistent across.

**Identified verifications during execution:**
- Task 1 Step 2: confirm `paths.ts` export name
- Task 1 Step 3: confirm chat-history.json message shape
- Task 5 Step 2: confirm whether existing session metadata fetch returns `persona`
