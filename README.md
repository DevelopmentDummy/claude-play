# Claude Play

A Next.js web application that bridges interactive roleplay (RP) chat sessions with the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (and optionally [Codex CLI](https://github.com/openai/codex)). Create rich personas with dynamic state panels, then conduct immersive sessions powered by AI.

## Features

- **Persona Builder** — Create and edit character personas with an AI-assisted builder UI
- **Live RP Sessions** — Chat with Claude/Codex in-character with automatic session management
- **Dynamic Panels** — Handlebars-templated HTML panels (side, modal, dock) that update in real-time
- **Session Resume** — Sessions persist and can be resumed across browser reloads
- **Custom Themes** — Per-persona layout and color themes via `layout.json`
- **User Profiles** — Multiple user profiles injectable into sessions
- **Image Generation** — Optional ComfyUI and Gemini integrations for in-session image generation
- **TTS Voice** — Edge TTS (cloud) and Qwen3-TTS (local GPU, voice cloning)
- **MCP Integration** — Each session runs its own MCP server, giving AI tools to interact with the bridge
- **Admin Auth** — Optional password authentication with HMAC-SHA256 tokens
- **GPU Manager** — Serial GPU task queue preventing VRAM conflicts between image gen and TTS
- **File-Based Storage** — No database required; all data lives in the `data/` directory

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Python 3.10+ (optional — for GPU Manager, local TTS)
- NVIDIA GPU with 8GB+ VRAM (optional — for ComfyUI, local TTS)

## Quick Start

```bash
# 1. Run the setup wizard
node setup.js

# 2. Start the server
npm run dev

# 3. Open http://localhost:3340 in your browser
#    Complete the web setup wizard on first visit
```

For non-interactive setup (AI agents):
```bash
node setup.js --yes
```

See [SETUP.md](SETUP.md) for detailed setup instructions including API-based configuration.

## Usage

1. **Create a Persona** — Click "New Persona" on the home page. The builder AI will guide you through creating character files.
2. **Start a Session** — Select a persona and click "New Session". Optionally choose a user profile.
3. **Chat** — The session opens with the persona's opening message. Type to interact.
4. **Panels** — Dynamic panels show game state (stats, inventory, maps, etc.) updated by AI during play.

## Project Structure

```
setup.js                           # CLI setup wizard (pure JS, zero deps)
server.ts                          # Custom HTTP + WebSocket server
gpu-manager/                       # Python FastAPI GPU task queue
src/
├── app/
│   ├── page.tsx                   # Home (persona list, sessions, profiles)
│   ├── setup/page.tsx             # Web setup wizard
│   ├── login/page.tsx             # Admin login
│   ├── builder/[name]/page.tsx    # Persona builder UI
│   ├── chat/[sessionId]/page.tsx  # Session chat UI
│   └── api/                       # REST API routes
│       ├── auth/                  # Login/logout
│       ├── setup/                 # Setup wizard API
│       ├── personas/              # Persona CRUD
│       ├── sessions/              # Session CRUD + open/sync
│       ├── profiles/              # User profile CRUD
│       ├── chat/                  # Chat send + history
│       ├── builder/               # Builder start/edit/cancel
│       └── tools/                 # ComfyUI + Gemini image generation
├── lib/
│   ├── services.ts                # Global singleton, chat history, stream processing
│   ├── claude-process.ts          # Claude CLI subprocess management
│   ├── codex-process.ts           # Codex CLI subprocess management
│   ├── session-manager.ts         # Persona/session/profile file operations
│   ├── panel-engine.ts            # Handlebars panel rendering + file watching
│   ├── ws-server.ts               # WebSocket server for real-time communication
│   ├── comfyui-client.ts          # ComfyUI integration (image gen, LoRA management)
│   ├── tts-handler.ts             # TTS request routing (Edge TTS / GPU Manager)
│   ├── gemini-image.ts            # Gemini image generation
│   ├── auth.ts                    # Admin auth + MCP internal token
│   ├── setup-guard.ts             # Setup completion check + redirect
│   ├── env-file.ts                # .env.local read/write utility
│   └── data-dir.ts                # Data directory resolution
├── mcp/
│   └── claude-play-mcp-server.mjs  # Per-session MCP server
├── components/                    # React components
└── hooks/                         # React hooks
data/                              # File-based storage (gitignored)
├── personas/                      # Persona templates
├── sessions/                      # Session instances
├── profiles/                      # User profiles
└── tools/                         # Global tool skills + workflows
```

## How It Works

Claude Play spawns `claude -p` (or `codex app-server`) as a subprocess for each session, communicating via NDJSON (or JSON-RPC) streams. The web UI connects over WebSocket for real-time message streaming.

**Session lifecycle:**
1. Persona directory is cloned to a new session directory
2. `session-instructions.md` becomes the session's `CLAUDE.md` / `AGENTS.md`
3. AI process is spawned with session-specific MCP config and permission sandbox
4. User messages flow: Browser → WebSocket → AI stdin
5. AI responses flow: stdout → parsed by services.ts → WebSocket → Browser
6. Panel engine watches `variables.json` and custom data files, re-renders templates on change

## Persona Structure

Each persona is a directory under `data/personas/` containing:

| File | Purpose |
|------|---------|
| `persona.md` | Character definition (first line = display name) |
| `worldview.md` | World and setting description |
| `variables.json` | Template data for panels |
| `opening.md` | Opening message shown at session start |
| `session-instructions.md` | Becomes `CLAUDE.md` for sessions |
| `layout.json` | UI layout, panel placement, theme colors |
| `panels/*.html` | Handlebars panel templates (prefix number = sort order) |
| `skills/` | AI skills available in session |
| `tools/` | Custom server-side tool scripts |
| `voice.json` | TTS voice configuration |
| `images/` | `icon.png`, `profile.png`, generated images |

## Configuration

### Environment Variables

See [`.env.example`](.env.example) for all available variables. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3340` | Main server port (TTS=PORT+1, GPU Manager=PORT+2) |
| `DATA_DIR` | `./data` | Data directory path |
| `ADMIN_PASSWORD` | — | Admin login password (empty = auth disabled) |
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI host |
| `COMFYUI_PORT` | `8188` | ComfyUI port |
| `GEMINI_API_KEY` | — | Gemini image generation API key |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image-preview` | Gemini model |
| `TTS_ENABLED` | `true` | Enable/disable TTS globally |

### Production Build

```bash
npm run build
npm run start
```

## License

Private project.
