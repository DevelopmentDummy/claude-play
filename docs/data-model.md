# Data Model

**File-based data** under `data/` (gitignored).

```
data/
├── .setup-complete                  # Setup completion flag
├── chat-options-schema.json         # Chat options UI schema definition
├── skills/                          # Global shared skills (auto-copied to all sessions)
├── builder_skills/                  # Skills exposed only inside builder sessions
├── tools/{name}/                    # Global tool definitions
│   ├── skills/                      # Tool-specific skills auto-copied to all sessions
│   └── comfyui-config.json          # (tools/comfyui only) Default ComfyUI config copied to new personas/sessions
├── styles/                          # Writing style presets
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
│   ├── hooks/                       # Lifecycle hooks (on-message.js, on-assistant.js, on-compaction-resume.js)
│   ├── voice.json                   # TTS voice configuration
│   ├── voice-ref.*                  # TTS reference audio file
│   ├── hint-rules.json              # Snapshot formatting rules for MCP run_tool responses
│   ├── policy-context.json          # Content policy context (extreme traits, intimacy policy)
│   ├── policies.json                # Custom hard-deny / soft policies
│   ├── comfyui-config.json          # Per-persona ComfyUI settings override
│   ├── character-tags.json          # Character tag metadata
│   ├── activity-prompts.json        # Autoplay activity prompts
│   ├── story.json                   # Story/narrative state data
│   ├── events.json                  # Persisted event queue (header → next-turn injection)
│   ├── tasks.json / task_queue.json # Background task scheduling state
│   ├── engine-meta.json             # Cached panel-engine metadata
│   ├── *.json                       # Custom data files (inventory.json, world.json, …)
│   ├── .gitignore                   # Excludes runtime artifacts from publish
│   ├── builder-session.json         # Builder mode metadata (provider, conversation id)
│   ├── chat-history.json            # Builder chat history
│   ├── claude-stream.log            # Builder NDJSON stream log
│   ├── CLAUDE.md / AGENTS.md / GEMINI.md  # Builder-mode meta-prompt (overwritten on each builder run)
│   ├── panel-spec.md                # Latest panel-spec copied for builder reference
│   └── .claude/ .agents/ .gemini/ .kimi/ .codex/  # Per-runtime config + skills
├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
│   ├── (cloned persona files above)
│   ├── session.json                 # Metadata (persona, title, sessionId, model, provider)
│   ├── chat-options.json            # Per-session option overrides
│   ├── memory.md                    # Session memory (written by AI)
│   ├── chat-history.json            # Persisted chat history
│   ├── claude-stream.log            # NDJSON stream log of the active runtime
│   ├── CLAUDE.md                    # Assembled from session-instructions + profile + opening + style
│   ├── AGENTS.md                    # Same content as CLAUDE.md (for Codex CLI)
│   ├── GEMINI.md                    # Same content as CLAUDE.md (for Gemini CLI)
│   ├── panel-spec.md                # Refreshed on every Open
│   ├── policy-context.json          # Content policy context
│   ├── audio/                       # TTS audio output files
│   ├── images/                      # Generated images
│   ├── popups/                      # Popup content
│   ├── voice/                       # Session voice files
│   ├── .claude/settings.json        # Permission sandbox
│   ├── .claude/skills/              # Refreshed shared + tool-specific skills
│   ├── .agents/skills/              # Same skills mirrored for Codex
│   ├── .gemini/skills/              # Same skills mirrored for Gemini
│   ├── .kimi/skills/                # Same skills mirrored for Kimi
│   ├── .mcp.json                    # MCP config for Claude (includes auth token)
│   └── .codex/config.toml           # MCP config for Codex (includes auth token)
```

## Notes

- **Soft delete**: `DELETE /api/personas/[name]` and `DELETE /api/sessions/[id]` move directories into `data/deleted_personas/` and `data/deleted_sessions/` respectively (not hard-deleted).
- **Builder workdir = persona dir**: builder sessions run with the persona directory itself as the AI workdir. `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` inside the persona dir are the *builder* meta-prompt and are overwritten on every `/api/builder/start` and `/api/builder/edit`. Session runs use a separate `sessions/{...}` directory with its own assembled instruction files.
- **Skill propagation**: shared skills under `data/skills/*` and tool-bound skills under `data/tools/*/skills/*` are copied into `.claude/skills/`, `.agents/skills/`, `.gemini/skills/`, and `.kimi/skills/` on every session Open. `{{PORT}}` placeholders inside `SKILL.md` and `*.sh` files are substituted with the current server port at copy time.
