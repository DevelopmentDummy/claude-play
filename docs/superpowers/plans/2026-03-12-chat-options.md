# Chat Options Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Data-driven chat options system that controls AI prompt generation via Handlebars conditionals and frontend behavior via option values, with global schema + persona/session overrides.

**Architecture:** Global JSON schema defines available options with types, defaults, and scope. `session-shared.md` becomes a Handlebars template compiled with option values. Option changes trigger AI process restart with `--resume`. Frontend renders option UI dynamically from schema.

**Tech Stack:** Handlebars (already a dependency), Next.js API routes, React

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `data/chat-options-schema.json` | Create | Global option definitions |
| `session-shared.md` | Modify | Add Handlebars conditionals around optional sections |
| `src/lib/session-manager.ts` | Modify | Add `resolveOptions()`, modify `buildPromptFromGuideFiles` for Handlebars, add `chat-options.json` to SYSTEM_JSON |
| `src/lib/panel-engine.ts` | Modify | Add `chat-options.json` to SYSTEM_JSON |
| `src/app/api/chat-options/schema/route.ts` | Create | GET schema endpoint |
| `src/app/api/sessions/[id]/options/route.ts` | Create | GET/PUT session options |
| `src/app/api/sessions/[id]/options/apply/route.ts` | Create | POST: save + restart AI process |
| `src/app/api/personas/[name]/options/route.ts` | Create | GET/PUT persona options |
| `src/components/ChatOptionsModal.tsx` | Create | Data-driven options UI modal |
| `src/components/StatusBar.tsx` | Modify | Add settings (⚙) button |
| `src/app/chat/[sessionId]/page.tsx` | Modify | Wire options modal + state |

---

## Task 1: Schema File and Backend Option Resolution

**Files:**
- Create: `data/chat-options-schema.json`
- Modify: `src/lib/session-manager.ts`
- Modify: `src/lib/panel-engine.ts`

- [ ] **Step 1: Create global schema file**

Create `data/chat-options-schema.json`:

```json
[
  {
    "key": "innerMonologue",
    "label": "내면 독백",
    "description": "매 응답에 캐릭터 내면 독백을 포함합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "stagnationGuard",
    "label": "서사 정체 방지",
    "description": "같은 장소/감정/행동 반복 시 전환을 시도합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "generateChoices",
    "label": "선택지 생성",
    "description": "매 응답 끝에 행동 선택지를 제공합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "userProfiling",
    "label": "사용자 프로파일링",
    "description": "대화에서 사용자 성향을 파악하고 memory.md에 기록합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "autoSendDelay",
    "label": "음성 자동 전송 대기",
    "description": "음성 입력 후 자동 전송까지 대기 시간 (ms)",
    "type": "slider",
    "min": 1000,
    "max": 10000,
    "step": 500,
    "unit": "ms",
    "default": 3000,
    "scope": "both",
    "target": "frontend",
    "group": "음성"
  },
  {
    "key": "ttsChunkDelay",
    "label": "TTS 문장 간 지연",
    "description": "TTS 청크 사이 대기 시간 (ms)",
    "type": "slider",
    "min": 0,
    "max": 3000,
    "step": 100,
    "unit": "ms",
    "default": 1000,
    "scope": "session",
    "target": "frontend",
    "group": "음성"
  }
]
```

- [ ] **Step 2: Add `chat-options.json` to SYSTEM_JSON in session-manager.ts**

In `src/lib/session-manager.ts`, find the `SYSTEM_JSON` set (around line 38) and add `"chat-options.json"`.

- [ ] **Step 3: Add `chat-options.json` to SYSTEM_JSON in panel-engine.ts**

In `src/lib/panel-engine.ts`, find the `SYSTEM_JSON` set (around line 12) and add `"chat-options.json"`.

- [ ] **Step 4: Add `resolveOptions` method to SessionManager**

Add to `SessionManager` class:

```typescript
/** Read chat-options-schema.json from app root */
readOptionsSchema(): Record<string, unknown>[] {
  const schemaPath = path.join(getDataDir(), "chat-options-schema.json");
  if (!fs.existsSync(schemaPath)) return [];
  try { return JSON.parse(fs.readFileSync(schemaPath, "utf-8")); } catch { return []; }
}

/** Read chat-options.json from a directory */
readOptions(dir: string): Record<string, unknown> {
  const optPath = path.join(dir, "chat-options.json");
  if (!fs.existsSync(optPath)) return {};
  try { return JSON.parse(fs.readFileSync(optPath, "utf-8")); } catch { return {}; }
}

/** Write chat-options.json to a directory */
writeOptions(dir: string, options: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "chat-options.json"), JSON.stringify(options, null, 2), "utf-8");
}

/** Resolve options: schema defaults → persona overrides → session overrides */
resolveOptions(sessionDir: string): Record<string, unknown> {
  const schema = this.readOptionsSchema();
  const defaults: Record<string, unknown> = {};
  for (const opt of schema) {
    defaults[(opt as { key: string }).key] = (opt as { default: unknown }).default;
  }

  // Persona overrides
  const metaPath = path.join(sessionDir, "session.json");
  let personaOverrides: Record<string, unknown> = {};
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    if (meta.persona) {
      personaOverrides = this.readOptions(this.getPersonaDir(meta.persona));
    }
  } catch { /* ignore */ }

  // Session overrides
  const sessionOverrides = this.readOptions(sessionDir);

  return { ...defaults, ...personaOverrides, ...sessionOverrides };
}
```

