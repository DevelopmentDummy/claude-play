# Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

## Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`. Also spawns TTS server and GPU Manager as child processes. Intercepts TTS and voice generation routes to handle them in plain Node context (outside Next.js runtime).

## GPU Manager (`gpu-manager/`)

Python FastAPI child process (port 3342) for serial GPU task queueing. Prevents VRAM conflicts between image generation and TTS by processing one GPU task at a time.

| File | Role |
|------|------|
| `server.py` | FastAPI app with `/health`, `/status`, `/comfyui/generate`, `/tts/synthesize`, `/tts/create-voice` endpoints |
| `queue_manager.py` | Serial asyncio queue — FIFO, one task at a time, per-type timeouts |
| `comfyui_proxy.py` | Proxies image generation requests to ComfyUI API |
| `tts_engine.py` | Qwen3-TTS direct inference — on-demand loading, 30s idle timeout, model size switching |
| `voice_creator.py` | Voice embedding (.pt) generator from design prompt or reference audio |

## Core Libraries (`src/lib/`)

### Session & State Management

| File | Role |
|------|------|
| `session-manager.ts` | Stateless file-based CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` + `.codex/config.toml` per session. Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md + GEMINI.md assembly. Bidirectional sync with diff comparison. |
| `session-instance.ts` | Per-session stateful container — holds active AI process, PanelEngine, chat history, broadcast functions. One instance per open session. |
| `session-registry.ts` | Registry for active `SessionInstance` objects. `getSessionInstance()`, `openSessionInstance()`, `closeSessionInstance()`. Cleanup with grace period on disconnect. |
| `services.ts` | Compatibility layer delegating to session-registry. Accumulates assistant turns from NDJSON stream events, extracts `<dialog_response>` and `<choice>` tags, detects image tool tokens (`$IMAGE:...$/`), manages chat history persistence. |

### AI Process Management

| File | Role |
|------|------|
| `ai-provider.ts` | `AIProvider` type (`"claude" \| "codex" \| "gemini"`), `providerFromModel()` mapping, `parseModelEffort()`, `MODEL_GROUPS` array with model option constants. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. |
| `gemini-process.ts` | Per-turn Gemini CLI spawner. Spawns fresh `gemini` CLI per message with `--resume` for session continuity. NDJSON streaming with delta support. Auto-fallback to fresh spawn if resume fails. |

### Communication

| File | Role |
|------|------|
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `session:bind`, `session:leave` messages. `wsBroadcast()` for global broadcasts. 5s grace period cleanup on last client disconnect. |
| `sse-manager.ts` | Server-Sent Events (SSE) broadcast manager for streaming responses. `addClient()`, `removeClient()`, `broadcast()`. |

### Image Generation

| File | Role |
|------|------|
| `comfyui-client.ts` | ComfyUI integration — image generation. Queues workflows, polls for results, downloads output images to session dir. Can route through GPU Manager when available. |
| `gemini-image.ts` | Gemini image generation via `generativelanguage.googleapis.com` API. Configurable model (`GEMINI_IMAGE_MODEL`). Supports multiple reference images and aspect ratio. |
| `openai-image.ts` | OpenAI image generation. Supports reference images (uses `/v1/images/edits`). Configurable model, size, quality parameters. |

### Panel System

| File | Role |
|------|------|
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files + `layout.json` via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML and layout updates via WebSocket. |
| `panel-image-polling.ts` | Auto-polls failed image loads via HEAD requests in Shadow DOM. `installImagePolling()`, `bustImageCache()` for deferred image generation retry. |
| `use-panel-bridge.ts` | React hook for panel-to-app communication. `usePanelBridge()` hook, `dispatchBridgeEvent()`, sendMessage/fillInput/updateVariables. |
| `hint-snapshot.ts` | Hint rule engine for variable display with formatting & tiering. `buildSnapshot()`, `readHintRules()`. Used by MCP `run_tool` responses. |

### TTS & Audio

| File | Role |
|------|------|
| `tts-handler.ts` | TTS request handler (runs in plain Node via server.ts). Routes to Edge TTS or GPU Manager for local TTS. Handles chat TTS and voice creation/testing. |
| `edge-tts-client.ts` | Edge TTS voice synthesis client via standalone TTS server. `generateEdgeTts()`, `EDGE_TTS_VOICES` array (Korean, English, Japanese, Chinese voices). |

### Authentication & Setup

| File | Role |
|------|------|
| `auth.ts` | Internal MCP token (`getInternalToken()`, `validateInternalToken()`). Admin auth (`createAuthToken()`, `verifyAuthToken()`, `parseCookieToken()`). |
| `setup-guard.ts` | Setup completion check. `isSetupComplete()`, `markSetupComplete()`, `shouldRedirectToSetup()`. |
| `setup-auth.ts` | Middleware checking auth before allowing access to protected routes. |

### Utilities

| File | Role |
|------|------|
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `env-file.ts` | `.env.local` file reader/writer with quote stripping & comment handling. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |
| `autoplay.ts` | Autoplay & Steering Preset management stored in localStorage. `SteeringPreset` interface, `loadPresets()`, `savePresets()`. |

## MCP Server

`src/mcp/claude-bridge-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude/Codex. Configured via `.mcp.json` (Claude) or `.codex/config.toml` (Codex) in the session directory. Authenticates to Bridge API via internal `x-bridge-token` header.

### MCP Tools (11)

| Tool | Purpose |
|------|---------|
| `bridge_status` | Server health and readiness status |
| `comfyui_models` | List available ComfyUI checkpoint models |
| `comfyui_generate` | Generate images via ComfyUI |
| `gemini_generate` | Generate images via Gemini API |
| `generate_image` | Smart router — picks best provider based on model |
| `generate_image_gemini` | Gemini-specific image generation wrapper |
| `generate_image_openai` | OpenAI-specific image generation wrapper |
| `update_profile` | Modify persona profile data |
| `policy_review` | Safety policy assessment with decision logging |
| `policy_context` | Get roleplay policy context (extreme traits, reviewed scenarios, intimacy policy) |
| `run_tool` | Execute custom tools with chain support and state snapshots |

### MCP Features

- Policy context system with configurable intimacy policies
- Snapshot system that reads `variables.json` + `hint-rules.json` and formats display/hints
- Tool chaining with sequential execution and early exit on failure
- Image deduplication within single turn (30s window)
- ComfyUI config reading (session-level → global fallback)
