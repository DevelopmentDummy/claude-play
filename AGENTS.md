# AGENTS.md

This file provides guidance to OpenAI Codex CLI (and any non-Claude agent) when working with code in this repository.

> **Single source of truth**: read [CLAUDE.md](CLAUDE.md) — project overview, commands, verification gates, conventions, and the documentation map all live there. This file intentionally stays thin: it used to carry a full duplicated snapshot of the architecture, which silently rotted for months. Do not re-inflate it — extend CLAUDE.md and `docs/` instead.

## Mandatory reading order

1. [CLAUDE.md](CLAUDE.md) — commands, conventions, doc map
2. [docs/maintenance-playbook.md](docs/maintenance-playbook.md) — traps, design rationale, debugging procedures (**read before touching unfamiliar subsystems**)
3. [docs/pre-merge-checklist.md](docs/pre-merge-checklist.md) — mechanical steps before any commit
4. [HANDOVER.md](HANDOVER.md) — pending work and deferred decisions

## Codex-specific notes

- This project spawns AI CLIs (including Codex itself, via `codex app-server`) as RP subprocesses — you are being used here for **development assistance**, not as the RP runtime. The `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` files inside `data/` are consumed by those subprocesses, not by you; never edit the ones inside `data/personas/{name}/` (the builder overwrites them).
- Verification: `npm run typecheck` after every change, `npm run verify` before commit, `npm run build` before merge (never while a production server is serving `.next/`).
- 사용자와의 소통은 한국어로.
