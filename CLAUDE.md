# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Bridge is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI (and optionally Codex CLI). Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory. Supports per-user accounts with isolated data.

## Commands

- `npm run dev` — Start dev server on port 3340 (all interfaces), uses `tsx watch server.ts`
- `npm run build` — TypeScript check + Next.js production build
- `npm run start` — Serve production build on port 3340

No test framework is configured.

## Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

### Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`.

### Core Libraries (`src/lib/`)

| File | Role |
|------|------|
| `auth.ts` | SQLite-based user accounts (`better-sqlite3`). Cookie (`cb_token`) session auth for browsers. Internal token auth (`x-bridge-token` + `x-bridge-user-id`) for MCP server. `requireAuth()` validates both. `getInternalToken()` generates per-process token. |
| `services.ts` | Per-user singleton (`getServices(userId)`) via `Map<string, Services>`. Accumulates assistant turns from NDJSON stream events, extracts `<dialog_response>` and `<choice>` tags, detects image tool tokens (`$IMAGE:...$/`), manages chat history persistence. Forwards `compacting` system status to frontend. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. |
| `ai-provider.ts` | `AIProvider` type (`"claude" | "codex"`), `providerFromModel()` mapping, model option constants. |
| `session-manager.ts` | CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` + `.codex/config.toml` per session. Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md assembly. Selective persona-to-session sync with diff comparison. |
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files + `layout.json` via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML and layout updates via WebSocket. |
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Per-user auth via cookie on upgrade. Handles `chat:send`, `session:bind`, `session:leave` messages. `wsBroadcastToUser()` for user-scoped broadcasts. 5s grace period cleanup on last client disconnect. |
| `comfyui-client.ts` | Optional ComfyUI image generation — queues workflows, polls for results, downloads output images to session `images/` dir. |
| `gemini-image.ts` | Optional Gemini image generation via `generativelanguage.googleapis.com` API. Saves base64 response to session `images/` dir. |
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()`, `getUserDataDir(userId)`, and `getAppRoot()`. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |

### Authentication

- **Browser**: Cookie-based (`cb_token`) session auth. `src/middleware.ts` (Edge Runtime) checks cookie existence before route handlers.
- **MCP server**: Internal token via `x-bridge-token` + `x-bridge-user-id` headers. Token generated per server process, passed to MCP via `.mcp.json` env vars. Middleware allows requests with `x-bridge-token` header to pass through; actual validation in `requireAuth()`.
- **Login page**: `/login` with register/login toggle. First user creates account, redirected to `/`.

### MCP Server

`src/mcp/claude-bridge-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude/Codex. Configured via `.mcp.json` (Claude) or `.codex/config.toml` (Codex) in the session directory. Provides `claude_bridge` tools for AI to interact with the bridge (image generation, panel updates, policy review, etc.). Authenticates to Bridge API via internal token headers.

### API Routes (`src/app/api/`)

All routes require authentication via `requireAuth()` (cookie or internal token).

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/auth/login` | POST | User login, sets cookie |
| `/api/auth/register` | POST | Create user + auto-login |
| `/api/auth/logout` | POST | Delete token, clear cookie |
| `/api/auth/me` | GET | Current user info |
| `/api/personas` | GET | List all personas |
| `/api/personas/[name]` | GET, DELETE | Get/delete persona |
| `/api/personas/[name]/file` | GET, PUT | Read/write individual persona files |
| `/api/personas/[name]/overview` | GET | Full persona overview (files, panels, skills, data) |
| `/api/personas/[name]/images` | GET | Serve persona images |
| `/api/profiles` | GET, POST | List/create user profiles |
| `/api/profiles/[slug]` | GET, PUT, DELETE | CRUD individual profile |
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | GET, DELETE | Get/delete session |
| `/api/sessions/[id]/open` | POST | Open session (spawn AI process, start panels) |
| `/api/sessions/[id]/sync` | GET, POST | GET: persona↔session diff; POST: selective sync |
| `/api/sessions/[id]/variables` | GET | Read session variables |
| `/api/sessions/[id]/files` | GET | Serve session files (images, etc.) |
| `/api/chat/send` | POST | Send message to AI process |
| `/api/chat/history` | GET, PATCH | GET: paginated history; PATCH: toggle message OOC flag |
| `/api/builder/start` | POST | Start persona builder session |
| `/api/builder/edit` | POST | Send message in builder mode |
| `/api/builder/cancel` | POST | Cancel builder session |
| `/api/tools/comfyui/generate` | POST | Trigger ComfyUI image generation |
| `/api/tools/comfyui/models` | GET | List ComfyUI models |
| `/api/tools/gemini/generate` | POST | Trigger Gemini image generation |
| `/api/debug` | GET | Debug info |

