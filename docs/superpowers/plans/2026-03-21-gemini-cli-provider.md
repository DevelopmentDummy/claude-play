# Gemini CLI Provider Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gemini CLI as a third AI provider alongside Claude and Codex, enabling users to select Gemini models for RP sessions and builder mode.

**Architecture:** Gemini CLI uses `gemini -p` with `--output-format stream-json` (NDJSON), similar to Claude. Unlike Claude, it lacks `--input-format stream-json` — multi-turn uses `--resume` with session IDs. System prompt delivered via `GEMINI.md` file (auto-loaded from cwd). MCP configured via `.gemini/settings.json`.

**Tech Stack:** Gemini CLI 0.34.0, TypeScript, Next.js 15, EventEmitter pattern

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/lib/ai-provider.ts` | Add `"gemini"` to `AIProvider` union, model detection, `MODEL_GROUPS` |
| Create | `src/lib/gemini-process.ts` | `GeminiProcess` class — spawn, NDJSON parse, event normalization |
| Modify | `src/lib/session-instance.ts` | Add `GeminiProcess` to `AIProcess` union, update `createProcess()` factory, update image tool name detection |
| Modify | `src/lib/session-manager.ts` | Add Gemini session ID persistence, `.gemini/settings.json` MCP config, `GEMINI.md` writing, guide files, GEMINI.md to all instruction target arrays, SKIP_FILES, sync liveFile |
| Modify | `src/app/api/sessions/[id]/open/route.ts` | Add Gemini resume ID retrieval, Gemini instruction file writing |
| Modify | `src/app/api/builder/start/route.ts` | Add GEMINI.md writing alongside CLAUDE.md/AGENTS.md, Gemini instruction writing |
| Modify | `src/app/api/builder/edit/route.ts` | Add Gemini to service type, default model, provider logic, GEMINI.md writing |
| Modify | `src/app/builder/[name]/page.tsx` | Add "gemini" to builder service selector state type |
| Modify | `src/app/chat/[sessionId]/page.tsx` | Add "gemini" to provider state type |
| Modify | `src/components/StatusBar.tsx` | Add "gemini" to provider/service prop types and selector |
| Modify | `src/hooks/useChat.ts` | Add Gemini MCP tool name to image detection |
| Create | `session-primer-gemini.yaml` | Gemini-specific session primer (adapted from Claude/Codex primers) |

---

### Task 1: Update AI Provider Types and Model Detection

**Files:**
- Modify: `src/lib/ai-provider.ts`

- [ ] **Step 1: Add Gemini to AIProvider type and model detection**

```typescript
// ai-provider.ts changes:

// 1. Update type union
export type AIProvider = "claude" | "codex" | "gemini";

// 2. Add Gemini model detection constants
const GEMINI_MODEL_PREFIXES = ["gemini-"];
const GEMINI_MODEL_EXACT = new Set(["gemini-pro", "gemini-flash"]);

// 3. Update providerFromModel() — add Gemini check BEFORE the default claude return
export function providerFromModel(model: string): AIProvider {
  if (!model) return "claude";
  const base = model.split(":")[0].toLowerCase();
  if (CODEX_MODEL_EXACT.has(base)) return "codex";
  for (const prefix of CODEX_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "codex";
  }
  if (GEMINI_MODEL_EXACT.has(base)) return "gemini";
  for (const prefix of GEMINI_MODEL_PREFIXES) {
    if (base.startsWith(prefix)) return "gemini";
  }
  return "claude";
}