- [ ] **Step 5: Modify `buildPromptFromGuideFiles` to accept and apply options**

Change `buildServiceSystemPrompt` signature and `readGuideContent` to compile Handlebars on `.md` files:

```typescript
buildServiceSystemPrompt(personaName?: string, provider?: "claude" | "codex", options?: Record<string, unknown>): string {
  const files = provider === "codex" ? SERVICE_SESSION_GUIDE_FILES_CODEX : SERVICE_SESSION_GUIDE_FILES_CLAUDE;
  return this.buildPromptFromGuideFiles(files, personaName, options);
}

private buildPromptFromGuideFiles(files: readonly string[], personaName?: string, options?: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const filename of files) {
    const guidePath = path.join(this.appRoot, filename);
    if (!fs.existsSync(guidePath)) continue;
    const content = this.readGuideContent(guidePath, personaName, options);
    if (content) sections.push(content);
  }
  return sections.join("\n\n").trim();
}

private readGuideContent(guidePath: string, personaName?: string, options?: Record<string, unknown>): string {
  const raw = fs.readFileSync(guidePath, "utf-8");
  const ext = path.extname(guidePath).toLowerCase();
  let base = ext === ".yaml" || ext === ".yml"
    ? this.extractActiveSystemPrompt(raw) || raw
    : raw;
  const actorName = personaName || "the current persona";
  base = base.replace(/\{agent_name\}/g, actorName).trim();

  // Compile Handlebars for .md files when options are provided
  if (options && (ext === ".md" || ext === "")) {
    try {
      const template = Handlebars.compile(base, { noEscape: true });
      base = template({ options }, { allowProtoPropertiesByDefault: true });
    } catch { /* fall through with uncompiled content */ }
  }

  return base;
}
```

- [ ] **Step 6: Update open route to pass options to buildServiceSystemPrompt**

In `src/app/api/sessions/[id]/open/route.ts`, change line 78:

```typescript
const resolvedOptions = svc.sessions.resolveOptions(sessionDir);
const runtimeSystemPrompt = svc.sessions.buildServiceSystemPrompt(info.persona, provider, resolvedOptions);
```

- [ ] **Step 7: Commit**

```
feat: add chat options resolution and Handlebars prompt compilation
```

---

## Task 2: Handlebars-ify session-shared.md

**Files:**
- Modify: `session-shared.md`

- [ ] **Step 1: Wrap conditional sections in Handlebars blocks**

Wrap these sections in `session-shared.md`:

1. Line 16 (내면 독백): wrap with `{{#if options.innerMonologue}}...{{/if}}`
2. Line 18 (서사 정체): wrap with `{{#if options.stagnationGuard}}...{{/if}}`
3. Lines 28-90 (사용자 프로파일링 + 외형 모델): wrap with `{{#if options.userProfiling}}...{{/if}}`
4. Lines 136-157 (선택지 시스템): wrap with `{{#if options.generateChoices}}...{{/if}}`

Keep all other content unconditional.

- [ ] **Step 2: Commit**

```
feat: add Handlebars conditionals to session-shared.md for chat options
```

---

## Task 3: API Routes

**Files:**
- Create: `src/app/api/chat-options/schema/route.ts`
- Create: `src/app/api/sessions/[id]/options/route.ts`
- Create: `src/app/api/sessions/[id]/options/apply/route.ts`
- Create: `src/app/api/personas/[name]/options/route.ts`

- [ ] **Step 1: Create schema endpoint**

`src/app/api/chat-options/schema/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(req: Request) {
  const { sessions } = getServices();
  const schema = sessions.readOptionsSchema();
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const filtered = scope
    ? schema.filter((o: Record<string, unknown>) => o.scope === scope || o.scope === "both")
    : schema;
  return NextResponse.json(filtered);
}
```

- [ ] **Step 2: Create session options endpoint**

