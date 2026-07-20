# Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

## Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`. Spawns the standalone TTS server (`tts-server.mjs`) and the GPU Manager (Python child process) on startup, with health-check + auto-restart. Intercepts TTS / voice generation routes so they execute in plain Node context outside the Next.js runtime. TTS is a fully independent HTTP server *by necessity*: `node-edge-tts` depends on the `ws` package and the Next.js runtime interferes with it — both in-process use and a child spawned under the Next runtime failed, so do not fold TTS back into the Next process. Also opt-in auto-spawns ComfyUI itself (`COMFYUI_AUTOSTART=true` + `COMFYUI_DIR`, skipped when the port is already in use) and calls `reapOrphanSubProcs()` on boot to kill orphaned sub-agent processes.

## GPU Manager (`gpu-manager/`)

Python FastAPI child process (port 3342 by default) for serial GPU task queueing. Prevents VRAM conflicts between image generation and local TTS by processing one GPU task at a time.

| File | Role |
|------|------|
| `server.py` | FastAPI app with `/health`, `/status`, `/comfyui/generate`, `/tts/synthesize`, `/tts/synthesize-stream`, `/tts/create-voice` endpoints |
| `queue_manager.py` | Serial asyncio queue — FIFO, one task at a time, per-type timeouts |
| `comfyui_proxy.py` | Proxies image generation requests to ComfyUI API |
| `tts_engine.py` | Qwen3-TTS direct inference — on-demand loading, idle timeout, model size switching |
| `voxcpm_engine.py` | VoxCPM2 TTS inference — second local TTS engine, on-demand loading, persistent torch.compile cache (deps in `requirements-voxcpm.txt`) |
| `voice_creator.py` | Voice embedding (.pt) generator from design prompt or reference audio |

## Core Libraries (`src/lib/`)

### Session & State Management

