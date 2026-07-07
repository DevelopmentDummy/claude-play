# Infrastructure Conventions

- **Setup wizard**: `node setup.js` (CLI) + `/setup` web wizard. `data/.setup-complete` flag controls redirect.
- **Port auto-calculation**: `TTS_PORT` defaults to `PORT+1`, `GPU_MANAGER_PORT` defaults to `PORT+2`.
- **MCP authentication**: Internal token per server process → `.mcp.json` (Claude via `--mcp-config`, Kimi via `--mcp-config-file`) / `.codex/config.toml` (via per-session `CODEX_HOME`) / `.gemini/settings.json` / `.agents/mcp_config.json` (Antigravity) env blocks → `x-bridge-token` header. All writers share `mcpServerEnv()` in `runtime-config.ts`.
- **MCP bootstrap**: Claude launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config`. Codex does **not** read a project/cwd `.codex/config.toml` — config (incl. `mcp_servers`) is loaded only from `$CODEX_HOME/config.toml` (codex-cli 0.124.0). `CodexProcess.spawn` therefore points `CODEX_HOME` at the session's own `.codex` dir (and copies `~/.codex/auth.json` in so account auth survives the repoint) so the per-session config written by `writeCodexConfig` — MCP server + `model_instructions_file` + cwd `trust_level` — actually takes effect. Gemini CLI is retired (`NEXT_PUBLIC_DISABLE_GEMINI=true` routes `gemini-*` model ids to the Antigravity provider); the `.gemini/settings.json` writer remains for legacy sessions. Antigravity reads the workspace-level `.agents/mcp_config.json` (written by `writeAntigravityMcpConfig`). Kimi reuses `.mcp.json` via `--mcp-config-file`.
- **Permission sandboxing**: `.claude/settings.json` per session restricts Claude tools to session directory.
- **Admin authentication**: Optional via `ADMIN_PASSWORD`. HMAC-SHA256 tokens in httpOnly cookies (90-day). Rate-limited login (5/min per IP). MCP server bypasses via `x-bridge-token`.
- **Global singleton pattern**: `session-registry.ts` and `ws-server.ts` use `globalThis[key]` for HMR-safe state sharing.
- **Windows lock retry**: `fs-retry.ts` exponential backoff handles EBUSY/EPERM/ENOTEMPTY when other processes hold a file (skill copy, sync, persona delete).
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps in cmd.exe.
- **GPU Manager**: Python child process auto-spawned by `server.ts`. Serial queue, health check (30s timeout), auto-restart (max 3; before each respawn the port holder is killed and the port polled free, up to 15s). Toggle via `GPU_MANAGER_ENABLED`.
- **ComfyUI auto-spawn** (opt-in): When `COMFYUI_AUTOSTART=true` and `COMFYUI_DIR` is set, `server.ts` spawns ComfyUI as a child process using the venv at `<COMFYUI_DIR>/venv` (or `COMFYUI_PYTHON` if overridden). If `COMFYUI_PORT` (default 8188) already has a LISTENING process, spawn is skipped — the running instance is reused. Health-check via `/system_stats` (60s timeout). Killed with the parent on shutdown.
- **TTS dual provider**: Edge TTS (cloud, `tts-server.mjs`) + Local TTS (GPU Manager, Qwen3-TTS). Output saved as MP3 to session `audio/` dir. `audio:ready` WebSocket event notifies frontend.
- **SSE streaming**: `SSEManager` provides Server-Sent Events for real-time response streaming alongside WebSocket.
- **Restart orchestrator**: `POST /api/service/restart` runs the build + restart in a detached background process (`scripts/restart.mjs`, also runnable directly via `node scripts/restart.mjs` — no HTTP auth needed). Logs go to `data/`: `restart.log` (orchestrator progress), `restart-build.log`, `restart-newserver.log`, plus `restart-orchestrator.log` (detached-spawn stdio, written by the API route). Active sessions are restored via `restart-notification.ts` markers on the new process.
- **External LLM gateway** (Codex only): If a model id is `external/...`, `codex-process.ts` injects `model_provider="external"` per-spawn using `CODEX_EXTERNAL_BASE_URL` / `CODEX_EXTERNAL_API_KEY`. Global `~/.codex/config.toml` is not modified. See `docs/external-llm-routing.md`.
- **Runtime PID registries**: `data/.runtime/` (gitignored) holds disk-persisted PID registries for detached child processes. `agy-procs.json` (`antigravity-pid-registry.ts`) tracks detached agy.exe spawns — they survive dev-server restarts holding the session dir (EBUSY on delete), so the session/persona delete routes reap them. `subagent-procs.json` (`subagent-registry.ts`) tracks persona subagents; orphans are reaped at server boot (`reapOrphanSubProcs()` in `server.ts`).
- **Codex image backend** (`OPENAI_IMAGE_BACKEND=codex`, default): `codex-image.ts` drives `codex exec` in an empty temp cwd (avoids AGENTS.md pickup; keeps reference-image paths space-free), prompt via stdin, edits via `-i <reference>`, and deletes `OPENAI_API_KEY` from the child env so rendering always uses the ChatGPT subscription (no per-call cost). Output is harvested as the newest `ig_*.png` under `$CODEX_HOME/generated_images/` via mtime snapshot-diff — concurrent generations can misattribute images (accepted for single-user). Slow (a full Codex agent turn per image) and counts against the ChatGPT plan's rate limits.
- **Production build is webpack-only**: `next build --turbopack` (Next 15.5) output cannot boot under the custom `server.ts` — `.next/BUILD_ID` is empty and `required-server-files.json` / `next-server.js.nft.json` are not generated. Stay on webpack; when retrying Turbopack, first verify BUILD_ID is non-empty and `required-server-files.json` exists.

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
| `OPENAI_IMAGE_MODEL` | `gpt-5.5` | **Orchestration** model — the Responses reasoning model that drives the `image_generation` tool (only used when `OPENAI_IMAGE_BACKEND=api`). NOT an image model: a `gpt-image-*` id here would 400 the Responses call; `openai-image.ts` self-corrects by treating it as the renderer and falling back to `gpt-5.5` |
| `OPENAI_IMAGE_TOOL_MODEL` | `gpt-image-2` | **Renderer** model the `image_generation` tool actually uses (api backend only). Pinned to avoid auto-selection of models the account lacks access to |
| `CIVITAI_API_KEY` | (none) | CivitAI model download key |

### TTS & GPU

| Variable | Default | Purpose |
|----------|---------|---------|
| `TTS_ENABLED` | `true` | Enable/disable TTS globally (skip TTS server spawn) |
| `TTS_PORT` | `PORT+1` | Edge TTS server port |
| `GPU_MANAGER_ENABLED` | `true` | Enable/disable GPU Manager spawn |
| `GPU_MANAGER_PORT` | `PORT+2` | GPU Manager port |
| `GPU_MANAGER_PYTHON` | `python` | Python executable for GPU Manager |
| `TTS_MODEL_PATH` | (auto) | Local model path override for the GPU Manager Qwen3-TTS engine (read by `gpu-manager/server.py`) |
| `VOXCPM_MODEL_PATH` | (auto) | Local model path override for the GPU Manager VoxCPM engine (read by `gpu-manager/server.py`) |

### Provider Routing & Background AI

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_DISABLE_GEMINI` | `true` (in `.env.example`) | When `true`, Gemini CLI is retired: the model picker hides the Gemini group and `gemini-*` model ids route to the Antigravity provider. Does NOT affect Gemini image generation (`GEMINI_API_KEY`) |
| `ANTIGRAVITY_IDLE_WATCH` | (enabled) | Set `false` to disable the post-turn idle-watch polling that live-emits delayed async-tool responses in Antigravity sessions (`antigravity-process.ts`) |
| `FIRE_AI_TIMEOUT_MS` | `600000` | Kill timeout (ms) for a background `fire_ai` turn — persistent provider processes don't self-exit on a hung turn (`background-session.ts`) |
| `FIRE_AI_AUTORESUME_MAX` | `5` | Runaway guard: cap on consecutive `fire_ai` autoResume spontaneous-turn chains without user input (`session-instance.ts`) |
| `SUBAGENT_MAX` | `6` | Max persona subagents per session (`subagent-manifest.ts`) |
| `CLAUDE_CODE_WORKFLOWS` | (set internally) | Set to `1` on spawned Claude processes when the `:ultracode` pseudo-effort is selected — gates the multi-agent Workflow tool (`claude-process.ts` / `resolveClaudeEffort()`) |

### Codex External Gateway (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEX_EXTERNAL_BASE_URL` | (none) | Base URL for Responses-API-compatible external gateway |
| `CODEX_EXTERNAL_API_KEY` | (none) | API key value for the external gateway |
| `CODEX_EXTERNAL_ENV_KEY` | (none) | Override the env-var name Codex reads for the key (when the gateway expects a non-default name) |

Optional upstream provider keys, passed through to a custom gateway/router only if it reads them from env: `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `QWEN_API_KEY`, `ZAI_API_KEY` (see `.env.example`).

### MCP Server (internal, set automatically)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PLAY_API_BASE` | `http://127.0.0.1:{PORT}` | API base URL for MCP server |
| `CLAUDE_PLAY_AUTH_TOKEN` | (auto-generated) | MCP server auth token |
| `CLAUDE_PLAY_MODE` | (per-session) | MCP mode (`session` / `builder`) |
| `CLAUDE_PLAY_PERSONA` | (per-session) | MCP persona name |
| `CLAUDE_PLAY_SESSION_DIR` | (per-session) | MCP session directory path |
