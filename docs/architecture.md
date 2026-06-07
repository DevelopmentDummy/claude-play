# Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

## Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`. Spawns the standalone TTS server (`tts-server.mjs`) and the GPU Manager (Python child process) on startup, with health-check + auto-restart. Intercepts TTS / voice generation routes so they execute in plain Node context outside the Next.js runtime.

## GPU Manager (`gpu-manager/`)

Python FastAPI child process (port 3342 by default) for serial GPU task queueing. Prevents VRAM conflicts between image generation and local TTS by processing one GPU task at a time.

| File | Role |
|------|------|
| `server.py` | FastAPI app with `/health`, `/status`, `/comfyui/generate`, `/tts/synthesize`, `/tts/create-voice` endpoints |
| `queue_manager.py` | Serial asyncio queue — FIFO, one task at a time, per-type timeouts |
| `comfyui_proxy.py` | Proxies image generation requests to ComfyUI API |
| `tts_engine.py` | Qwen3-TTS direct inference — on-demand loading, idle timeout, model size switching |
| `voice_creator.py` | Voice embedding (.pt) generator from design prompt or reference audio |

## Core Libraries (`src/lib/`)

### Session & State Management

| File | Role |
|------|------|
| `session-manager.ts` | Stateless file-based CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` + `.codex/config.toml` + `.gemini/` + `.kimi/` configs per session. Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md + GEMINI.md assembly. Bidirectional sync with diff comparison. |
| `session-instance.ts` | Per-session stateful container — holds active AI process, PanelEngine, chat history, broadcast functions. One instance per open session. Drives panel-action hooks, OOC routing, scene-break parsing, fire-ai dispatch, and system event flushing (events/actions/hint snapshots) before each turn. |
| `session-registry.ts` | Registry for active `SessionInstance` objects. `getSessionInstance()`, `openSessionInstance()`, `closeSessionInstance()`. Cleanup with grace period on disconnect. |
| `session-list.ts` | Provider-side conversation enumeration (Claude / Codex / Gemini / Kimi) for the resume menu. JSONL tail parsing for last-message previews. `listConversationsForSession()`, `relinkConversation()`. |
| `services.ts` | Compatibility layer — re-exports `SessionManager` and the registry helpers (`getSessionInstance`, `openSessionInstance`, etc). Most call sites should use `getServices()` to grab the global singleton. |
| `background-session.ts` | Spawns detached Claude subprocesses (`spawnBackgroundClaude()`) for long-running side jobs invoked from hooks or the `fire_ai` MCP tool. Optional minimal vs full persona-context system prompt. |
| `pipeline-scheduler.ts` | Per-session polling loop that periodically invokes a custom `pipeline_tick()` tool, then dispatches resulting notifications. `start/stop/getPipelineSchedulerState()`. |
| `restart-notification.ts` | After a service restart, reconciles active sessions: writes a marker, atomically renames it on consumption, and feeds a silent system message back to the AI so the conversation continues from where it stopped. |
| `ai-process-factory.ts` | Factory helper that constructs the correct provider process (ClaudeProcess / CodexProcess / etc.) given a model id and options. Used by both main session and sub-agent spawn paths. |
| `subagent-manifest.ts` | Reads and validates `subagents.json` — manifest schema types, `loadSubAgentManifest()`, cap enforcement (`SUBAGENT_MAX`). |
| `subagent-instance.ts` | Per-sub stateful wrapper over a provider process (Claude-only in v1). No PanelEngine. Emits messages to `SubAgentManager`; persists `.resume` id for session continuity. |
| `subagent-manager.ts` | `SubAgentManager` — owns all `SubAgentInstance` objects for a session. `spawnAll()` on session open, `dispatch(name, task)` for all three dispatch paths, `destroyAll()` on session destroy. |
| `subagent-registry.ts` | PID registry for sub-agent processes (`data/.runtime/subagent-procs.json`). `reapOrphanSubProcs()` called on server boot to kill survivors, with recycling-safe session-dir verification. |

### AI Process Management

| File | Role |
|------|------|
| `ai-provider.ts` | `AIProvider` type (`"claude" \| "codex" \| "gemini" \| "kimi"`), `providerFromModel()` mapping, `parseModelEffort()`, `MODEL_GROUPS` array with model option constants. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. Optional external-gateway provider injection via `model_provider` for `external/...` models. |
| `gemini-process.ts` | Per-turn Gemini CLI spawner. Spawns fresh `gemini` CLI per message with `--resume` for session continuity. NDJSON streaming with delta support. Auto-fallback to fresh spawn if resume fails. |
| `kimi-process.ts` | Kimi CLI integration via the Kimi `--wire` JSON-RPC protocol. Persistent process with init handshake, message send, stream-delta handling, auto-approval of ApprovalRequest events. Same EventEmitter shape as the others. |

### Communication

| File | Role |
|------|------|
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `session:bind`, `session:leave` messages. `wsBroadcast()` for global broadcasts. 5s grace period cleanup on last client disconnect. |
| `sse-manager.ts` | Server-Sent Events broadcast manager for streaming responses. `addClient()`, `removeClient()`, `broadcast()`. |

### Image Generation

| File | Role |
|------|------|
| `comfyui-client.ts` | ComfyUI integration — image generation. Queues workflows, polls for results, downloads output images to session dir. Routes through GPU Manager when available. |
| `workflow-resolver.ts` | ComfyUI workflow package management. Loads packages, validates `ParamDef` defs, merges prefix/suffix, supports custom `resolver.mjs` plugins. `loadPackage()`, `listPackages()`, `resolveWorkflow()`, `validateParams()`. |
| `gemini-image.ts` | Gemini image generation via `generativelanguage.googleapis.com` API. Configurable model (`GEMINI_IMAGE_MODEL`). Supports multiple reference images and aspect ratio. |
| `openai-image.ts` | OpenAI image generation. Supports reference images (uses `/v1/images/edits`). Configurable model, size, quality parameters. |

### Panel System

| File | Role |
|------|------|
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files + `layout.json` via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML and layout updates via WebSocket. |
| `panel-image-polling.ts` | Auto-polls failed image loads via HEAD requests in Shadow DOM. `installImagePolling()`, `bustImageCache()` for deferred image generation retry. |
| `panel-action-registry.ts` | Client-side singleton that tracks panel action specs/handlers, evaluates `available_when`, builds the `[AVAILABLE]` header, executes/records actions, and surfaces `[정의]` reminders when an action shape is wrong. `getPanelActionRegistry()`. |
| `panel-actions-meta.ts` | Server-side reader for `panels/_actions.meta.json`. `readPanelActionsMeta()`, `formatSpecAsLine()`, `formatPanelActionsAsMarkdown()` — emits the action-spec markdown injected into the system prompt at session open. |
| `use-panel-bridge.ts` | React hook for panel-to-app communication. `usePanelBridge()` hook, `dispatchBridgeEvent()`, sendMessage/fillInput/updateVariables. |
| `hint-snapshot.ts` | Hint rule engine for variable display with formatting & tiering. `buildSnapshot()`, `readHintRules()`. Used by MCP `run_tool` responses. |

### TTS & Audio

| File | Role |
|------|------|
| `tts-handler.ts` | TTS request handler (runs in plain Node via server.ts). Routes to Edge TTS or GPU Manager for local TTS. Handles chat TTS and voice creation/testing. |
| `edge-tts-client.ts` | Edge TTS voice synthesis client via standalone TTS server. `generateEdgeTts()`, `EDGE_TTS_VOICES` array (Korean, English, Japanese, Chinese voices). |

### Authentication, Setup & Service Control

| File | Role |
|------|------|
| `auth.ts` | Internal MCP token (`getInternalToken()`, `validateInternalToken()`). Admin auth (`createAuthToken()`, `verifyAuthToken()`, `parseCookieToken()`). |
| `setup-guard.ts` | Setup completion check. `isSetupComplete()`, `markSetupComplete()`, `shouldRedirectToSetup()`. |
| `setup-auth.ts` | Middleware checking auth before allowing access to protected routes. |
| `usage-checker.ts` | Polls Claude / Codex / Gemini usage APIs (per-window utilization, `resets_at`, `timeProgress`) with a 30s in-memory cache. `getClaudeUsage()`, `getCodexUsage()`, `getGeminiUsage()`. |

### Utilities

| File | Role |
|------|------|
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `env-file.ts` | `.env.local` file reader/writer with quote stripping & comment handling. |
| `fs-retry.ts` | `retryOnWindowsLock<T>()` — exponential backoff for EBUSY/EPERM/ENOTEMPTY errors caused by other Windows processes holding a file. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |
| `autoplay.ts` | Autoplay & Steering Preset management stored in localStorage. `SteeringPreset` interface, `loadPresets()`, `savePresets()`. |

## MCP Server

`src/mcp/claude-play-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude / Codex / Gemini / Kimi. Configured via `.mcp.json` (Claude), `.codex/config.toml` (Codex), `.gemini/` settings (Gemini), or `.kimi/` settings (Kimi) inside the session directory. Authenticates to the Bridge API via the internal `x-bridge-token` header. Helper `withPersona()` injects the active persona / session id into every outgoing request.