// 4. Add Gemini model group to MODEL_GROUPS array
{
  label: "Gemini",
  provider: "gemini" as AIProvider,
  options: [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  ],
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ai-provider.ts
git commit -m "feat: add Gemini to AIProvider type and model detection"
```

---

### Task 2: Create GeminiProcess Class

**Files:**
- Create: `src/lib/gemini-process.ts`

- [ ] **Step 1: Create GeminiProcess with spawn, NDJSON parsing, and event normalization**

The class follows the same EventEmitter pattern as ClaudeProcess and CodexProcess.

**spawn() signature must match:** `spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions?)`
- `appendSystemPrompt` is ignored (Gemini uses GEMINI.md file-based delivery, like Codex uses .codex/model-instructions.md)
- `effort` is ignored (Gemini doesn't have effort levels)
- `skipPermissions` is ignored (Gemini uses `--yolo` always)

Key differences from Claude:
- Uses `gemini -p "prompt"` with `--output-format stream-json` and `--yolo` (auto-approve tools)
- No `--input-format stream-json` — single prompt per spawn, multi-turn via `--resume`
- NDJSON events have different schema: `init`, `message` (with `delta`), `tool_use`, `tool_result`, `result`
- System prompt via `GEMINI.md` file in cwd (auto-loaded by Gemini CLI)
- MCP via `.gemini/settings.json` in cwd (auto-loaded)
- Session ID from `init` event's `session_id` field
- Resume via `--resume <session_id>`

**Windows handling:** Gemini CLI installed via npm creates a `.cmd` wrapper on Windows. Use `process.platform === "win32" ? "gemini.cmd" : "gemini"` and `shell: true` on Windows (same pattern as CodexProcess).

```typescript
// See claude-process.ts for reference pattern. Key adaptations:

// spawn(cwd, resumeId?, model?, _appendSystemPrompt?, _effort?, _skipPermissions?):
//   Build args: ["--output-format", "stream-json", "--yolo"]
//   if (model) args.push("--model", model)
//   if (resumeId) {
//     args.push("--resume", resumeId, "-p", prompt || "continue")
//   } else {
//     // First message: prompt passed via -p flag
//     // Store that we need to wait for send() to provide the prompt
//     this.pendingFirstMessage = true
//   }
//   On Windows: cmd = "gemini.cmd", shell: true
//   Otherwise: cmd = "gemini", shell: false

// handleStdout(): NDJSON line-buffered parser (same as Claude)

// normalizeEvent(): Convert Gemini events to Claude-compatible format:
//   init → emit sessionId(session_id)
//   message (delta:true) → emit message { type: "assistant", subtype: "text_delta", message: { role: "assistant", content: delta_text } }
//   message (delta:false, role:assistant) → full text, only if no deltas seen
//   tool_use → emit message { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: tool_name, input: parameters }] } }
//   result → emit message { type: "result" }
//   error → emit error(message)

// send(text):
//   If pendingFirstMessage (first send after spawn, no resume):
//     Spawn the actual gemini process with -p "text"
//     pendingFirstMessage = false
//   Else (subsequent messages):
//     Kill current process
//     Respawn with --resume <savedSessionId> -p "text"

// kill(), isRunning(): Same pattern as ClaudeProcess
```

Important implementation details:
- `send()` must handle the fact that Gemini CLI doesn't accept streaming input. Each user message requires:
  - First message (no resume): spawn `gemini -p "text" --output-format stream-json --yolo`
  - Subsequent messages: kill + respawn with `--resume <sessionId> -p "text"`
- Store the session ID from `init` event for resume
- On exit with resume failure, retry without `--resume` (same as ClaudeProcess)
- Clean env: remove CLAUDECODE/CLAUDE_CODE vars (same as other processes)

- [ ] **Step 2: Commit**

```bash
git add src/lib/gemini-process.ts
git commit -m "feat: create GeminiProcess class for Gemini CLI integration"
```

---

### Task 3: Update Session Instance and Factory

**Files:**
- Modify: `src/lib/session-instance.ts`

- [ ] **Step 1: Add GeminiProcess to imports and AIProcess union**

```typescript
import { GeminiProcess } from "./gemini-process";

