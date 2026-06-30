# Infrastructure Conventions

- **Setup wizard**: `node setup.js` (CLI) + `/setup` web wizard. `data/.setup-complete` flag controls redirect.
- **Port auto-calculation**: `TTS_PORT` defaults to `PORT+1`, `GPU_MANAGER_PORT` defaults to `PORT+2`.
- **MCP authentication**: Internal token per server process → `.mcp.json` / `.codex/config.toml` / `.gemini/` / `.kimi/` env vars → `x-bridge-token` header.
- **MCP bootstrap**: Claude launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config`. Codex auto-loads `.codex/config.toml` from cwd. Gemini and Kimi receive their own per-runtime config dirs.
- **Permission sandboxing**: `.claude/settings.json` per session restricts Claude tools to session directory.
- **Admin authentication**: Optional via `ADMIN_PASSWORD`. HMAC-SHA256 tokens in httpOnly cookies (90-day). Rate-limited login (5/min per IP). MCP server bypasses via `x-bridge-token`.
- **Global singleton pattern**: `session-registry.ts` and `ws-server.ts` use `globalThis[key]` for HMR-safe state sharing.
- **Windows lock retry**: `fs-retry.ts` exponential backoff handles EBUSY/EPERM/ENOTEMPTY when other processes hold a file (skill copy, sync, persona delete).
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps in cmd.exe.
- **GPU Manager**: Python child process auto-spawned by `server.ts`. Serial queue, health check (30s timeout), auto-restart (max 3, 10s backoff). Toggle via `GPU_MANAGER_ENABLED`.
- **ComfyUI auto-spawn** (opt-in): When `COMFYUI_AUTOSTART=true` and `COMFYUI_DIR` is set, `server.ts` spawns ComfyUI as a child process using the venv at `<COMFYUI_DIR>/venv` (or `COMFYUI_PYTHON` if overridden). If `COMFYUI_PORT` (default 8188) already has a LISTENING process, spawn is skipped — the running instance is reused. Health-check via `/system_stats` (60s timeout). Killed with the parent on shutdown.
- **TTS dual provider**: Edge TTS (cloud, `tts-server.mjs`) + Local TTS (GPU Manager, Qwen3-TTS). Output saved as MP3 to session `audio/` dir. `audio:ready` WebSocket event notifies frontend.
- **SSE streaming**: `SSEManager` provides Server-Sent Events for real-time response streaming alongside WebSocket.
- **Restart orchestrator**: `POST /api/service/restart` runs the build + restart in a detached background process (`restart-build.log`, `restart-newserver.log`, `restart-orchestrator.log`). Active sessions are restored via `restart-notification.ts` markers on the new process.
- **External LLM gateway** (Codex only): If a model id is `external/...`, `codex-process.ts` injects `model_provider="external"` per-spawn using `CODEX_EXTERNAL_BASE_URL` / `CODEX_EXTERNAL_API_KEY`. Global `~/.codex/config.toml` is not modified. See `docs/external-llm-routing.md`.

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
| `COMFYUI_AUTOSTART` | `false` | If `true` and `COMFYUI_DIR` is set, spawn ComfyUI as a child process on server start. Skipped if the port is already in use |
| `COMFYUI_PYTHON` | (auto) | Override Python interpreter for ComfyUI. Default: `<COMFYUI_DIR>/venv/Scripts/python.exe` (Windows) or `venv/bin/python` (POSIX) |
| `COMFYUI_CHECKPOINT` | (none) | Default checkpoint model |
| `COMFYUI_AUTO_CLEAR_QUEUE` | `true` | Auto-clear queue before generation |
| `COMFYUI_AUTO_INTERRUPT_RUNNING` | `false` | Auto-interrupt running jobs |
| `COMFYUI_MAX_PENDING` | `4` | Max pending jobs in queue |

### Image Generation

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | (none) | Gemini image generation API key |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image-preview` | Gemini image model |
| `OPENAI_IMAGE_BACKEND` | `codex` | OpenAI/GPT image backend: `codex` (Codex CLI built-in `image_gen`, ChatGPT-subscription-covered, no per-call cost) or `api` (metered OpenAI Responses API) |
| `OPENAI_API_KEY` | (none) | OpenAI API key — required only when `OPENAI_IMAGE_BACKEND=api` |
| `OPENAI_IMAGE_MODEL` | `gpt-5.5` | OpenAI Responses model driving the `image_generation` tool (only used when `OPENAI_IMAGE_BACKEND=api`) |
| `CIVITAI_API_KEY` | (none) | CivitAI model download key |

### TTS & GPU

| Variable | Default | Purpose |
|----------|---------|---------|
| `TTS_ENABLED` | `true` | Enable/disable TTS globally (skip TTS server spawn) |
| `TTS_PORT` | `PORT+1` | Edge TTS server port |
| `GPU_MANAGER_ENABLED` | `true` | Enable/disable GPU Manager spawn |
| `GPU_MANAGER_PORT` | `PORT+2` | GPU Manager port |
| `GPU_MANAGER_PYTHON` | `python` | Python executable for GPU Manager |

### Codex External Gateway (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEX_EXTERNAL_BASE_URL` | (none) | Base URL for Responses-API-compatible external gateway |
| `CODEX_EXTERNAL_API_KEY` | (none) | API key value for the external gateway |
| `CODEX_EXTERNAL_ENV_KEY` | (none) | Override the env-var name Codex reads for the key (when the gateway expects a non-default name) |

### MCP Server (internal, set automatically)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PLAY_API_BASE` | `http://127.0.0.1:{PORT}` | API base URL for MCP server |
| `CLAUDE_PLAY_AUTH_TOKEN` | (auto-generated) | MCP server auth token |
| `CLAUDE_PLAY_MODE` | (per-session) | MCP mode (`session` / `builder`) |
| `CLAUDE_PLAY_PERSONA` | (per-session) | MCP persona name |
| `CLAUDE_PLAY_SESSION_DIR` | (per-session) | MCP session directory path |
