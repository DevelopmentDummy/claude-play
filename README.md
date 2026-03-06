# Claude Bridge

A Next.js web application that bridges interactive roleplay (RP) chat sessions with the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). Create rich personas with dynamic state panels, then conduct immersive sessions powered by Claude.

## Features

- **Persona Builder** — Create and edit character personas with an AI-assisted builder UI
- **Live RP Sessions** — Chat with Claude in-character with automatic session management
- **Dynamic Panels** — Handlebars-templated HTML panels that update in real-time as game state changes
- **Session Resume** — Sessions persist and can be resumed across browser reloads
- **Custom Themes** — Per-persona layout and color themes via `layout.json`
- **User Profiles** — Multiple user profiles injectable into sessions
- **Image Generation** — Optional ComfyUI and Gemini integrations for in-session image generation
- **MCP Integration** — Each session runs its own MCP server, giving Claude tools to interact with the bridge
- **File-Based Storage** — No database required; all data lives in the `data/` directory

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Quick Start

```bash
# Install dependencies
npm install

# Start the dev server (http://localhost:3340)
npm run dev
```

## Usage

1. **Create a Persona** — Click "New Persona" on the home page. The builder AI will guide you through creating character files.
2. **Start a Session** — Select a persona and click "New Session". Optionally choose a user profile.
3. **Chat** — The session opens with the persona's opening message. Type to interact.
4. **Panels** — Dynamic panels on the side show game state (stats, inventory, maps, etc.) updated by Claude during play.

## Project Structure

```
server.ts                          # Custom HTTP + WebSocket server
src/
├── app/
│   ├── page.tsx                   # Home (persona list, sessions, profiles)
│   ├── builder/[name]/page.tsx    # Persona builder UI
│   ├── chat/[sessionId]/page.tsx  # Session chat UI
│   └── api/                       # REST API routes
│       ├── personas/              # Persona CRUD
│       ├── sessions/              # Session CRUD + open
│       ├── profiles/              # User profile CRUD
│       ├── chat/                  # Chat send + history
│       ├── builder/               # Builder start/edit/cancel
│       └── tools/                 # ComfyUI + Gemini image generation
├── lib/
│   ├── services.ts                # Global singleton, chat history, stream processing
│   ├── claude-process.ts          # Claude CLI subprocess management
│   ├── session-manager.ts         # Persona/session/profile file operations
│   ├── panel-engine.ts            # Handlebars panel rendering + file watching
│   ├── ws-server.ts               # WebSocket server for real-time communication
│   ├── comfyui-client.ts          # ComfyUI integration
│   ├── gemini-image.ts            # Gemini image generation
│   └── data-dir.ts                # Data directory resolution
├── mcp/
│   └── claude-bridge-mcp-server.mjs  # Per-session MCP server
├── components/                    # React components
└── hooks/                         # React hooks
data/                              # File-based storage (gitignored)
├── personas/                      # Persona templates
├── sessions/                      # Session instances
├── profiles/                      # User profiles
└── tools/                         # Global tool skills
```

## How It Works

Claude Bridge spawns `claude -p` (Claude Code in pipe mode) as a subprocess for each session, communicating via NDJSON streams. The web UI connects to the server over WebSocket for real-time message streaming.

**Session lifecycle:**
1. Persona directory is cloned to a new session directory
2. `session-instructions.md` becomes the session's `CLAUDE.md`, with profile and opening context appended
3. Claude is spawned with `--resume` (if resuming) and session-specific MCP config
4. User messages flow: Browser → WebSocket → Claude stdin
5. Claude responses flow: Claude stdout (NDJSON) → parsed by services.ts → WebSocket → Browser
6. Panel engine watches `variables.json` and custom data files, re-renders Handlebars templates on change

## Persona Structure

Each persona is a directory under `data/personas/` containing:

| File | Purpose |
|------|---------|
| `persona.md` | Character definition (first line = display name) |
| `worldview.md` | World and setting description |
| `variables.json` | Template data for panels |
| `opening.md` | Opening message shown at session start |
| `session-instructions.md` | Becomes `CLAUDE.md` for sessions |
| `layout.json` | UI layout, panel position, theme colors |
| `panels/*.html` | Handlebars panel templates (prefix number = sort order) |
| `skills/` | Claude Code skills available in session |
| `images/` | `icon.png`, `profile.png`, generated images |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Data directory path |
| `PORT` | `3340` | Server port |
| `COMFYUI_URL` | — | ComfyUI server URL (optional) |
| `COMFYUI_WORKFLOW_PATH` | — | ComfyUI workflow file path (optional) |
| `GEMINI_API_KEY` | — | Google Gemini API key for image generation (optional) |

### Production Build

```bash
npm run build
npm run start
```

## License

Private project.
