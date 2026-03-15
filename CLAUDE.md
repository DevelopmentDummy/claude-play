# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Bridge is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI (and optionally Codex CLI). Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory. Single-user personal service with optional admin password authentication.

## Commands

- `npm run dev` — Start dev server on port 3340 (all interfaces), uses `tsx watch server.ts`
- `npm run build` — TypeScript check + Next.js production build
- `npm run start` — Serve production build on port 3340

No test framework is configured.

## Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

### Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`. Also spawns TTS server and GPU Manager as child processes.

### GPU Manager (`gpu-manager/`)

Python FastAPI child process (port 3342) for serial GPU task queueing. Prevents VRAM conflicts between image generation and TTS by processing one GPU task at a time.

| File | Role |
|------|------|
| `server.py` | FastAPI app with `/health`, `/status`, `/comfyui/generate`, `/tts/synthesize`, `/tts/create-voice` endpoints |
| `queue_manager.py` | Serial asyncio queue — FIFO, one task at a time, per-type timeouts |
| `comfyui_proxy.py` | Proxies image generation requests to ComfyUI API |
| `tts_engine.py` | Qwen3-TTS direct inference — on-demand loading, 30s idle timeout, model size switching |
| `voice_creator.py` | Voice embedding (.pt) generator from design prompt or reference audio |

### Core Libraries (`src/lib/`)

| File | Role |
|------|------|
| `auth.ts` | Authentication. Internal MCP token (`getInternalToken()`, `validateInternalToken()`). Admin auth (`createAuthToken()`, `verifyAuthToken()`, `verifyPassword()`, `parseCookieToken()`). |
| `services.ts` | Global singleton (`getServices()`) via `globalThis`. Accumulates assistant turns from NDJSON stream events, extracts `<dialog_response>` and `<choice>` tags, detects image tool tokens (`$IMAGE:...$/`), manages chat history persistence. Forwards `compacting` system status to frontend. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. |
| `ai-provider.ts` | `AIProvider` type (`"claude" | "codex"`), `providerFromModel()` mapping, model option constants. |
| `session-manager.ts` | CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` + `.codex/config.toml` per session. Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md assembly. Bidirectional sync with diff comparison (forward: persona→session, reverse: session→persona). |
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files + `layout.json` via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML and layout updates via WebSocket. |
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `session:bind`, `session:leave` messages. `wsBroadcast()` for global broadcasts. 5s grace period cleanup on last client disconnect. |
| `comfyui-client.ts` | Optional ComfyUI integration — image generation. Queues workflows, polls for results, downloads output images to session dir. Can route through GPU Manager when available. |
| `tts-handler.ts` | TTS request handler (runs in plain Node via server.ts). Routes to Edge TTS or GPU Manager for local TTS. Handles chat TTS and voice creation/testing. |
| `gemini-image.ts` | Optional Gemini image generation via `generativelanguage.googleapis.com` API. Saves base64 response to session `images/` dir. |
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |

### MCP Server

`src/mcp/claude-bridge-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude/Codex. Configured via `.mcp.json` (Claude) or `.codex/config.toml` (Codex) in the session directory. Provides `claude_bridge` tools for AI to interact with the bridge (image generation, panel updates, policy review, custom tool execution, etc.). Authenticates to Bridge API via internal `x-bridge-token` header. Key tool: `run_tool` — executes custom tool scripts (`tools/*.js`) from the session directory via `/api/sessions/{id}/tools/{name}`, enriches response with a state snapshot formatted by `hint-rules.json` (when present).

### API Routes (`src/app/api/`)