### MCP Tools

| Tool | Purpose |
|------|---------|
| `bridge_status` | MCP runtime config (API base, mode, persona, session dir) |
| `bridge_service_status` | Service-wide status — active sessions, WS clients, schedulers |
| `bridge_scheduler_inspect` | Inspect pipeline-scheduler state for a session |
| `bridge_scheduler_stop` | Stop the pipeline scheduler for a session |
| `bridge_scheduler_restart` | Restart the pipeline scheduler for a session |
| `bridge_restart_service` | Rebuild & restart the Claude Play service (optional flag) |
| `comfyui_health` | ComfyUI + GPU Manager connectivity & system stats |
| `comfyui_paths` | ComfyUI install dir + model subdirs (checkpoints, LoRA, …) |
| `comfyui_models` | List ComfyUI checkpoints / models |
| `comfyui_workflow` | Workflow package CRUD (list / get / save / delete) |
| `comfyui_generate` | Queue a ComfyUI generation (workflow or raw mode) |
| `gemini_generate` | Direct Gemini image API call (legacy wrapper) |
| `generate_image` | High-level template-mode image generation (auto-picks ComfyUI defaults / trigger tags) |
| `generate_image_gemini` | High-level Gemini image generation |
| `generate_image_openai` | High-level OpenAI image generation (`gpt-image-2`) |
| `update_profile` | Replace persona profile image and auto-crop a 256×256 icon |
| `policy_review` | Local content-policy review (allow / deny / uncertain) with decision logging |
| `policy_context` | Read roleplay policy context (extreme traits, reviewed scenarios, intimacy policy) |
| `run_tool` | Execute custom session tools — single or chained, with state snapshot |
| `fire_ai` | Spawn a detached background AI run (long-form generation, side jobs). Exit-time hooks: `notify` (silent system event), `onExit.broadcast` (WS to caller session's clients — UI updates without AI turn), `onExit.script` (JS module inside session dir for dynamic broadcast/queueEvent). |
| `bridge_delegate` | (세션 모드) 메인 AI가 상시 서브에이전트에게 태스크를 위임. `{ to: name, task: string }` → `SubAgentManager.dispatch()`. |
| `report_to_main` | (서브에이전트 전용) 서브가 결과를 메인 세션 이벤트 큐에 보고. `{ from: name, summary: string }` → `pending-events.json` 큐잉 → 다음 사용자 턴에 flush. |
| `bridge_define_subagent` | (빌더 모드 전용) 서브에이전트 정의 생성/갱신. `{ name, role, model?, instructions, delegable?, autoTrigger?, autoTriggerTask?, emitSummary? }` → 페르소나 디렉토리에 `subagents.json` + `subagents/{name}/instructions.md` 기록. |

### MCP Features

- Policy context system with configurable intimacy policies and traits
- Snapshot system that reads `variables.json` + `hint-rules.json` and formats display/hints
- Tool chaining with sequential execution and early exit on failure
- Image deduplication within single turn (30s window) via `deduplicateImageFilename()`
- ComfyUI config reading (session-level → global fallback)
- Background `fire_ai` jobs run independently of the main turn, broadcasting completion notifications. Per-call `onExit` lets the caller pick UI-only (`broadcast`), dynamic-callback (`script`), and/or AI-resuming (`notify`) behaviour — independent flags