export type AIProcess = ClaudeProcess | CodexProcess | GeminiProcess;
```

- [ ] **Step 2: Update createProcess() factory**

```typescript
function createProcess(provider: AIProvider): AIProcess {
  if (provider === "codex") return new CodexProcess();
  if (provider === "gemini") return new GeminiProcess();
  return new ClaudeProcess();
}
```

- [ ] **Step 3: Update sessionId event handler for Gemini**

In `bindProcessEvents()`, the `sessionId` handler saves IDs per-provider. Add Gemini case:

```typescript
p.on("sessionId", (sessionId: string) => {
  try {
    if (this.isBuilder) {
      this.sessions.saveBuilderSession(this.id, this._provider, sessionId);
    } else {
      if (this._provider === "codex") {
        this.sessions.saveCodexThreadId(this.id, sessionId);
      } else if (this._provider === "gemini") {
        this.sessions.saveGeminiSessionId(this.id, sessionId);
      } else {
        this.sessions.saveClaudeSessionId(this.id, sessionId);
      }
    }
  } catch (err) {
    console.error("[SessionInstance] ERROR saving sessionId:", err);
  }
});
```

- [ ] **Step 4: Update image tool name detection for Gemini MCP prefix**

In `detectImageToken()` (line 39), add Gemini MCP tool names:

```typescript
const imageToolNames = new Set([
  "mcp__claude_bridge__generate_image",
  "mcp__claude_bridge__generate_image_gemini",
  "mcp__claude_bridge__comfyui_generate",
  "mcp__claude_bridge__gemini_generate",
  // Gemini MCP prefix (hyphen in server name)
  "mcp_claude-bridge_generate_image",
  "mcp_claude-bridge_generate_image_gemini",
  "mcp_claude-bridge_comfyui_generate",
  "mcp_claude-bridge_gemini_generate",
]);
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-instance.ts
git commit -m "feat: add GeminiProcess to session instance factory"
```

---

### Task 4: Update Session Manager — Persistence, Config, and Instruction Files

**Files:**
- Modify: `src/lib/session-manager.ts`

- [ ] **Step 1: Update SessionMeta and BuilderMeta interfaces**

```typescript
interface SessionMeta {
  persona: string;
  title: string;
  createdAt: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  geminiSessionId?: string;  // NEW
  profileSlug?: string;
  model?: string;
}

interface BuilderMeta {
  claudeSessionId?: string;
  codexThreadId?: string;
  geminiSessionId?: string;  // NEW
  provider?: "claude" | "codex" | "gemini";  // UPDATED
}
```

- [ ] **Step 2: Add Gemini session ID persistence methods**

Add these methods following the same pattern as `saveCodexThreadId`/`getCodexThreadId`:

```typescript
saveGeminiSessionId(id: string, geminiSessionId: string): void {
  // Same pattern as saveCodexThreadId but writes meta.geminiSessionId
}