Optional admin password auth via `ADMIN_PASSWORD` env var. MCP server requests include `x-bridge-token` for internal validation.

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/personas` | GET | List all personas |
| `/api/personas/[name]` | GET, DELETE | Get/delete persona |
| `/api/personas/[name]/file` | GET, PUT | Read/write individual persona files |
| `/api/personas/[name]/overview` | GET | Full persona overview (files, panels, skills, data) |
| `/api/personas/[name]/images` | GET | Serve persona images |
| `/api/personas/[name]/voice` | GET, PUT | Read/write voice.json config |
| `/api/personas/[name]/voice/upload` | GET, POST, DELETE | Serve/upload/remove reference audio |
| `/api/profiles` | GET, POST | List/create user profiles |
| `/api/profiles/[slug]` | GET, PUT, DELETE | CRUD individual profile |
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | GET, DELETE | Get/delete session |
| `/api/sessions/[id]/open` | POST | Open session (spawn AI process, start panels) |
| `/api/sessions/[id]/sync` | GET, POST | GET: diff (supports `?direction=reverse`); POST: selective sync with `direction` + `variablesMode` |
| `/api/sessions/[id]/variables` | GET, PATCH | Read/patch session variables (PATCH supports `?file=` for custom data files) |
| `/api/sessions/[id]/events` | POST | Queue event header for next chat message (body: `{ header: string }`) |
| `/api/sessions/[id]/files` | GET | Serve session files (images, etc.) |
| `/api/chat/send` | POST | Send message to AI process |
| `/api/chat/history` | GET, PATCH | GET: paginated history; PATCH: toggle message OOC flag |
| `/api/builder/start` | POST | Start persona builder session |
| `/api/builder/edit` | POST | Send message in builder mode |
| `/api/builder/cancel` | POST | Cancel builder session |
| `/api/tools/comfyui/generate` | POST | Trigger ComfyUI image generation |
| `/api/tools/comfyui/models` | GET | List ComfyUI models |
| `/api/tools/gemini/generate` | POST | Trigger Gemini image generation |
| `/api/sessions/[id]/tools/[name]` | POST | Execute custom panel tool script |
| `/api/auth/login` | POST | Admin login (rate-limited: 5/min per IP) |
| `/api/auth/logout` | POST | Admin logout (clear cookie) |
| `/api/debug` | GET | Debug info |

### Frontend Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/login` | `login/page.tsx` | Admin login page (shown when `ADMIN_PASSWORD` is set) |
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
| `SyncModal.tsx` | Bidirectional sync modal with direction toggle (persona→session / session→persona), per-element selection, diff badges, and variables 3-mode (merge/overwrite/skip) for reverse sync. |
| `ImageModal.tsx` | Fullscreen image viewer via `createPortal` (escapes `backdrop-blur` containment). |
| `PanelArea.tsx` / `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation. |
| `ModalPanel.tsx` | Modal overlay panel via `createPortal`. Controlled by `__modals` in `variables.json`. Supports required (no dismiss) and dismissible modes. Stacks with incremental z-index. |
| `VoiceSettings.tsx` | Per-persona voice configuration — TTS enable/disable, reference audio upload/preview, voice design prompt, language/speed settings. |

## Data Model

**File-based data** under `data/` (gitignored).

```
data/
├── tools/{name}/skills/             # Global tool skills auto-copied to all sessions
├── personas/{name}/                 # Persistent persona templates
│   ├── persona.md                   # Character definition (first line = display name)
│   ├── worldview.md                 # World/setting description
│   ├── variables.json               # Handlebars template data
│   ├── opening.md                   # Opening message shown at session start
│   ├── session-instructions.md      # Becomes CLAUDE.md in sessions
│   ├── layout.json                  # UI layout & theme config
│   ├── panels/                      # Handlebars HTML templates (01-status.html, etc.)
│   ├── skills/                      # Claude Code skills copied to sessions
│   ├── images/                      # icon.png, profile.png, generated images
│   ├── voice.json                   # TTS voice configuration
│   ├── voice-ref.*                  # TTS reference audio file
│   ├── tools/                       # Server-side custom tool scripts (*.js)
│   ├── hint-rules.json              # Snapshot formatting rules for MCP run_tool responses
│   └── *.json                       # Custom data files (inventory.json, world.json, etc.)
├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
│   ├── (cloned persona files)
│   ├── CLAUDE.md                    # Assembled from session-instructions + profile + opening
│   ├── AGENTS.md                    # Same content as CLAUDE.md (for Codex CLI)
│   ├── session.json                 # Metadata (persona, title, claudeSessionId, codexThreadId, model)
│   ├── chat-history.json            # Persisted chat history (includes OOC messages with ooc flag)
│   ├── memory.md                    # Session memory (written by AI)
│   ├── .claude/settings.json        # Permission sandbox
│   ├── .mcp.json                    # MCP config for Claude (includes auth token)
│   ├── .codex/config.toml           # MCP config for Codex (includes auth token)
│   ├── policy-context.json          # Content policy context
│   └── audio/                       # TTS audio output files
└── profiles/{slug}.json             # User profiles (name, description, isPrimary)
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
- **MCP authentication**: Internal token generated per server process, passed via env vars in `.mcp.json` / `.codex/config.toml`. MCP server sends `x-bridge-token` header. Used for internal API validation only.
- **MCP bootstrap**: Claude is launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config` when that file exists.
- **Permission sandboxing**: Each session has `.claude/settings.json` restricting Claude tools to the session directory.
- **Panel placement types**: `layout.json` `panels.placement` supports `"left"`, `"right"`, `"modal"`, `"dock"`. Panels without placement are inline.
- **Modal panels**: Panels with `placement: "modal"` render as centered overlays. Visibility controlled by `__modals` in `variables.json`. Value `true` = required (no ESC/X/backdrop dismiss), `"dismissible"` = freely closable. `__panelBridge.sendMessage()` always auto-closes regardless. Multiple modals stack with incremental z-index; ESC only affects topmost dismissible modal.
- **Dock panels**: Panels with `placement: "dock"` or `"dock-bottom"` render between chat messages and input area (full width). `"dock-left"` / `"dock-right"` float inside the chat scroll area with `position: sticky` — always visible at the bottom corner, and nearby messages shrink to make room (like CSS float/text-wrap around an image). Visibility controlled by `__modals` in `variables.json` (same as modal panels). Multiple dock panels in same direction show as tabs. `panels.dockHeight` (or legacy `panels.dockSize`) in layout.json controls max-height (px). `panels.dockWidth` controls width (px); if omitted, auto-sizes with min 280px / max 50%.
- **Panel bridge methods**: `__panelBridge.sendMessage(text)` sends chat message immediately. `__panelBridge.fillInput(text)` inserts text at cursor in input box without sending. `__panelBridge.updateVariables(patch)` patches variables.json. `__panelBridge.updateData(fileName, patch)` patches custom data files (e.g., `inventory.json`). `__panelBridge.updateLayout(patch)` deep-merges patch into layout.json (e.g., `{ panels: { dockWidth: 500 } }`). `__panelBridge.queueEvent(header)` queues an event header to prepend to the next user message (AI sees it, history doesn't include it; skipped for OOC messages). `__panelBridge.runTool(toolName, args)` executes server-side custom tool scripts.
- **Custom panel tools**: Per-persona server-side JavaScript scripts in `tools/` dir. CommonJS format (`module.exports = async function(context, args)`). Context provides `{ variables, data, sessionDir }`. Return `{ variables, data }` patches to auto-apply. Executed in-process via dynamic `import()` with 10s timeout. Synced bidirectionally like other persona files.
- **MCP `run_tool`**: Session AI calls custom tools via `mcp__claude_bridge__run_tool` instead of curl/bash. Supports single (`{ tool, args }`) and chained (`{ chain: [{tool, args}, ...] }`) execution. Response includes tool results plus an auto-generated state snapshot (formatted by `hint-rules.json` when present). Snapshot includes `display` (formatted value) and `hint` (narrative hint text) per variable.
- **`hint-rules.json`**: Optional per-persona file defining snapshot formatting rules. Each key maps a variable name to `{ format, max_key, tier_mode, tiers }`. `format` supports `{value}`, `{max}`, `{pct}` placeholders. `tiers` maps value ranges to narrative hint strings. Common variables (`location`, `time`, `outfit`, etc.) are auto-included in snapshot without rules.
- **Admin authentication**: Optional via `ADMIN_PASSWORD` env var. HMAC-SHA256 signed tokens in httpOnly cookies (90-day expiry). Next.js Edge Runtime middleware. Rate-limited login (5 attempts/min per IP). MCP server bypasses via `x-bridge-token` header. If `ADMIN_PASSWORD` not set, auth is disabled.
- **Shadow DOM isolation**: PanelSlot and ModalPanel render panel HTML inside Shadow DOM to isolate CSS.
- **Image modal portal**: ImageModal uses `createPortal(document.body)` to escape `backdrop-blur` CSS containment from chat bubbles.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps the process in cmd.exe.
- **Global singleton pattern**: `services.ts` and `ws-server.ts` use `globalThis[key]` to share state across Next.js hot-reload module instances. Services are a global singleton via `getServices()`.
- **System JSON exclusion**: Files like `session.json`, `layout.json`, `chat-history.json` are excluded from custom data file loading in both `PanelEngine` and `SessionManager`.
- **Real-time layout updates**: `panel-engine.ts` watches `layout.json` via `fs.watch` and broadcasts `layout:update` WebSocket events. Changes reflect immediately without session re-entry.
- **Compacting status**: Claude CLI `system.status.compacting` events are forwarded to frontend and shown as blue pulsing indicator in StatusBar.
- **Voice config**: `voice.json` in persona/session dir configures per-character TTS. Fields: `enabled`, `ttsProvider` ("edge"|"local"|"comfyui"), `referenceAudio`, `referenceText`, `design`, `language`, `modelSize` ("0.6B"/"1.7B"), `voiceFile`, `chunkDelay`, `edgeVoice`, `edgeRate`, `edgePitch`. Copied to session on creation.
- **Voice referenceText**: 레퍼런스 오디오의 대본(transcript). 입력 시 ICL 모드로 정확한 음성 클로닝, 비우면 x-vector only (낮은 품질). 레퍼런스 오디오에서 실제로 말하는 내용과 정확히 일치해야 함. 캐릭터의 성격과 말투를 잘 드러내는 3~30초 분량의 대사를 레퍼런스 오디오로 녹음하고, 그 대사를 referenceText에 기입할 것.
- **TTS providers**: Edge TTS (cloud, free) via `tts-server.mjs`, Local TTS via GPU Manager (Qwen3-TTS direct inference). `ttsProvider: "local"` or `"comfyui"` (legacy alias) routes through GPU Manager. Output saved as MP3 to session `audio/` dir.
- **GPU Manager**: Python child process auto-spawned by `server.ts`. Serial queue prevents VRAM conflicts. Health check on startup (30s timeout). Auto-restarts on crash (max 3, 10s backoff). `GPU_MANAGER_PORT` (default 3342), `GPU_MANAGER_PYTHON` env vars.
- **Audio files**: TTS output saved to `audio/` subdir in session. Served via existing `/api/sessions/[id]/files` route. `audio:ready` WebSocket event notifies frontend with URL and messageId.

## Session Lifecycle

1. **Create**: `POST /api/sessions` — Copies persona dir → session dir, assembles CLAUDE.md + AGENTS.md, writes runtime configs (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`)
2. **Open**: `POST /api/sessions/[id]/open` — Spawns AI process (Claude or Codex based on model/provider), starts PanelEngine watcher. No automatic persona sync (manual via Sync button).
3. **Chat**: WebSocket `chat:send` or `POST /api/chat/send` — Pipes user message to AI stdin, streams NDJSON response events back via WebSocket
4. **Accumulate**: `services.ts` collects `text_delta` stream events into segments, detects tool uses, extracts dialog + choices on `result` event, saves to chat history
5. **Panel refresh**: At end of each AI turn, `PanelEngine.reload()` re-reads all data files and re-renders panels
6. **Sync** (manual): `POST /api/sessions/[id]/sync` — bidirectional. Forward (persona→session) auto-sends OOC notification to CLI. Reverse (session→persona) writes back to persona template without notification. Supports custom data files, character-tags, and variables with merge/overwrite/skip modes.
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
- `COMFYUI_HOST` — ComfyUI host (default: `127.0.0.1`)
- `COMFYUI_PORT` — ComfyUI port (default: `8188`)
- `TTS_ENABLED` — Enable/disable TTS globally (default: `true`)
- `TTS_PORT` — Edge TTS server port (default: `3341`)
- `GPU_MANAGER_PORT` — GPU Manager port (default: `3342`)
- `GPU_MANAGER_PYTHON` — Python executable for GPU Manager (default: `python`)
- `ADMIN_PASSWORD` — Admin login password. If not set, authentication is disabled (open access).

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.