| File | Role |
|------|------|
| `session-manager.ts` | Stateless file-based CRUD for personas, sessions, profiles. Copies persona → session directory. Delegates per-runtime config emission to `runtime-config.ts` (`.claude/settings.json`, `.mcp.json` — also consumed by Kimi, `.codex/config.toml`, `.gemini/` settings, `.agents/mcp_config.json`). Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md + GEMINI.md assembly. Bidirectional sync with diff comparison. Several concerns are extracted to the Wave-12 split modules below. |
| `runtime-config.ts` | Per-runtime config file emitter (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `.agents/mcp_config.json` for Antigravity, policy-context.json). `ensureClaudeRuntimeConfig()` rewrites all of them on every session open. |
| `runtime-instructions.ts` | Per-runtime instruction file writer (AGENTS.md / GEMINI.md etc.) sourced from the session's authoritative CLAUDE.md. |
| `prompt-assembly.ts` | Service/builder system prompt + guide-file assembly (per-provider primer YAML + shared markdown, Handlebars-compiled). `getBuilderPrompt()` injects `validModels` (from `ai-provider.ts` `listBaseModelIds()`) so `builder-prompt.md` renders the sub-agent model catalog from the picker instead of a hand-kept list. |
| `session-config-io.ts` | Dir-scoped session/persona config I/O (layout / voice / chat options) with defaults. |
| `session-state.ts` | `SYSTEM_JSON` SSOT (system JSON files that are not persona data) + atomic `session.json` mutation (`mutateSessionJsonSync`) with Windows-lock retry. |
| `session-sync-diff.ts` | Read-only persona↔session sync/diff predicates (`fileDiffers()` etc.). |
| `soft-delete.ts` | Shared soft-delete flow for sessions and builder personas: close live instance → `killAgyForDir()` orphan reap → rename into `data/deleted_*` with Windows-lock retry. |
| `fs-mirror.ts` | Generic recursive dir copy / additive mirror utilities; skips transient `background-*.log` runtime artifacts. |
| `session-instance.ts` | Per-session stateful container — holds active AI process, PanelEngine, chat history, broadcast functions. One instance per open session. Drives panel-action hooks, OOC routing, fire-ai dispatch, autoResume spontaneous turns, and system event flushing (events/actions/hint snapshots) before each turn. (Scene-break parsing is client-side — `ChatMessages.tsx`.) |
| `session-registry.ts` | Registry for active `SessionInstance` objects. `getSessionInstance()`, `openSessionInstance()`, `closeSessionInstance()`. Cleanup with grace period on disconnect. |
| `session-list.ts` | Provider-side conversation enumeration (Claude / Codex / Gemini / Kimi) for the resume menu. JSONL tail parsing for last-message previews. `listConversationsForSession()`, `relinkConversation()`. |
| `services.ts` | Compatibility layer — re-exports `SessionManager` and the registry helpers (`getSessionInstance`, `openSessionInstance`, etc). Most call sites should use `getServices()` to grab the global singleton. |
| `background-session.ts` | Spawns background AI turns (`spawnBackgroundAI()`) for long-running side jobs invoked from hooks or the `fire_ai` MCP tool. Provider derived from `model` (default Claude) via `createProcess()`; runs one turn then settles on `{type:"result"}`. Optional minimal vs full persona-context system prompt; safety timeout via `FIRE_AI_TIMEOUT_MS`. |
| `pipeline-scheduler.ts` | Per-session polling loop that periodically invokes a custom `pipeline_tick()` tool, then dispatches resulting notifications. `start/stop/getPipelineSchedulerState()`. |
| `restart-notification.ts` | After a service restart, reconciles active sessions: writes a marker, atomically renames it on consumption, and feeds a silent system message back to the AI so the conversation continues from where it stopped. |
| `ai-process-factory.ts` | Factory helper that constructs the correct provider process (ClaudeProcess / CodexProcess / etc.) given a model id and options. Used by both main session and sub-agent spawn paths. |
| `subagent-manifest.ts` | Reads and validates `subagents.json` — manifest schema types, `loadSubAgentManifest()`, cap enforcement (`SUBAGENT_MAX`). |
| `subagent-instance.ts` | Per-sub stateful wrapper over any provider process (follows the session's provider/model by default; a per-sub `model` in the manifest pins a fixed provider). No PanelEngine. Emits messages to `SubAgentManager`; persists a provider-namespaced `.resume-<provider>` id for continuity. |
| `subagent-manager.ts` | `SubAgentManager` — owns all `SubAgentInstance` objects for a session. `spawnAll()` on session open, `dispatch(name, task)` for all three dispatch paths, `destroyAll()` on session destroy. |
| `subagent-registry.ts` | PID registry for sub-agent processes (`data/.runtime/subagent-procs.json`). `reapOrphanSubProcs()` called on server boot to kill survivors, with recycling-safe session-dir verification. |
| `subagent-transcript.ts` | Per-sub `transcript.jsonl` reader/appender (dispatch/response/report entries) feeding the `subagent:message` WS side-channel and the messenger-style sub-agent modal UI. |

### AI Process Management

| File | Role |
|------|------|
| `ai-provider.ts` | `AIProvider` type (`"claude" \| "codex" \| "gemini" \| "kimi" \| "antigravity"`), `providerFromModel()` mapping (gemini-* ids transparently route to the Antigravity provider when `NEXT_PUBLIC_DISABLE_GEMINI=true` — the current default), `parseModelEffort()`, `resolveClaudeEffort()`, `MODEL_GROUPS` array with model option constants. `ultracode` is a pseudo-effort, not a real `--effort` value: `resolveClaudeEffort()` translates it to `--effort xhigh` + the `CLAUDE_CODE_WORKFLOWS` env var (which gates the multi-agent Workflow tool, verified in the claude binary) + a standing system-prompt append. Model-string grammar is `<model>[:<effort>][@<advisor>]` — `parseModelEffort()` splits the optional `@advisor` suffix off first (so it can't contaminate the effort slot) and returns `{ model, effort, advisor }`; `resolveBuilderModel()` round-trips `@advisor` in `combined`. The `@advisor` presets (Claude-only, e.g. `opus:ultracode@fable`) select the model backing Claude Code's `advisor` tool per-session. `listBaseModelIds()` derives a deduped, effort/advisor-stripped id catalog from `MODEL_GROUPS` (honouring the `GEMINI_DISABLED` branch) so prose that must *describe* the valid ids never hand-maintains a second copy — `prompt-assembly.ts` injects it into the builder meta-prompt as `{{validModels}}`. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume (advisor is preserved on retry). `spawn()` takes a trailing optional `advisor?` — when set, passes `--advisor <model>` to configure the advisor tool's backing model for the session. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. Optional external-gateway provider injection via `model_provider` for `external/...` models. Spawns with child env `CODEX_HOME` pointed at the session's `.codex/` dir (copying `auth.json` in) — codex reads config **only** from `$CODEX_HOME/config.toml`, never the cwd `.codex/config.toml`. |
| `gemini-process.ts` | **Vestigial/retired** — Google stopped processing Gemini CLI requests 2026-06-18; kept only for the legacy `NEXT_PUBLIC_DISABLE_GEMINI=false` mode. gemini-* model ids now route to `antigravity-process.ts`. (Was: per-turn `gemini --resume` spawner with fresh-spawn fallback.) |
| `kimi-process.ts` | Kimi CLI integration via the Kimi `--wire` JSON-RPC protocol. Persistent process with init handshake, message send, stream-delta handling, auto-approval of ApprovalRequest events. Same EventEmitter shape as the others. |
| `antigravity-process.ts` | Antigravity (`agy.exe`) provider — the de-facto Gemini replacement. Persistent detached agy process plus a polling wrapper over its in-process Language Server (not a persistent stream). Same EventEmitter shape as the others. Details below. |
| `antigravity-pid-registry.ts` | Persists detached agy.exe PIDs to `data/.runtime/agy-procs.json` (`recordAgyPid()`); `killAgyForDir()` reaps orphans on session/persona delete — detached agy survives dev-server restarts and otherwise blocks the directory rename with EBUSY. |

#### Antigravity runtime notes

- **Spawn — PowerShell `Start-Process` only.** `agy.exe` is a Go bubbletea TUI that needs real Windows console handles (CONIN$/CONOUT$). Every Node `child_process.spawn` combination (detached / windowsHide) fails with `bubbletea: could not open TTY` while exiting code 0 (looks like success). Only `Start-Process -WindowStyle Hidden` via a generated `.ps1` provides a hidden-but-allocated console. Never unify this spawn path with the four pipe-based providers. Non-ASCII cwd needs both a UTF-8 BOM on the `.ps1` and `Set-Location -LiteralPath` (not `Start-Process -WorkingDirectory`, which does wildcard interpretation).
- **Transport — LS polling, not streaming.** agy hosts an in-process Language Server (ConnectRPC over HTTPS at `/exa.language_server_pb.LanguageServerService/*`, random port discovered from the agy PID). agy auto-creates a cascade from `--prompt-interactive`; the bridge finds it via `GetAllCascadeTrajectories`, sends input with `SendUserCascadeMessage` (`items: [{ text }]`), polls output with `GetCascadeTrajectory` (~700ms), and detects turn end with `WaitForConversationFullyIdle` + a heuristic fallback. Wake-up echoes from async tools are removed by `stripSystemMessageEcho`.
- **Model keys are dynamic — never hardcode.** agy model ids are `MODEL_PLACEHOLDER_M{N}` strings whose index changes between agy versions (Pro High: 165 in 1.0.2 → 37 in 1.0.5; hardcoding killed cascades with "unknown model key"). `resolveModelKeyDynamic()` re-resolves at every spawn by matching `displayName` from `GetAvailableModels` and passes the full string verbatim.
- **Debugging**: per-session log `antigravity-stream.log` (spawn failures show up as `agy stdout:` lines).

### Communication

| File | Role |
|------|------|
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `chat:cancel`, `event:queue`, `command:send`, `session:bind`, `session:leave` messages. `wsBroadcast()` for global broadcasts. 5s grace period cleanup on last client disconnect. |
| `sse-manager.ts` | Server-Sent Events broadcast manager for streaming responses. `addClient()`, `removeClient()`, `broadcast()`. |

### Image Generation

| File | Role |
|------|------|
| `comfyui-client.ts` | ComfyUI integration — image generation. Queues workflows, polls for results, downloads output images to session dir. Routes through GPU Manager when available. Pure helpers extracted to the three modules below. |
| `comfyui-graph.ts` | Pure ComfyUI prompt-graph surgery helpers (detailer chain wiring etc.) — no fs/network deps. Extracted from ComfyUIClient. |
| `comfyui-checkpoint.ts` | Checkpoint resolution + compatibility checks; reads `comfyui-config.json` from session/persona dir. Extracted from ComfyUIClient. |
| `comfyui-history.ts` | Pure parsers for ComfyUI history/outputs (image/audio filename extraction). Extracted from ComfyUIClient. |
| `workflow-resolver.ts` | ComfyUI workflow package management. Loads packages, validates `ParamDef` defs, merges prefix/suffix, supports custom `resolver.mjs` plugins. `loadPackage()`, `listPackages()`, `resolveWorkflow()`, `validateParams()`. |
| `gemini-image.ts` | Gemini image generation via `generativelanguage.googleapis.com` API. Configurable model (`GEMINI_IMAGE_MODEL`). Supports multiple reference images and aspect ratio. |
| `openai-image.ts` | OpenAI image generation via the metered Responses API `image_generation` tool (orchestration model `gpt-5.5` by default, overridable via `OPENAI_IMAGE_MODEL`; actual renderer `gpt-image-2`, overridable via `OPENAI_IMAGE_TOOL_MODEL`; a misconfig guard treats a `gpt-image-*` value passed to `OPENAI_IMAGE_MODEL` as the renderer). Reference images are sent as `input_image` (base64 data URL) for editing (`action: edit`). Used only when `OPENAI_IMAGE_BACKEND=api`. |
| `codex-image.ts` | **Default** OpenAI/GPT image backend (`OPENAI_IMAGE_BACKEND=codex`). Drives `codex exec` whose built-in `image_gen` tool renders via the ChatGPT subscription (no per-call cost / no `OPENAI_API_KEY`). Snapshots `$CODEX_HOME/generated_images`, harvests the new `ig_*.png`, copies into the session `images/`. Editing via `codex exec -i <reference>`. Slower (a full agent turn) and bound by the plan's rate limits. |

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
| `usage-checker.ts` | Polls Claude / Codex / Gemini(Antigravity) usage APIs (per-window utilization, `resets_at`, `timeProgress`) with a 30s in-memory cache. `getClaudeUsage()`, `getCodexUsage()`, `getGeminiUsage()`, `getAntigravityUsage()` (delegates to the Gemini usage path). |

### Utilities

| File | Role |
|------|------|
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `endpoints.ts` | Single source of truth for the service's own ports / base URLs (TTS = PORT+1, GPU Manager = PORT+2; default 3340 → 3341/3342). Consumers must use this instead of re-deriving defaults. |
| `inline-formatter.ts` | Shared inline tokenizer for RP markdown-lite (`*action*` / `**bold**` / `'thought'` / inline code / `$PANEL$`·`$IMAGE$` placeholders) — CommonMark-style delimiter-stack parser, inline-only. |
| `env-file.ts` | `.env.local` file reader/writer with quote stripping & comment handling. |
| `fs-retry.ts` | `retryOnWindowsLock<T>()` — exponential backoff for EBUSY/EPERM/ENOTEMPTY errors caused by other Windows processes holding a file. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |
| `autoplay.ts` | Autoplay & Steering Preset management stored in localStorage. `SteeringPreset` interface, `loadPresets()`, `savePresets()`. |

## MCP Server

`src/mcp/claude-play-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude / Codex / Gemini / Kimi / Antigravity. Configured via `.mcp.json` (Claude and Kimi — kimi spawns with `--mcp-config-file <cwd>/.mcp.json`), `.codex/config.toml` (Codex — read via the `CODEX_HOME` repoint at spawn), `.gemini/` settings (Gemini), or `.agents/mcp_config.json` (Antigravity) inside the session directory; all are (re)written by `runtime-config.ts` on every session open, so token rotation self-heals but already-open sessions need a re-open to pick up config changes. Authenticates to the Bridge API via the internal `x-bridge-token` header. Helper `withPersona()` injects the active persona / session id into every outgoing request.

MCP registration is the **only** viable tool channel for the AI processes — "just have the model curl the API" is never an acceptable fallback for a missing-MCP bug: many bridge tools (`fire_ai`, scheduler control, sub-agent dispatch, …) have no standalone REST equivalent, and the optional `ADMIN_PASSWORD` middleware 401s any AI-issued request lacking the internal token that the MCP server supplies.

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
| `generate_image_openai` | High-level OpenAI/GPT image generation. Default backend = Codex CLI built-in `image_gen` (ChatGPT subscription, no per-call cost); `OPENAI_IMAGE_BACKEND=api` switches to the metered Responses API |
| `update_profile` | Replace persona profile image and auto-crop a 256×256 icon |
| `policy_review` | Local content-policy review (allow / deny / uncertain) with decision logging |
| `policy_context` | Read roleplay policy context (extreme traits, reviewed scenarios, intimacy policy) |
| `run_tool` | Execute custom session tools — single or chained, with state snapshot |
| `fire_ai` | Spawn a detached background AI run (long-form generation, side jobs). Exit-time hooks: `notify` (silent system event queued for next user turn), `autoResume` (fire a spontaneous response turn as soon as the caller AI is idle — immediately if idle, else right after the current turn; subsumes `notify`), `onExit.broadcast` (WS to caller session's clients — UI updates without AI turn), `onExit.script` (JS module inside session dir for dynamic broadcast/queueEvent). |
| `bridge_delegate` | (세션 모드) 메인 AI가 상시 서브에이전트에게 태스크를 위임. `{ to: name, task: string }` → `SubAgentManager.dispatch()`. |
| `report_to_main` | (서브에이전트 전용) 서브가 결과를 메인 세션 이벤트 큐에 보고. `{ from: name, summary: string }` → `pending-events.json` 큐잉 → 다음 사용자 턴에 flush. |
| `bridge_define_subagent` | (빌더 모드 전용) 서브에이전트 정의 생성/갱신. `{ name, role, model?, instructions, delegable?, autoTrigger?, autoTriggerTask?, emitSummary? }` → 페르소나 디렉토리에 `subagents.json` + `subagents/{name}/instructions.md` 기록. |

### MCP Features

- Policy context system with configurable intimacy policies and traits
- Snapshot system that reads `variables.json` + `hint-rules.json` and formats display/hints
- Tool chaining with sequential execution and early exit on failure
- Image deduplication within single turn (30s window) via `deduplicateImageFilename()`
- ComfyUI config reading (session-level → global fallback)
- Background `fire_ai` jobs run independently of the main turn, broadcasting completion notifications. Per-call `onExit` lets the caller pick UI-only (`broadcast`) and/or dynamic-callback (`script`) behaviour; completion delivery to the AI is `notify` (queued for next user turn) or `autoResume` (spontaneous turn when idle — subsumes `notify`)

### External MCP Endpoint

`POST /mcp/external` — 같은 PC의 외부 AI 에이전트용 Streamable HTTP MCP 엔드포인트 (stateless, POST 전용). `server.ts`가 Next.js보다 먼저 가로채므로 ADMIN 미들웨어와 무관하고, 인증은 `x-external-token` 헤더(= `data/.runtime/external-mcp-token`, 서버 시작 시 자동 생성)로만 한다. 구현은 `src/lib/external-mcp/` — `token.ts`(토큰), `registry.ts`(노출 툴 정의, 확장 지점), `server.ts`(transport), `flatten.ts`(outputDir 직하 이동). 노출 툴은 이미지 생성 3종 + ComfyUI 보조 3종이며 `outputDir`(절대경로) 필수. 상세: [external-mcp.md](external-mcp.md), 소비자 셋업: [external-setup-guide.md](external-setup-guide.md) + `scripts/setup-external.mjs`.
