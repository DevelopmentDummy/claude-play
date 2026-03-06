# AGENTS.md

This file provides guidance to OpenAI Codex CLI when working with code in this repository.

## Project Overview

Claude Bridge is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI. Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory.

> **Note**: This project controls Claude Code as a subprocess — Codex is used here for development assistance, not as the RP runtime.

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
| `services.ts` | Global singleton (`getServices()`) holding all subsystems. Accumulates assistant turns from NDJSON stream events, extracts `<dialog_response>` tags, detects image tool tokens (`$IMAGE:...$/`), manages chat history persistence. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `session-manager.ts` | CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` per session. Manages layout config, builder sessions, skill copying, and CLAUDE.md assembly. |
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML via WebSocket. |
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `session:bind`, `session:leave` messages. Broadcasts events to session-scoped clients. 5s grace period cleanup on last client disconnect. |
| `comfyui-client.ts` | Optional ComfyUI image generation — queues workflows, polls for results, downloads output images to session `images/` dir. |
| `gemini-image.ts` | Optional Gemini image generation via `generativelanguage.googleapis.com` API. Saves base64 response to session `images/` dir. |
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |
| `sse-manager.ts` | Legacy SSE broadcast (superseded by WebSocket in `ws-server.ts`). |

### MCP Server

`src/mcp/claude-bridge-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude. Configured via `.mcp.json` in the session directory. Provides `claude_bridge` tools for Claude to interact with the bridge (image generation, panel updates, etc.).

### API Routes (`src/app/api/`)

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/personas` | GET | List all personas |
| `/api/personas/[name]` | GET, DELETE | Get/delete persona |
| `/api/personas/[name]/file` | GET, PUT | Read/write individual persona files |
| `/api/personas/[name]/overview` | GET | Full persona overview (files, panels, skills, data) |
| `/api/personas/[name]/images` | GET | Serve persona images |
| `/api/profiles` | GET, POST | List/create user profiles |
| `/api/profiles/[slug]` | GET, PUT, DELETE | CRUD individual profile |
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | GET, DELETE | Get/delete session |
| `/api/sessions/[id]/open` | POST | Open session (spawn Claude, start panels) |
| `/api/sessions/[id]/variables` | GET | Read session variables |
| `/api/sessions/[id]/files` | GET | Serve session files (images, etc.) |
| `/api/chat/send` | POST | Send message to Claude process |
| `/api/chat/history` | GET | Get chat history |
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
| `/` | `page.tsx` | Home — persona list, session list, profile management |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels |

ChatPage manages WebSocket subscription, layout state, and renders ChatMessages + ChatInput + PanelArea. Layout (panel position, size, theme colors) is driven by `layout.json` from the persona.

## Data Model

All data is file-based under `data/` (gitignored):

```
data/
├── personas/{name}/           # Persistent persona templates
│   ├── persona.md             # Character definition (first line = display name)
│   ├── worldview.md           # World/setting description
│   ├── variables.json         # Handlebars template data
│   ├── opening.md             # Opening message shown at session start
│   ├── session-instructions.md # Becomes CLAUDE.md in sessions
│   ├── layout.json            # UI layout & theme config
│   ├── panels/                # Handlebars HTML templates (01-status.html, etc.)
│   ├── skills/                # Claude Code skills copied to sessions
│   ├── images/                # icon.png, profile.png, generated images
│   └── *.json                 # Custom data files (inventory.json, world.json, etc.)
├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
│   ├── (cloned persona files)
│   ├── CLAUDE.md              # Assembled from session-instructions + profile + opening
│   ├── session.json           # Metadata (persona, title, claudeSessionId, model)
│   ├── chat-history.json      # Persisted chat history
│   ├── memory.md              # Session memory (written by Claude)
│   ├── .claude/settings.json  # Permission sandbox
│   ├── .mcp.json              # MCP config for claude_bridge server
│   └── policy-context.json    # Content policy context
├── profiles/{slug}.json       # User profiles (name, description, isPrimary)
└── tools/{name}/skills/       # Global tool skills auto-copied to all sessions
```

## Key Conventions

- **`<dialog_response>` tags**: Claude wraps RP dialogue in these. Both backend (`services.ts`) and frontend (`ChatMessages.tsx`) strip them to show only the RP content. Tool calls and meta-commentary are hidden from the user.
- **Special tokens**: `$IMAGE:path$` and `$PANEL:name$` tokens are extracted from Claude's output for inline image display and panel references.
- **Panel numbering**: Panel files like `01-status.html` — numeric prefix controls display order and is stripped from the UI name.
- **CLAUDE.md dual use**: Builder sessions use `builder-prompt.md` as CLAUDE.md. RP sessions start from `session-instructions.md` and then append shared service guides (`session-primer.yaml`, `session-shared.md`). These are completely different prompts. Note: the `CLAUDE.md` files inside `data/` are consumed by the Claude Code subprocess, not by Codex.
- **Session resume**: Claude session IDs are saved to `session.json` and passed to `claude -p --resume` on reconnect. If resume fails, auto-retries without `--resume`.
- **OOC messages**: Messages prefixed with `OOC:` are out-of-character and excluded from chat history.
- **MCP bootstrap**: Claude is launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config` when that file exists.
- **Permission sandboxing**: Each session has `.claude/settings.json` restricting Claude tools to the session directory.
- **Shadow DOM isolation**: PanelSlot renders panel HTML inside Shadow DOM to isolate CSS.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps the process in cmd.exe.
- **Global singleton pattern**: `services.ts` and `ws-server.ts` use `globalThis[key]` to share state across Next.js hot-reload module instances.
- **System JSON exclusion**: Files like `session.json`, `layout.json`, `chat-history.json` are excluded from custom data file loading in both `PanelEngine` and `SessionManager`.

## Session Lifecycle

1. **Create**: `POST /api/sessions` — Copies persona dir → session dir, assembles CLAUDE.md, writes runtime configs
2. **Open**: `POST /api/sessions/[id]/open` — Syncs persona files, spawns `claude -p` process, starts PanelEngine watcher
3. **Chat**: WebSocket `chat:send` or `POST /api/chat/send` — Pipes user message to Claude stdin, streams NDJSON response events back via WebSocket
4. **Accumulate**: `services.ts` collects `text_delta` stream events into segments, detects tool uses, extracts dialog on `result` event, saves to chat history
5. **Panel refresh**: At end of each Claude turn, `PanelEngine.reload()` re-reads all data files and re-renders panels
6. **Leave/Disconnect**: WebSocket `session:leave` or last client disconnect (after 5s grace) kills Claude process and stops panel engine

## Environment Variables

- `DATA_DIR` — Data directory path (default: `./data`)
- `PORT` — Server port (default: 3340)
- `COMFYUI_URL`, `COMFYUI_WORKFLOW_PATH` — Optional ComfyUI integration
- `GEMINI_API_KEY` — Optional Gemini image generation API key
- `CLAUDE_BRIDGE_API_BASE` — Override API base URL for MCP server (default: `http://127.0.0.1:{PORT}`)

## Style Guide

- TypeScript strict mode — do not use `any` unless absolutely necessary
- Prefer `const` over `let`; avoid `var`
- Use path alias `@/` for imports from `src/`
- Keep API routes thin — business logic belongs in `src/lib/`
- Korean comments and UI strings are intentional — this is a Korean-language project
- Do not add unnecessary abstractions, docstrings, or type annotations to code you did not change
