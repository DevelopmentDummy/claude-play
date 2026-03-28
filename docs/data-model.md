# Data Model

**File-based data** under `data/` (gitignored).

```
data/
├── .setup-complete                  # Setup completion flag
├── chat-options-schema.json         # Chat options UI schema definition
├── tools/{name}/skills/             # Global tool skills auto-copied to all sessions
├── styles/                          # Writing style presets
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
│   ├── policy-context.json          # Content policy context (extreme traits, intimacy policy)
│   ├── comfyui-config.json          # Per-persona ComfyUI settings override
│   ├── character-tags.json          # Character tag metadata
│   ├── activity-prompts.json        # Autoplay activity prompts
│   ├── story.json                   # Story/narrative state data
│   └── *.json                       # Custom data files (inventory.json, world.json, etc.)
├── sessions/{persona}-{timestamp}/  # Ephemeral session instances
│   ├── (cloned persona files)
│   ├── CLAUDE.md                    # Assembled from session-instructions + profile + opening
│   ├── AGENTS.md                    # Same content as CLAUDE.md (for Codex CLI)
│   ├── GEMINI.md                    # Same content as CLAUDE.md (for Gemini CLI)
│   ├── session.json                 # Metadata (persona, title, sessionId, model)
│   ├── chat-history.json            # Persisted chat history
│   ├── memory.md                    # Session memory (written by AI)
│   ├── .claude/settings.json        # Permission sandbox
│   ├── .mcp.json                    # MCP config for Claude (includes auth token)
│   ├── .codex/config.toml           # MCP config for Codex (includes auth token)
│   ├── policy-context.json          # Content policy context
│   ├── audio/                       # TTS audio output files
│   ├── images/                      # Generated images
│   ├── popups/                      # Popup content
│   └── voice/                       # Session voice files
└── profiles/{slug}.json             # User profiles (name, description, isPrimary)
```
