# Infrastructure Conventions

- **Setup wizard**: `node setup.js` (CLI) + `/setup` web wizard. `data/.setup-complete` flag controls redirect.
- **Port auto-calculation**: `TTS_PORT` defaults to `PORT+1`, `GPU_MANAGER_PORT` defaults to `PORT+2`.
- **MCP authentication**: Internal token per server process → `.mcp.json` / `.codex/config.toml` env vars → `x-bridge-token` header.
- **MCP bootstrap**: Claude launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config`.
- **Permission sandboxing**: `.claude/settings.json` per session restricts Claude tools to session directory.
- **Admin authentication**: Optional via `ADMIN_PASSWORD`. HMAC-SHA256 tokens in httpOnly cookies (90-day). Rate-limited login (5/min per IP). MCP server bypasses via `x-bridge-token`.
- **Global singleton pattern**: `session-registry.ts` and `ws-server.ts` use `globalThis[key]` for HMR-safe state sharing.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps in cmd.exe.
- **GPU Manager**: Python child process auto-spawned by `server.ts`. Serial queue, health check (30s timeout), auto-restart (max 3, 10s backoff).
- **TTS dual provider**: Edge TTS (cloud, `tts-server.mjs`) + Local TTS (GPU Manager, Qwen3-TTS). Output saved as MP3 to session `audio/` dir. `audio:ready` WebSocket event notifies frontend.
- **SSE streaming**: `SSEManager` provides Server-Sent Events for real-time response streaming alongside WebSocket.

## Environment Variables

### Core

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3340` | Server port |
| `DATA_DIR` | `./data` | Data directory path |
| `ADMIN_PASSWORD` | (none) | Admin login password. If not set, authentication is disabled |
| `NODE_ENV` | `development` | Node environment |

### ComfyUI Integration

| Variable | Default | Purpose |
|----------|---------|---------|
| `COMFYUI_HOST` | `127.0.0.1` | ComfyUI host |
| `COMFYUI_PORT` | `8188` | ComfyUI port |
| `COMFYUI_DIR` | (none) | ComfyUI installation path |
| `COMFYUI_CHECKPOINT` | (none) | Default checkpoint model |
| `COMFYUI_AUTO_CLEAR_QUEUE` | `true` | Auto-clear queue before generation |
| `COMFYUI_AUTO_INTERRUPT_RUNNING` | `false` | Auto-interrupt running jobs |
| `COMFYUI_MAX_PENDING` | `4` | Max pending jobs in queue |

### Image Generation

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | (none) | Gemini image generation API key |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image-preview` | Gemini image model |
| `OPENAI_API_KEY` | (none) | OpenAI image generation API key |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1.5` | OpenAI image model |
| `CIVITAI_API_KEY` | (none) | CivitAI model download key |

### TTS & GPU

| Variable | Default | Purpose |
|----------|---------|---------|
| `TTS_ENABLED` | `true` | Enable/disable TTS globally |
| `TTS_PORT` | `PORT+1` | Edge TTS server port |
| `GPU_MANAGER_PORT` | `PORT+2` | GPU Manager port |
| `GPU_MANAGER_PYTHON` | `python` | Python executable for GPU Manager |

### MCP Server (internal, set automatically)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PLAY_API_BASE` | `http://127.0.0.1:{PORT}` | API base URL for MCP server |
| `CLAUDE_PLAY_AUTH_TOKEN` | (auto-generated) | MCP server auth token |
| `CLAUDE_PLAY_MODE` | (per-session) | MCP mode (session/builder) |
| `CLAUDE_PLAY_PERSONA` | (per-session) | MCP persona name |
| `CLAUDE_PLAY_SESSION_DIR` | (per-session) | MCP session directory path |
