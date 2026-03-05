# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Bridge is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI. Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory.

## Commands

- `npm run dev` — Start dev server on port 3340 (all interfaces)
- `npm run build` — TypeScript check + Next.js production build
- `npm run start` — Serve production build on port 3340

No test framework is configured.

## Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

**Core libraries** (`src/lib/`):
- `services.ts` — Global singleton holding all subsystems, chat history accumulation, `<dialog_response>` tag extraction
- `claude-process.ts` — Spawns `claude -p` subprocess with NDJSON stream parsing; emits message/status/error/sessionId events
- `session-manager.ts` — CRUD for personas, sessions, profiles; copies persona → session directory; persists Claude session IDs for resume
- `panel-engine.ts` — Watches `variables.json` + `panels/*.html`, compiles Handlebars templates, broadcasts rendered HTML via SSE
- `sse-manager.ts` — SSE broadcast to connected clients
- `comfyui-client.ts` — Optional ComfyUI image generation (configured via `COMFYUI_*` env vars)

**Data is entirely file-based** under `data/` (gitignored):
- `data/personas/{name}/` — Persistent persona templates (persona.md, variables.json, panels/, skills/, session-instructions.md, layout.json, opening.md)
- `data/sessions/{persona}-{timestamp}/` — Ephemeral session instances cloned from persona
- `data/profiles/{slug}.json` — User profiles injected into session CLAUDE.md
- `data/tools/{name}/skills/` — Global tools with skills auto-copied to sessions

**Session creation flow**: Persona directory is recursively copied to a new session directory. `session-instructions.md` becomes the session's `CLAUDE.md`, then service-level guides (`session-primer.yaml` active prompt block, `session-shared.md`) are appended. Builder-specific files (builder-session.json, CLAUDE.md for builder) are skipped during copy.
Session runtime setup also writes `.claude/settings.json` and `.mcp.json` so Claude always boots with the local `claude_bridge` MCP server for that folder.
Runtime setup also ensures `policy-context.json` exists per folder for MCP policy-context lookups.

## Key Conventions

- **`<dialog_response>` tags**: Claude wraps RP dialogue in these. Both backend (`services.ts`) and frontend (`ChatMessages.tsx`) strip them to show only the RP content. Tool calls and meta-commentary are hidden from the user.
- **Panel numbering**: Panel files like `01-status.html` — numeric prefix controls display order and is stripped from the UI name.
- **CLAUDE.md dual use**: Builder sessions use `builder-prompt.md` as CLAUDE.md. RP sessions start from `session-instructions.md` and then append shared service guides. These are completely different prompts.
- **Session resume**: Claude session IDs are saved to `session.json` and passed to `claude -p --resume` on reconnect.
- **MCP bootstrap**: Claude is launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config` when that file exists.
- **Permission sandboxing**: Each session has `.claude/settings.json` restricting Claude tools to the session directory.
- **Shadow DOM isolation**: PanelSlot renders panel HTML inside Shadow DOM to isolate CSS.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps the process in cmd.exe.

## Environment Variables

- `DATA_DIR` — Data directory path (default: `./data`)
- `PORT` — Server port (default: 3340)
- `COMFYUI_URL`, `COMFYUI_WORKFLOW_PATH` — Optional ComfyUI integration

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.

## Frontend Structure

ChatPage (`chat/[sessionId]/page.tsx`) is the main session UI. It manages SSE subscription, layout state, and renders ChatMessages + ChatInput + PanelArea. Layout (panel position, size, theme colors) is driven by `layout.json` from the persona.
