# Data Model

**File-based data** under `data/`. User-generated content (`personas/`, `sessions/`, `profiles/`, `styles/`, `deleted_*`, `.runtime/`) is gitignored; shared assets (`skills/`, `builder_skills/`, `style-check/`, `tools/`, `chat-options-schema.json`) are tracked in the repo.

```
data/
├── .setup-complete                  # Setup completion flag
├── .runtime/                        # Runtime process registries (gitignored)
│   ├── agy-procs.json               # Antigravity orphan-PID registry (PIDs keyed by cwd; reaped via killAgyForDir on session/persona DELETE)
│   └── subagent-procs.json          # Sub-agent PID registry
├── .server.pid / restart*.log       # Server PID + restart orchestrator logs (gitignored)
├── chat-options-schema.json         # Chat options UI schema definition
├── skills/                          # Global shared skills (auto-copied to all sessions)
├── builder_skills/                  # Skills exposed only inside builder sessions
├── tools/{name}/                    # Global tool definitions
│   ├── skills/                      # Tool-specific skills auto-copied to all sessions
│   ├── panels/                      # Shared panel HTML auto-mounted into ALL sessions (panel-engine getSharedPanelFiles)
│   ├── panels.removed/              # Soft-deleted shared panels (gitignored)
│   └── comfyui-config.json          # (tools/comfyui only) Default ComfyUI config copied to new personas/sessions (tools/comfyui also tracks checkpoints.json, character-tags.json, panels/, pipeline_meta.json, …)
├── styles/                          # Writing style presets
├── style-check/                     # Shared self-review ruleset (read by runStyleCheckHook)
│   ├── defaults.md                  # Persona-agnostic style diagnostic rules
│   └── review-prompt.md             # Handlebars template ({{rules}}/{{olderBlock}}/{{newerBlock}}/{{priorReport}})
├── profiles/{slug}.json             # User profiles (name, description, isPrimary)
├── deleted_personas/                # Soft-deleted personas (DELETE moves here)
├── deleted_sessions/                # Soft-deleted sessions (DELETE moves here)
├── personas/{name}/                 # Persistent persona templates (also acts as the builder workdir)
│   ├── persona.md                   # Character definition (first line = display name)
│   ├── worldview.md                 # World/setting description
│   ├── opening.md                   # Opening message shown at session start
│   ├── session-instructions.md      # Becomes CLAUDE.md/AGENTS.md/GEMINI.md content in sessions
│   ├── variables.json               # Handlebars template data
│   ├── layout.json                  # UI layout & theme config
│   ├── style.json                   # Writing style preset link/snapshot
│   ├── persona.json                 # (optional) Publish manifest (repo URL, version)
│   ├── panels/                      # Handlebars HTML templates (01-status.html, …)
│   │   └── _actions.meta.json       # Panel-action specs read by panel-actions-meta.ts
│   ├── skills/                      # Persona-specific skills copied to sessions
│   ├── images/                      # icon.png, profile.png, generated images
│   ├── tools/                       # Server-side custom tool scripts (*.js / *.mjs)
│   ├── hooks/                       # Lifecycle hooks (on-message.js, on-assistant.js, on-compaction-resume.js, on-style-check.js)
│   ├── style-check.json             # (optional) Opt-in self-review config {enabled, intervalTurns, rulesPath, model, effort}
│   ├── style-check-rules.md         # (optional) Persona-specific style rules (merged after defaults.md)
│   ├── voice.json                   # TTS voice configuration
│   ├── voice-ref.*                  # TTS reference audio file
│   ├── hint-rules.json              # Snapshot formatting rules for MCP run_tool responses
│   ├── policy-context.json          # Content policy context (extreme traits, intimacy policy)
│   ├── comfyui-config.json          # Per-persona ComfyUI settings override
│   ├── character-tags.json          # Character tag metadata
│   ├── chat-options.json            # Persona-level chat option defaults (two-way synced with sessions)
│   ├── gallery.json                 # Persona gallery metadata (persona-level only; never copied to sessions)
│   ├── engine-meta.json             # (optional) Persona-authored engine-action metadata (actions / auto_tick_hours / available_when); validated by scripts/lint-persona.mjs, not read by the server runtime
│   ├── *.json                       # Custom data files (inventory.json, story.json, tasks.json, policies.json, …) — loaded generically, no server-side schema
│   ├── .sessionignore               # (optional) Top-level names excluded from session cloning/mirroring
│   ├── subagents.json               # Sub-agent manifest (template; copied to session on create; per-sub `model` pin optional — provider/effort derived from it, unset = inherit session)
│   ├── subagents/{name}/
│   │   └── instructions.md          # Role prompt template for this sub-agent
│   ├── .gitignore                   # Excludes runtime artifacts from publish
│   ├── builder-session.json         # Builder mode metadata (provider, conversation id)
│   ├── chat-history.json            # Builder chat history
│   ├── {provider}-stream.log        # Builder NDJSON stream log (claude-/codex-/gemini-/kimi-/antigravity-stream.log per active runtime)
│   ├── CLAUDE.md / AGENTS.md / GEMINI.md  # Builder-mode meta-prompt (overwritten on each builder run)
│   ├── panel-spec.md                # Latest panel-spec copied for builder reference
│   └── .claude/ .agents/ .gemini/ .kimi/ .codex/  # Per-runtime config + skills
├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
│   ├── (cloned persona files above — EXCEPT builder artifacts, skills/, runtime config dirs, chat-history.json, gallery.json, images/, plus persona `.sessionignore` entries; only profile.png/icon.png are copied from images/; gallery images are served from the persona dir via /api/sessions/[id]/persona-images)
│   ├── session.json                 # Metadata (persona, title, createdAt, model, profileSlug + provider-specific resume ids claudeSessionId/codexThreadId/geminiSessionId/kimiSessionId/antigravityCascadeId; provider derived from model)
│   ├── chat-options.json            # Per-session option overrides
│   ├── memory.md                    # Session memory (written by AI)
│   ├── chat-history.json            # Persisted chat history
│   ├── pending-events.json          # Persisted event queue (system-event headers merged into next user turn; fire_ai disk-first fallback)
│   ├── pending-actions.json         # Queued panel actions (POST /api/sessions/[id]/panel-actions)
│   ├── {provider}-stream.log        # NDJSON stream log (claude-/codex-/gemini-/kimi-/antigravity-stream.log per active runtime)
│   ├── CLAUDE.md                    # Assembled from session-instructions + profile + opening + style
│   ├── AGENTS.md                    # Same content as CLAUDE.md (for Codex CLI)
│   ├── GEMINI.md                    # Same content as CLAUDE.md (auto-loaded by Antigravity; Gemini CLI retired — gemini-* models route to Antigravity when NEXT_PUBLIC_DISABLE_GEMINI=true)
│   ├── session-instructions.md      # Retained copy used for persona↔session sync diffing
│   ├── .restart-pending.json        # Restart-recovery marker (+ .restart-pending.processing; builder sessions get the marker in the persona dir instead)
│   ├── .gitignore                   # Copied from persona template (excludes runtime artifacts)
│   ├── panel-spec.md                # Refreshed on every Open
│   ├── policy-context.json          # Content policy context
│   ├── audio/                       # TTS audio output files
│   ├── images/                      # Generated images
│   ├── popups/                      # Popup content
│   ├── voice/                       # Session voice files
│   ├── .claude/settings.json        # Permission sandbox
│   ├── .claude/skills/              # Refreshed shared + tool-specific skills
│   ├── .agents/skills/              # Same skills mirrored for Codex AND Antigravity
│   ├── .gemini/skills/              # Same skills mirrored for Gemini CLI (legacy compat)
│   ├── .kimi/skills/                # Same skills mirrored for Kimi
│   ├── subagents/{name}/            # (.resume-*, transcript.jsonl, sub.log, history.json are runtime-only: gitignored, not mirrored/published)
│   │   ├── instructions.md          # Role prompt (template file, copied from persona dir)
│   │   ├── .resume-{provider}       # Runtime artifact — provider session id for resume (e.g. .resume-claude)
│   │   ├── transcript.jsonl         # OOC side-channel transcript (sub-agent modal / subagent:message WS)
│   │   ├── sub.log                  # Sub-agent stream log
│   │   └── history.json             # Sub-agent conversation history
│   ├── .mcp.json                    # MCP config for Claude (includes auth token)
│   ├── .agents/mcp_config.json      # MCP config for Antigravity (agy reads workspace .agents/mcp_config.json)
│   ├── .gemini/settings.json        # MCP config for Gemini CLI (legacy compat)
│   ├── .codex/config.toml           # Full Codex config (mcp_servers + model_instructions_file + cwd trust); effective because spawn sets CODEX_HOME to the session .codex dir and copies ~/.codex/auth.json in
│   └── .codex/model-instructions.md # Codex system prompt file
```

