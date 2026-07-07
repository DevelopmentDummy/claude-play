# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Play is a Next.js web app that bridges interactive roleplay (RP) chat sessions with CLI AI runtimes — Claude Code CLI, and optionally Codex CLI, Kimi CLI, and Antigravity (Gemini CLI is retired; Gemini models run via Antigravity). Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory. Single-user personal service with optional admin password authentication.

## Commands

- `node setup.js` — First-time setup: Node deps, Python venv, PyTorch, ports, data/ init. `--yes` for non-interactive mode. Web-driven alternative: `node setup-web.js` (see [AI Setup Guide](docs/ai-setup-guide.md)).
- `npm run dev` — Start dev server (all interfaces), uses `tsx watch server.ts`. `npm run dev:lite` skips TTS + GPU Manager.
- `npm run typecheck` — `tsc --noEmit` (~6s). Run after **every** code change.
- `npm run verify` — Composite repo-code gate: typecheck + lint:data + check:static + smoke. Run before every commit. (`lint:persona` is intentionally excluded — live personas carry pre-existing legacy findings; use it only when authoring personas.)
- `npm run build` — TypeScript check + Next.js production build (~62s). Required before merging to main. **Never run while a production server is serving `.next/`.**
- `npm run start` — Serve production build

No test framework is configured; a few standalone test files exist under `src/lib/*.test.*` — run directly (`npx tsx src/lib/inline-formatter.test.mts`, `npx tsx --test src/lib/session-state.test.ts`).

## Before You Work

1. **Read [docs/maintenance-playbook.md](docs/maintenance-playbook.md) before touching unfamiliar subsystems** — it records the traps, design rationale, and debugging procedures that are not derivable from code. Seemingly wrong code (e.g. non-atomic variables.json writes) is often intentional and documented there.
2. Follow [docs/pre-merge-checklist.md](docs/pre-merge-checklist.md) for every commit/merge.
3. Pending work, deferred decisions, and the live-smoke backlog live in [HANDOVER.md](HANDOVER.md).

## Documentation

Detailed documentation is split into topic-specific files under `docs/`:

| Document | Contents |
|----------|----------|
| [Maintenance Playbook](docs/maintenance-playbook.md) | **Read first** — golden rules, verification ladder, Windows traps, per-provider debugging, subsystem landmines |
| [Pre-Merge Checklist](docs/pre-merge-checklist.md) | Mechanical steps before any commit/merge |
| [Architecture](docs/architecture.md) | Stack, server entry, GPU Manager, Core Libraries (`src/lib/`), MCP Server & Tools |
| [API Routes](docs/api-routes.md) | Complete API route table |
| [Frontend](docs/frontend.md) | Pages, hooks, and components |
| [Data Model](docs/data-model.md) | File-based data directory structure |
| [Shared Documents](docs/shared-documents.md) | Root-level shared document map and assembly flow |
| [Change Propagation](docs/change-propagation.md) | What to update when changing what |
| [Session Lifecycle](docs/session-lifecycle.md) | Session lifecycle steps, Penta Runtime (Claude/Codex/Gemini/Kimi/Antigravity), sub-agents, fire-ai, scheduler, restart recovery |
| [Infrastructure](docs/infrastructure.md) | Conventions, all environment variables |
| [External LLM Routing](docs/external-llm-routing.md) | Codex external gateway / Kimi CLI routing notes |
| [Style Check System](docs/style-check-system.md) | Opt-in per-persona style self-review subsystem |
| [AI Setup Guide](docs/ai-setup-guide.md) | Install flow for AI agents (setup.js / setup-web.js) |

Snapshot of pending work: [HANDOVER.md](HANDOVER.md) (root).

## Quick Reference

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`. tsconfig excludes `data/` and `scratch/` — user-data `.ts` files must never enter the compile program.

**Penta Runtime**: Claude (`claude -p`), Codex (`codex app-server`), Kimi (`kimi --wire`), Antigravity (`agy` via PowerShell spawn; serves Gemini models). Gemini CLI is retired — with `NEXT_PUBLIC_DISABLE_GEMINI=true` (default) `gemini-*` model ids route to Antigravity; `src/lib/gemini-process.ts` is vestigial. Provider is determined by model id at session creation (`providerFromModel()` in `src/lib/ai-provider.ts`) and locked for the session. All providers share the same EventEmitter interface. Codex reads config **only** from `$CODEX_HOME/config.toml` (spawn repoints CODEX_HOME to the session `.codex/`) — cwd `.codex/config.toml` is silently ignored by the CLI.

**Key Entry Points**:
- `server.ts` — Custom HTTP server, WebSocket, spawns TTS server + GPU Manager
- `src/lib/ai-provider.ts` — Provider/model/effort resolution (`providerFromModel`, `MODEL_GROUPS`)
- `src/lib/ai-process-factory.ts` — Constructs the right provider process for a model id
- `src/lib/session-registry.ts` — Active session state management
- `src/lib/session-manager.ts` — File-based session/persona CRUD
- `src/lib/session-instance.ts` — Per-session stateful container (hooks, OOC, fire-ai, sub-agents, events)
- `src/mcp/claude-play-mcp-server.mjs` — Per-session MCP server (status/scheduler, ComfyUI + image generation, policy, run_tool, fire_ai, sub-agent delegation, service restart)
- `src/lib/panel-engine.ts` — Handlebars panel rendering + file watching

**Data**: File-based under `data/` (gitignored, **live user data — never delete or reset**). Personas, sessions, profiles, styles, tools, `.runtime/` PID registries.

## Conventions

- 사용자와의 소통은 **한국어**로. Code identifiers and technical terms stay in English.
- Repo path contains a space (`C:\repository\claude bridge`) — always quote paths in shell commands.
- Windows process-tree kill from bash: `cmd //c "taskkill /T /F /PID X"`.
- JSON consumed by external tools must be written via node `fs`/Write tool — PowerShell 5.1 `-Encoding utf8` writes a BOM that breaks Go parsers (agy).
- Never hand-edit `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` inside `data/personas/{name}/` — the builder overwrites them on every run.
- Specs/plans that must persist in the repo go to `docs/specs/` and `docs/plans/` — `docs/superpowers/` is gitignored (machine-local notes).
- `.next` cache can get stale — delete and restart if API route changes aren't reflected; hard refresh (Ctrl+Shift+R) after frontend changes.
- `docs/` is the source of structural truth. When behavior changes, update docs per [change-propagation.md](docs/change-propagation.md). Last full doc sweep: **2026-07-07**.

## Code Style

- TypeScript strict mode — do not use `any` unless absolutely necessary (src/ was driven to zero explicit `any`).
- Prefer `const` over `let`; avoid `var`. Use path alias `@/` for imports from `src/`.
- Keep API routes thin — business logic belongs in `src/lib/`.
- Korean comments and UI strings are intentional — this is a Korean-language project.
- Do not add unnecessary abstractions, docstrings, or type annotations to code you did not change.

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.