### Frontend Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/login` | `login/page.tsx` | Login / register form |
| `/` | `page.tsx` | Home — persona list, session list, profile management |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels |

ChatPage manages WebSocket subscription, layout state, OOC visibility, and renders ChatMessages + ChatInput + PanelArea + SyncModal. Layout (panel position, size, theme colors) is driven by `layout.json` and updated in real-time via `layout:update` WebSocket events.

### Key Frontend Components

| Component | Role |
|-----------|------|
| `ChatMessages.tsx` | Message rendering with `<dialog_response>` extraction, inline images/panels, infinite scroll (loads until 10 non-OOC messages), per-message OOC toggle on hover. |
| `ChatInput.tsx` | Message input with OOC mode toggle (also controls OOC view visibility), `*` insert button. OOC mode auto-prepends `OOC:` to messages. |
| `StatusBar.tsx` | Navigation bar with model selector, Sync button, status indicator (connected/streaming/compacting/disconnected). Responsive with `flex-wrap` for mobile. |
| `SyncModal.tsx` | Per-element selective persona→session sync with diff badges. |
| `ImageModal.tsx` | Fullscreen image viewer via `createPortal` (escapes `backdrop-blur` containment). |
| `PanelArea.tsx` / `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation. |
| `ModalPanel.tsx` | Modal overlay panel via `createPortal`. Controlled by `__modals` in `variables.json`. Supports required (no dismiss) and dismissible modes. Stacks with incremental z-index. |

## Data Model

**Per-user file-based data** under `data/users/{userId}/` (gitignored). Auth DB at `data/bridge.db`.

```
data/
├── bridge.db                        # SQLite: users + auth_sessions tables
├── tools/{name}/skills/             # Global tool skills auto-copied to all sessions
└── users/{userId}/
    ├── personas/{name}/             # Persistent persona templates
    │   ├── persona.md               # Character definition (first line = display name)
    │   ├── worldview.md             # World/setting description
    │   ├── variables.json           # Handlebars template data
    │   ├── opening.md               # Opening message shown at session start
    │   ├── session-instructions.md  # Becomes CLAUDE.md in sessions
    │   ├── layout.json              # UI layout & theme config
    │   ├── panels/                  # Handlebars HTML templates (01-status.html, etc.)
    │   ├── skills/                  # Claude Code skills copied to sessions
    │   ├── images/                  # icon.png, profile.png, generated images
    │   └── *.json                   # Custom data files (inventory.json, world.json, etc.)
    ├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
    │   ├── (cloned persona files)
    │   ├── CLAUDE.md                # Assembled from session-instructions + profile + opening
    │   ├── AGENTS.md                # Same content as CLAUDE.md (for Codex CLI)
    │   ├── session.json             # Metadata (persona, title, claudeSessionId, codexThreadId, model)
    │   ├── chat-history.json        # Persisted chat history (includes OOC messages with ooc flag)
    │   ├── memory.md                # Session memory (written by AI)
    │   ├── .claude/settings.json    # Permission sandbox
    │   ├── .mcp.json                # MCP config for Claude (includes auth token)
    │   ├── .codex/config.toml       # MCP config for Codex (includes auth token)
    │   └── policy-context.json      # Content policy context
    └── profiles/{slug}.json         # User profiles (name, description, isPrimary)