`src/app/api/sessions/[id]/options/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  const schema = sessions.readOptionsSchema();
  const values = sessions.resolveOptions(dir);
  return NextResponse.json({ schema, values });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getSessionDir(id);
  sessions.writeOptions(dir, body);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create session options apply endpoint**

`src/app/api/sessions/[id]/options/apply/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionDir = svc.sessions.getSessionDir(id);

  // Save options
  svc.sessions.writeOptions(sessionDir, body);

  // Check if any prompt-targeting options changed (need restart)
  const schema = svc.sessions.readOptionsSchema();
  const promptKeys = new Set(
    schema
      .filter((o: Record<string, unknown>) => o.target === "prompt" || o.target === "both")
      .map((o: Record<string, unknown>) => o.key as string)
  );
  const hasPromptChanges = Object.keys(body).some(k => promptKeys.has(k));

  if (hasPromptChanges && svc.currentSessionId === id) {
    // Kill current process
    svc.claude.kill();

    // Rebuild prompt with new options
    const resolvedOptions = svc.sessions.resolveOptions(sessionDir);
    const savedModel = svc.sessions.getSessionModel(id) || "";
    const { model, effort } = parseModelEffort(savedModel);
    const provider = providerFromModel(model);

    if (provider !== svc.provider) {
      svc.switchProvider(provider);
    }

    const resumeId = provider === "codex"
      ? svc.sessions.getCodexThreadId(id)
      : svc.sessions.getClaudeSessionId(id);

    const runtimeSystemPrompt = svc.sessions.buildServiceSystemPrompt(info.persona, provider, resolvedOptions);
    svc.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort);

    return NextResponse.json({ ok: true, restarted: true });
  }

  return NextResponse.json({ ok: true, restarted: false });
}
```

- [ ] **Step 4: Create persona options endpoint**

`src/app/api/personas/[name]/options/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  const options = sessions.readOptions(dir);
  return NextResponse.json(options);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = await req.json();
  const { sessions } = getServices();
  const dir = sessions.getPersonaDir(name);
  sessions.writeOptions(dir, body);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Commit**

```
feat: add chat options API routes (schema, session, persona, apply)
```

---

## Task 4: Frontend — ChatOptionsModal Component

**Files:**
- Create: `src/components/ChatOptionsModal.tsx`

- [ ] **Step 1: Create ChatOptionsModal**

Data-driven modal that renders UI controls from schema. Receives `schema`, `values`, `onApply`, `onClose` props. Groups options by `group` field. Renders `boolean` as toggle, `slider` as range input, `select` as dropdown. "적용" button calls `onApply(changedValues)`. Tracks local state for edits.

Key considerations:
- Filter schema by scope before passing to modal (caller responsibility)
- Show "(재시작 필요)" indicator next to `target: "prompt"` options
- "적용" button label changes to "적용 (재시작)" if any prompt options changed

- [ ] **Step 2: Commit**

```
feat: add data-driven ChatOptionsModal component
```

---

## Task 5: Frontend — Wire Options to StatusBar and ChatPage

**Files:**
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx`

- [ ] **Step 1: Add settings button to StatusBar**

Add `onSettings?: () => void` prop. Render ⚙ button next to existing buttons.

- [ ] **Step 2: Wire ChatOptionsModal in page.tsx**

- Add `chatOptions` state (resolved values)
- Add `optionsModalOpen` state
- Fetch options on session open (from `/api/sessions/[id]/options` or include in open response)
- StatusBar `onSettings` → open modal
- Modal `onApply` → POST to `/api/sessions/[id]/options/apply` → update local state → close modal
- Pass `chatOptions.autoSendDelay` to ChatInput's `AUTO_SEND_DELAY`

- [ ] **Step 3: Make ChatInput's AUTO_SEND_DELAY configurable via prop**

Change `AUTO_SEND_DELAY` from constant to prop `autoSendDelay` with default 3000.

- [ ] **Step 4: Commit**

```
feat: wire chat options modal to StatusBar and ChatPage
```

---

## Task 6: Integration — Copy options on session creation + open response

**Files:**
- Modify: `src/lib/session-manager.ts` (createSession)
- Modify: `src/app/api/sessions/[id]/open/route.ts`

- [ ] **Step 1: Copy persona's chat-options.json to session on creation**

In `createSession` method, after copying persona files, also copy `chat-options.json` if it exists in persona dir (it's in SKIP_FILES implicitly since it's not skipped, but verify it gets copied by `copyDirRecursive`). Since `chat-options.json` is not in `SKIP_FILES`, it should already be copied. Verify this.

- [ ] **Step 2: Include resolved options in open response**

In the open route, add `chatOptions` to the response JSON:

```typescript
const chatOptions = svc.sessions.resolveOptions(sessionDir);
// Add to response: chatOptions
```

- [ ] **Step 3: Commit**

```
feat: include resolved chat options in session open response
```