getGeminiSessionId(id: string): string | undefined {
  // Same pattern as getCodexThreadId but reads meta.geminiSessionId
}
```

- [ ] **Step 3: Add Gemini guide files constant**

```typescript
const SERVICE_SESSION_GUIDE_FILES_GEMINI = ["session-primer-gemini.yaml", "session-shared.md"] as const;
```

- [ ] **Step 4: Update buildServiceSystemPrompt() for Gemini**

```typescript
buildServiceSystemPrompt(personaName?: string, provider?: "claude" | "codex" | "gemini", options?: Record<string, unknown>): string {
  const files = provider === "codex"
    ? SERVICE_SESSION_GUIDE_FILES_CODEX
    : provider === "gemini"
    ? SERVICE_SESSION_GUIDE_FILES_GEMINI
    : SERVICE_SESSION_GUIDE_FILES_CLAUDE;
  return this.buildPromptFromGuideFiles(files, personaName, options);
}
```

- [ ] **Step 5: Add writeGeminiConfig() for .gemini/settings.json MCP config**

```typescript
private writeGeminiConfig(
  projectDir: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  const geminiDir = path.join(projectDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const serverScript = path.join(this.appRoot, "src", "mcp", "claude-bridge-mcp-server.mjs");
  const apiBase = (process.env.CLAUDE_BRIDGE_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`)
    .replace(/\/+$/, "");

  const settings = {
    mcpServers: {
      "claude-bridge": {
        command: "node",
        args: [serverScript],
        env: {
          CLAUDE_BRIDGE_API_BASE: apiBase,
          CLAUDE_BRIDGE_SESSION_DIR: projectDir,
          CLAUDE_BRIDGE_MODE: mode,
          CLAUDE_BRIDGE_AUTH_TOKEN: getInternalToken(),
          ...(personaName ? { CLAUDE_BRIDGE_PERSONA: personaName } : {}),
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(geminiDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8"
  );
}
```

- [ ] **Step 6: Add writeGeminiInstructions() for GEMINI.md**

```typescript
writeGeminiInstructions(projectDir: string, content: string): void {
  fs.writeFileSync(path.join(projectDir, "GEMINI.md"), content, "utf-8");
  console.log(`[gemini] Wrote GEMINI.md: ${projectDir} (${content.length} chars)`);
}
```

- [ ] **Step 7: Update ensureClaudeRuntimeConfig() to also write Gemini config**

```typescript
ensureClaudeRuntimeConfig(
  projectDir: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  this.writeClaudeSettings(projectDir);
  this.writeMcpConfig(projectDir, personaName, mode);
  this.writeCodexConfig(projectDir, personaName, mode);
  this.writeGeminiConfig(projectDir, personaName, mode);  // NEW
  this.ensurePolicyContext(projectDir);
}
```

- [ ] **Step 8: Add GEMINI.md to all instruction target arrays**

This is critical — there are 6+ locations where `["CLAUDE.md", "AGENTS.md"]` is used. All must include `"GEMINI.md"`:

1. **Session creation** (~line 497-503): Where `session-instructions.md` is copied as instruction files. Add `GEMINI.md` to the copy targets.
2. **Style injection** (~line 532): `for (const file of ["CLAUDE.md", "AGENTS.md"])` → add `"GEMINI.md"`
3. **Profile injection** (~line 544): Same array → add `"GEMINI.md"`
4. **Opening injection** (~line 560): Same array → add `"GEMINI.md"`
5. **`refreshSessionInstructionFiles()`** (~line 1377): `const targets = ["CLAUDE.md", "AGENTS.md"]` → add `"GEMINI.md"`

- [ ] **Step 9: Add GEMINI.md to SKIP_FILES**

In session copy (~line 494):
```typescript
const SKIP_FILES = new Set(["builder-session.json", "panel-spec.md", "skills", ".claude", "CLAUDE.md", "GEMINI.md", "session-instructions.md", "chat-history.json"]);
```

- [ ] **Step 10: Update sync/diff liveFile resolution (3 locations)**

Lines ~987, ~1072, ~1245 have:
```typescript
const liveFile = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
```
Update all three to:
```typescript
const liveFile = provider === "codex" ? "AGENTS.md" : provider === "gemini" ? "GEMINI.md" : "CLAUDE.md";
```

- [ ] **Step 11: Update saveBuilderSession() and getBuilderSessionId() for Gemini**

```typescript
saveBuilderSession(name: string, provider: "claude" | "codex" | "gemini", sessionId: string): void {
  // ... existing code ...
  meta.provider = provider;
  if (provider === "codex") {
    meta.codexThreadId = sessionId;
  } else if (provider === "gemini") {
    meta.geminiSessionId = sessionId;
  } else {
    meta.claudeSessionId = sessionId;
  }
}

getBuilderSessionId(name: string, provider?: "claude" | "codex" | "gemini"): string | undefined {
  const p = provider || meta.provider || "claude";
  return p === "codex" ? meta.codexThreadId
       : p === "gemini" ? meta.geminiSessionId
       : meta.claudeSessionId;
}

getBuilderProvider(name: string): "claude" | "codex" | "gemini" | undefined {
  // Update return type
}
```

- [ ] **Step 12: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add Gemini persistence, MCP config, instruction files, and sync support"
```

---

### Task 5: Create Gemini Session Primer

**Files:**
- Create: `session-primer-gemini.yaml`

- [ ] **Step 1: Create session-primer-gemini.yaml**

Copy `session-primer-codex.yaml` as base and adapt for Gemini:
- Replace Codex-specific tool references with Gemini equivalents
- MCP tool prefix: `mcp_claude-bridge_toolname` (hyphen in server name)
- Keep the same RP instructions and session-shared.md content structure

- [ ] **Step 2: Commit**

```bash
git add session-primer-gemini.yaml
git commit -m "feat: add Gemini session primer for RP sessions"
```

---

### Task 6: Update API Routes for Gemini Provider

**Files:**
- Modify: `src/app/api/sessions/[id]/open/route.ts`
- Modify: `src/app/api/builder/start/route.ts`
- Modify: `src/app/api/builder/edit/route.ts`

- [ ] **Step 1: Update session open route**

```typescript
// In open/route.ts, update resume ID selection:
const resumeId = provider === "codex"
  ? svc.sessions.getCodexThreadId(id)
  : provider === "gemini"
  ? svc.sessions.getGeminiSessionId(id)
  : svc.sessions.getClaudeSessionId(id);

// Add Gemini instruction writing (like Codex):
if (provider === "codex") {
  svc.sessions.writeCodexInstructions(sessionDir, runtimeSystemPrompt);
} else if (provider === "gemini") {
  svc.sessions.writeGeminiInstructions(sessionDir, runtimeSystemPrompt);
}
```

- [ ] **Step 2: Update builder start route**

In `src/app/api/builder/start/route.ts`:
- Add GEMINI.md writing alongside CLAUDE.md/AGENTS.md (line ~37-38):
```typescript
fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");
fs.writeFileSync(path.join(personaDir, "AGENTS.md"), builderPrompt, "utf-8");
fs.writeFileSync(path.join(personaDir, "GEMINI.md"), builderPrompt, "utf-8");  // NEW
```
- Add Gemini instruction writing where Codex instructions are written (~line 50-52):
```typescript
if (provider === "codex") {
  svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
} else if (provider === "gemini") {
  svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
}
```
- Update default effort for Gemini (~line 54)

- [ ] **Step 3: Update builder edit route**

```typescript
// Update service type to include gemini
const body = (await req.json()) as { name: string; model?: string; service?: "claude" | "codex" | "gemini" };

// Add GEMINI.md writing alongside CLAUDE.md/AGENTS.md (line ~37-38)
fs.writeFileSync(path.join(personaDir, "GEMINI.md"), builderPrompt, "utf-8");

// Update default model for gemini
const effectiveModel = model || (provider === "codex" ? "gpt-5.4" : provider === "gemini" ? "gemini-2.5-flash" : undefined);

// Update default effort (Gemini doesn't use effort suffixes)
const effectiveEffort = effort || (provider === "codex" ? "xhigh" : provider === "gemini" ? undefined : "high");

// Add Gemini instruction writing
if (provider === "codex") {
  svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
} else if (provider === "gemini") {
  svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/open/route.ts src/app/api/builder/start/route.ts src/app/api/builder/edit/route.ts
git commit -m "feat: add Gemini provider support to session open and builder routes"
```

---

### Task 7: Update Frontend Components

**Files:**
- Modify: `src/app/builder/[name]/page.tsx`
- Modify: `src/app/chat/[sessionId]/page.tsx`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/hooks/useChat.ts`

- [ ] **Step 1: Update builder page service state type**

In `src/app/builder/[name]/page.tsx` (~line 40):
```typescript
const [builderService, setBuilderService] = useState<"claude" | "codex" | "gemini">("claude");
```

Also update `handleServiceChange` (~line 148):
```typescript
const handleServiceChange = useCallback(async (newService: "claude" | "codex" | "gemini") => {
```

- [ ] **Step 2: Update chat page provider state type**

In `src/app/chat/[sessionId]/page.tsx` (~line 66):
```typescript
const [provider, setProvider] = useState<"claude" | "codex" | "gemini">("claude");
```

- [ ] **Step 3: Update StatusBar provider/service prop types**

In `src/components/StatusBar.tsx` (~lines 15, 18, 19):
```typescript
provider?: "claude" | "codex" | "gemini";
service?: "claude" | "codex" | "gemini";
onServiceChange?: (service: "claude" | "codex" | "gemini") => void;
```

And the service selector (~line 162):
```typescript
onChange={(e) => onServiceChange(e.target.value as "claude" | "codex" | "gemini")}
```

Add "Gemini" option to the service select dropdown.

- [ ] **Step 4: Update useChat.ts image tool name detection**

In `src/hooks/useChat.ts`, add Gemini MCP tool names to the image detection set (same additions as Task 3 Step 4).

- [ ] **Step 5: Commit**

```bash
git add src/app/builder/[name]/page.tsx src/app/chat/[sessionId]/page.tsx src/components/StatusBar.tsx src/hooks/useChat.ts
git commit -m "feat: add Gemini to frontend service selector and image tool detection"
```

---

### Task 8: Verify Build and Test

- [ ] **Step 1: Run TypeScript check**

Run: `cd "c:/repository/claude bridge" && npm run build 2>&1 | tail -20`
Expected: Build succeeds with no type errors

- [ ] **Step 2: Start dev server and verify model selector shows Gemini options**

Run: `npm run dev`
Open browser, check model dropdown includes Gemini group

- [ ] **Step 3: Test Gemini session creation and chat**

1. Select a Gemini model (e.g., gemini-2.5-flash)
2. Create a new session
3. Verify `.gemini/settings.json` is created in session dir with MCP config
4. Verify `GEMINI.md` is written with system prompt
5. Send a message and verify streaming works
6. Check `gemini-stream.log` for debugging

- [ ] **Step 4: Test session resume**

1. Leave session and re-open
2. Verify `--resume` is used with saved session ID
3. Verify conversation continues

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Gemini CLI provider integration"
```

---

## Implementation Notes

### Gemini CLI Stream Events (NDJSON)

| Event Type | Key Fields | Maps To (Claude Bridge Internal) |
|------------|-----------|----------------------------------|
| `init` | `session_id`, `model` | `emit("sessionId", session_id)` |
| `message` (delta:true) | `content` (text delta) | `{ type: "assistant", subtype: "text_delta", message: { content: text } }` |
| `message` (delta:false) | `content` (full text) | `{ type: "assistant", message: { content: text } }` |
| `tool_use` | `tool_name`, `parameters` | `{ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }` |
| `tool_result` | `tool_id`, `status`, `output` | (not emitted — intermediate) |
| `error` | `message`, `severity` | `emit("error", message)` |
| `result` | `status`, `stats` | `{ type: "result" }` |

### Gemini CLI Key Flags

```
gemini -p "prompt"              # Non-interactive mode
  --output-format stream-json   # NDJSON streaming
  --model gemini-2.5-flash      # Model selection
  --resume <session_id>         # Resume previous session
  --yolo                        # Auto-approve all tool calls
```

### Multi-turn Architecture

Gemini CLI doesn't support `--input-format stream-json`. Each user message requires:
1. First message: spawn `gemini -p "text" --output-format stream-json --yolo`
2. Subsequent messages: kill current process → respawn with `--resume <sessionId> -p "text"`
3. Parse new NDJSON stream each time

This is the critical difference from Claude (which keeps stdin open for streaming input).

### MCP Server Name Convention

- Claude: `claude_bridge` (underscores) → tools: `mcp__claude_bridge__toolname`
- Codex: `claude-bridge` in TOML → tools: auto-mapped
- Gemini: `claude-bridge` (hyphens required) → tools: `mcp_claude-bridge_toolname`

The MCP server itself is provider-agnostic — no changes needed to `claude-bridge-mcp-server.mjs`.

### Windows Process Handling

Gemini CLI installed via npm uses a `.cmd` wrapper on Windows. Use the same pattern as CodexProcess:
```typescript
const cmd = process.platform === "win32" ? "gemini.cmd" : "gemini";
// shell: true on Windows for .cmd resolution
```