## Notes

- **Soft delete**: `DELETE /api/personas/[name]` and `DELETE /api/sessions/[id]` move directories into `data/deleted_personas/` and `data/deleted_sessions/` respectively (not hard-deleted).
- **Antigravity orphan PID registry**: `agy.exe` is spawned detached (PowerShell), so dev-server restarts orphan it while it keeps the session dir as its cwd — the soft-delete `rename` then fails with `EBUSY`. `src/lib/antigravity-pid-registry.ts` persists spawned PIDs to `data/.runtime/agy-procs.json` keyed by cwd; both DELETE routes call `killAgyForDir(dir)` (with a liveness check against process name to avoid PID-recycling misfires) before the move. Orphans spawned before this mechanism (or after the registry file is deleted) are not auto-reaped — kill manually with `taskkill /F /PID`.
- **Builder workdir = persona dir**: builder sessions run with the persona directory itself as the AI workdir. `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` inside the persona dir are the *builder* meta-prompt and are overwritten on every `/api/builder/start` and `/api/builder/edit`. Session runs use a separate `sessions/{...}` directory with its own assembled instruction files.
- **Skill propagation**: shared skills under `data/skills/*` and tool-bound skills under `data/tools/*/skills/*` are copied into `.claude/skills/`, `.agents/skills/`, `.gemini/skills/`, and `.kimi/skills/` on every session Open (Antigravity reads `.agents/skills/`). `{{PORT}}` placeholders inside `SKILL.md` and `*.sh` files are substituted with the current server port at copy time.
- **Style check**: opt-in self-review of writing style. Per-session counter `__style_check_counter` is stored in `variables.json` and incremented after each non-OOC assistant turn. When `count % intervalTurns === 0`, the core invokes `hooks/on-style-check.js` with `{recentTurns, defaults, rules, reviewPromptTemplate, config}`. The hook returns `{fireAi}` to spawn a background reviewer that updates `style_drift_verdict` / `style_warning` via the `update_variables` MCP tool. Disabled by default — requires both `style-check.json` (with `enabled:true`) and `hooks/on-style-check.js` to exist in the session dir.
