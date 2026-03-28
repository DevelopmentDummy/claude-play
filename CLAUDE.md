# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Play is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI (and optionally Codex CLI, Gemini CLI). Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory. Single-user personal service with optional admin password authentication.

## Commands

- `node setup.js` — First-time setup: Node deps, Python venv, PyTorch, ports, data/ init. `--yes` for non-interactive mode.
- `npm run dev` — Start dev server (all interfaces), uses `tsx watch server.ts`
- `npm run build` — TypeScript check + Next.js production build
- `npm run start` — Serve production build

No test framework is configured.

## Documentation

Detailed documentation is split into topic-specific files under `docs/`:

| Document | Contents |
|----------|----------|
| [Architecture](docs/architecture.md) | Stack, server entry, GPU Manager, Core Libraries (`src/lib/`), MCP Server & Tools |
| [API Routes](docs/api-routes.md) | Complete API route table (50+ endpoints) |
| [Frontend](docs/frontend.md) | Pages (5) and Components (30+) |
| [Data Model](docs/data-model.md) | File-based data directory structure |
| [Shared Documents](docs/shared-documents.md) | Root-level shared document map and assembly flow |
| [Change Propagation](docs/change-propagation.md) | What to update when changing what |
| [Session Lifecycle](docs/session-lifecycle.md) | Session lifecycle steps, Triple Runtime (Claude/Codex/Gemini) |
| [Infrastructure](docs/infrastructure.md) | Conventions, all environment variables |

## Quick Reference

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

**Triple Runtime**: Claude (`claude -p`), Codex (`codex app-server`), Gemini (`gemini --resume`). Provider determined by model at session creation. All share same EventEmitter interface.

**Key Entry Points**:
- `server.ts` — Custom HTTP server, WebSocket, spawns TTS server + GPU Manager
- `src/lib/session-registry.ts` — Active session state management
- `src/lib/session-manager.ts` — File-based session/persona CRUD
- `src/mcp/claude-play-mcp-server.mjs` — Per-session MCP server (11 tools)
- `src/lib/panel-engine.ts` — Handlebars panel rendering + file watching

**Data**: File-based under `data/` (gitignored). Personas, sessions, profiles, styles, tools.

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.