```

## Key Conventions

- **`<dialog_response>` tags**: Claude wraps RP dialogue in these. Both backend (`services.ts`) and frontend (`ChatMessages.tsx`) strip them to show only the RP content. Tool calls and meta-commentary are hidden from the user.
- **`<choice>` tags**: AI-generated player choices. Extracted for button display, preserved in chat history across reloads. Cleared when user sends any new message.
- **Special tokens**: `$IMAGE:path$` and `$PANEL:name$` tokens are extracted from Claude's output for inline image display and panel references.
- **Panel numbering**: Panel files like `01-status.html` — numeric prefix controls display order and is stripped from the UI name.
- **CLAUDE.md / AGENTS.md dual write**: Both instruction files are generated with identical content for Claude/Codex compatibility.
- **CLAUDE.md dual use**: Builder sessions use `builder-prompt.md` as CLAUDE.md. RP sessions start from `session-instructions.md` and then append shared service guides (`session-primer.yaml`, `session-shared.md`). These are completely different prompts.
- **Session resume**: Claude session IDs and Codex thread IDs are saved to `session.json` and used for resume on reconnect. If resume fails, auto-retries without resume.
- **OOC messages**: Messages prefixed with `OOC:` are out-of-character. Saved to history with `ooc: true` flag. Hidden by default in chat view; visible when OOC mode is toggled on via ChatInput. Per-message OOC flag can be toggled retroactively via hover button.
- **MCP authentication**: Internal token generated per server process, passed via env vars in `.mcp.json` / `.codex/config.toml`. MCP server sends `x-bridge-token` + `x-bridge-user-id` headers. Middleware passes these through; `requireAuth()` validates.
- **MCP bootstrap**: Claude is launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config` when that file exists.
- **Permission sandboxing**: Each session has `.claude/settings.json` restricting Claude tools to the session directory.
- **Panel placement types**: `layout.json` `panels.placement` supports `"left"`, `"right"`, `"modal"`. Panels without placement are inline.
- **Modal panels**: Panels with `placement: "modal"` render as centered overlays. Visibility controlled by `__modals` in `variables.json`. Value `true` = required (no ESC/X/backdrop dismiss), `"dismissible"` = freely closable. `__panelBridge.sendMessage()` always auto-closes regardless. Multiple modals stack with incremental z-index; ESC only affects topmost dismissible modal.
- **Shadow DOM isolation**: PanelSlot and ModalPanel render panel HTML inside Shadow DOM to isolate CSS.
- **Image modal portal**: ImageModal uses `createPortal(document.body)` to escape `backdrop-blur` CSS containment from chat bubbles.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps the process in cmd.exe.
- **Global singleton pattern**: `services.ts` and `ws-server.ts` use `globalThis[key]` to share state across Next.js hot-reload module instances. Services are keyed per-user via `Map<string, Services>`.
- **System JSON exclusion**: Files like `session.json`, `layout.json`, `chat-history.json` are excluded from custom data file loading in both `PanelEngine` and `SessionManager`.
- **Real-time layout updates**: `panel-engine.ts` watches `layout.json` via `fs.watch` and broadcasts `layout:update` WebSocket events. Changes reflect immediately without session re-entry.
- **Compacting status**: Claude CLI `system.status.compacting` events are forwarded to frontend and shown as blue pulsing indicator in StatusBar.

## Session Lifecycle

1. **Create**: `POST /api/sessions` — Copies persona dir → session dir, assembles CLAUDE.md + AGENTS.md, writes runtime configs (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`)
2. **Open**: `POST /api/sessions/[id]/open` — Spawns AI process (Claude or Codex based on model/provider), starts PanelEngine watcher. No automatic persona sync (manual via Sync button).
3. **Chat**: WebSocket `chat:send` or `POST /api/chat/send` — Pipes user message to AI stdin, streams NDJSON response events back via WebSocket
4. **Accumulate**: `services.ts` collects `text_delta` stream events into segments, detects tool uses, extracts dialog + choices on `result` event, saves to chat history
5. **Panel refresh**: At end of each AI turn, `PanelEngine.reload()` re-reads all data files and re-renders panels
6. **Sync** (manual): `POST /api/sessions/[id]/sync` with element selection — selectively copies persona changes to session. Auto-sends OOC notification to CLI.
7. **Leave/Disconnect**: WebSocket `session:leave` or last client disconnect (after 5s grace) kills AI process and stops panel engine

## Dual Runtime (Claude / Codex)

- Provider determined by model at session creation, locked for session lifetime
- Claude: `claude -p` persistent process, NDJSON streaming
- Codex: `codex app-server` persistent JSON-RPC 2.0 over stdin/stdout
- Both share same EventEmitter interface (`message/status/error/sessionId`)
- Instruction files: `CLAUDE.md` (Claude) + `AGENTS.md` (Codex) generated in parallel
- MCP config: `.mcp.json` (Claude) + `.codex/config.toml` (Codex)
- Builder mode supports service switching (Claude↔Codex)

## Environment Variables

- `DATA_DIR` — Data directory path (default: `./data`)
- `PORT` — Server port (default: 3340)
- `COMFYUI_URL`, `COMFYUI_WORKFLOW_PATH` — Optional ComfyUI integration
- `GEMINI_API_KEY` — Optional Gemini image generation API key
- `CLAUDE_BRIDGE_API_BASE` — Override API base URL for MCP server (default: `http://127.0.0.1:{PORT}`)

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.
