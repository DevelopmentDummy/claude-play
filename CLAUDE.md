# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Bridge is a Next.js web app that bridges interactive roleplay (RP) chat sessions with the Claude Code CLI (and optionally Codex CLI). Users create personas via a builder UI, then conduct immersive RP sessions with dynamic state, panels, and memory. Single-user personal service with optional admin password authentication.

## Commands

- `node setup.js` — First-time setup: Node deps, Python venv, PyTorch, ports, data/ init. `--yes` for non-interactive mode.
- `npm run dev` — Start dev server (all interfaces), uses `tsx watch server.ts`
- `npm run build` — TypeScript check + Next.js production build
- `npm run start` — Serve production build

No test framework is configured.

## Architecture

**Stack**: Next.js 15 (App Router) + React 19 + Tailwind CSS 3 + TypeScript (strict). Path alias `@/*` → `src/*`.

### Server Entry

`server.ts` — Custom HTTP server wrapping Next.js with WebSocket upgrade support. Calls `setupWebSocket()` to attach the WS server on `/ws`. Also spawns TTS server and GPU Manager as child processes.

### GPU Manager (`gpu-manager/`)

Python FastAPI child process (port 3342) for serial GPU task queueing. Prevents VRAM conflicts between image generation and TTS by processing one GPU task at a time.

| File | Role |
|------|------|
| `server.py` | FastAPI app with `/health`, `/status`, `/comfyui/generate`, `/tts/synthesize`, `/tts/create-voice` endpoints |
| `queue_manager.py` | Serial asyncio queue — FIFO, one task at a time, per-type timeouts |
| `comfyui_proxy.py` | Proxies image generation requests to ComfyUI API |
| `tts_engine.py` | Qwen3-TTS direct inference — on-demand loading, 30s idle timeout, model size switching |
| `voice_creator.py` | Voice embedding (.pt) generator from design prompt or reference audio |

### Core Libraries (`src/lib/`)

| File | Role |
|------|------|
| `auth.ts` | Authentication. Internal MCP token (`getInternalToken()`, `validateInternalToken()`). Admin auth (`createAuthToken()`, `verifyAuthToken()`, `verifyPassword()`, `parseCookieToken()`). |
| `services.ts` | Global singleton (`getServices()`) via `globalThis`. Accumulates assistant turns from NDJSON stream events, extracts `<dialog_response>` and `<choice>` tags, detects image tool tokens (`$IMAGE:...$/`), manages chat history persistence. Forwards `compacting` system status to frontend. |
| `claude-process.ts` | Spawns `claude -p` subprocess with `--input-format stream-json --output-format stream-json --verbose`. NDJSON line-buffered parser. Emits `message/status/error/sessionId` events. Auto-retries without `--resume` on failed resume. |
| `codex-process.ts` | Codex CLI integration via `codex app-server` mode (persistent JSON-RPC 2.0 over stdin/stdout). Same EventEmitter interface as ClaudeProcess. |
| `ai-provider.ts` | `AIProvider` type (`"claude" | "codex"`), `providerFromModel()` mapping, model option constants. |
| `session-manager.ts` | CRUD for personas, sessions, profiles. Copies persona → session directory. Writes `.claude/settings.json` + `.mcp.json` + `.codex/config.toml` per session. Manages layout config, builder sessions, skill copying, CLAUDE.md + AGENTS.md assembly. Bidirectional sync with diff comparison (forward: persona→session, reverse: session→persona). |
| `panel-engine.ts` | Watches `variables.json` + `panels/*.html` + custom `*.json` data files + `layout.json` via `fs.watch`. Compiles Handlebars templates with registered helpers (eq, gt, add, percentage, etc.). Broadcasts rendered HTML and layout updates via WebSocket. |
| `ws-server.ts` | WebSocket server on `/ws?sessionId=X&builder=true/false`. Handles `chat:send`, `session:bind`, `session:leave` messages. `wsBroadcast()` for global broadcasts. 5s grace period cleanup on last client disconnect. |
| `comfyui-client.ts` | Optional ComfyUI integration — image generation. Queues workflows, polls for results, downloads output images to session dir. Can route through GPU Manager when available. |
| `tts-handler.ts` | TTS request handler (runs in plain Node via server.ts). Routes to Edge TTS or GPU Manager for local TTS. Handles chat TTS and voice creation/testing. |
| `gemini-image.ts` | Optional Gemini image generation via `generativelanguage.googleapis.com` API. Saves base64 response to session `images/` dir. |
| `data-dir.ts` | Resolves `DATA_DIR` env var or defaults to `./data`. Provides `getDataDir()` and `getAppRoot()`. |
| `color-utils.ts` | Frontend helpers: `hexToRgba()`, `lightenHex()`. |

### MCP Server

`src/mcp/claude-bridge-mcp-server.mjs` — Per-session MCP server spawned as a child process by Claude/Codex. Configured via `.mcp.json` (Claude) or `.codex/config.toml` (Codex) in the session directory. Provides `claude_bridge` tools for AI to interact with the bridge (image generation, panel updates, policy review, custom tool execution, etc.). Authenticates to Bridge API via internal `x-bridge-token` header.

### API Routes (`src/app/api/`)

Optional admin password auth via `ADMIN_PASSWORD` env var. MCP server requests include `x-bridge-token` for internal validation.

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/personas` | GET | List all personas |
| `/api/personas/[name]` | GET, DELETE | Get/delete persona |
| `/api/personas/[name]/file` | GET, PUT | Read/write individual persona files |
| `/api/personas/[name]/overview` | GET | Full persona overview (files, panels, skills, data) |
| `/api/personas/[name]/images` | GET | Serve persona images |
| `/api/personas/[name]/voice` | GET, PUT | Read/write voice.json config |
| `/api/personas/[name]/voice/upload` | GET, POST, DELETE | Serve/upload/remove reference audio |
| `/api/profiles` | GET, POST | List/create user profiles |
| `/api/profiles/[slug]` | GET, PUT, DELETE | CRUD individual profile |
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | GET, DELETE | Get/delete session |
| `/api/sessions/[id]/open` | POST | Open session (spawn AI process, start panels) |
| `/api/sessions/[id]/sync` | GET, POST | GET: diff (supports `?direction=reverse`); POST: selective sync with `direction` + `variablesMode` |
| `/api/sessions/[id]/variables` | GET, PATCH | Read/patch session variables (PATCH supports `?file=` for custom data files) |
| `/api/sessions/[id]/modals` | POST | Group-aware modal open/close/closeAll (body: `{ action, name?, mode?, except? }`) |
| `/api/sessions/[id]/events` | POST | Queue event header for next chat message (body: `{ header: string }`) |
| `/api/sessions/[id]/files` | GET | Serve session files (images, etc.) |
| `/api/chat/send` | POST | Send message to AI process |
| `/api/chat/history` | GET, PATCH | GET: paginated history; PATCH: toggle message OOC flag |
| `/api/builder/start` | POST | Start persona builder session |
| `/api/builder/edit` | POST | Send message in builder mode |
| `/api/builder/cancel` | POST | Cancel builder session |
| `/api/tools/comfyui/generate` | POST | Trigger ComfyUI image generation |
| `/api/tools/comfyui/models` | GET | List ComfyUI models |
| `/api/tools/gemini/generate` | POST | Trigger Gemini image generation |
| `/api/tools/openai/generate` | POST | Trigger OpenAI image generation |
| `/api/sessions/[id]/tools/[name]` | POST | Execute custom panel tool script |
| `/api/auth/login` | POST | Admin login (rate-limited: 5/min per IP) |
| `/api/auth/logout` | POST | Admin logout (clear cookie) |
| `/api/debug` | GET | Debug info |

### Frontend Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/login` | `login/page.tsx` | Admin login page (shown when `ADMIN_PASSWORD` is set) |
| `/` | `page.tsx` | Home — persona list, session list, profile management |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels |

### Key Frontend Components

| Component | Role |
|-----------|------|
| `ChatMessages.tsx` | Message rendering with `<dialog_response>` extraction, inline images/panels, infinite scroll. |
| `ChatInput.tsx` | Message input with OOC mode toggle, `*` insert button. |
| `StatusBar.tsx` | Navigation bar with model selector, Sync button, status indicator. |
| `SyncModal.tsx` | Bidirectional sync modal with direction toggle, per-element selection, diff badges. |
| `ImageModal.tsx` | Fullscreen image viewer via `createPortal`. |
| `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation. |
| `ModalPanel.tsx` | Modal overlay panel via `createPortal`. |
| `VoiceSettings.tsx` | Per-persona voice configuration UI. |

## Data Model

**File-based data** under `data/` (gitignored).

```
data/
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
│   └── audio/                       # TTS audio output files
└── profiles/{slug}.json             # User profiles (name, description, isPrimary)
```

## Shared Document Map

이 프로젝트는 **루트 레벨 공용 문서**들이 빌더/세션 작업 디렉토리로 전파되는 구조다. 각 문서의 역할과 독자를 이해해야 변경 시 올바른 곳을 업데이트할 수 있다.

| Document | Audience | Purpose | Propagation |
|----------|----------|---------|-------------|
| `builder-prompt.md` | Builder AI | 페르소나 빌더 워크플로우, 파일 생성 명세 | 빌더 세션 시작 시 → 페르소나 디렉토리의 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`로 복사 |
| `builder-primer.yaml` | Builder AI | 빌더 모드 시스템 프롬프트 래퍼 | 빌더 세션 시작 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 |
| `session-primer.yaml` | Session AI (Claude) | RP 세션 시스템 프롬프트 (캐릭터 몰입, 성인 콘텐츠 허용, 가이드라인) | 세션 Open 시 `active_system_prompt` 추출 → AI 런타임 시스템 프롬프트로 전달 (디스크에 쓰이지 않음) |
| `session-primer-codex.yaml` | Session AI (Codex) | Codex용 RP 세션 시스템 프롬프트 | 세션 Open 시 → `.codex/model-instructions.md`로 작성 |
| `session-primer-gemini.yaml` | Session AI (Gemini) | Gemini용 RP 세션 시스템 프롬프트 | 세션 Open 시 → `GEMINI.md`에 병합 |
| `session-shared.md` | Session AI (all) | 공용 세션 가이드 (응답 형식, OOC, STT, 이미지 생성, 선택지 시스템) | 세션 Open 시 primer와 결합 → AI 런타임 시스템 프롬프트로 전달 |
| `panel-spec.md` | Builder/Session AI | 패널 시스템 기술 레퍼런스 (Handlebars, panelBridge, placement, tools 등) | 빌더 세션 시작 및 RP 세션 Open 시 → 작업 디렉토리로 복사 (매번 최신본으로 갱신) |

### Document Assembly Flow

**빌더 세션** (`POST /api/builder/start`):
```
builder-prompt.md → 페르소나 디렉토리 CLAUDE.md / AGENTS.md / GEMINI.md
builder-primer.yaml → AI 런타임 시스템 프롬프트
panel-spec.md → 페르소나 디렉토리에 복사 (참조용)
```

**RP 세션 생성** (`POST /api/sessions`):
```
persona/session-instructions.md → 세션 CLAUDE.md / AGENTS.md / GEMINI.md
  + style section (style.json이 있으면)
  + profile section (프로필이 있으면)
  + opening section (opening.md가 있으면)
persona files (panels/, tools/, variables.json, *.json, ...) → 세션 디렉토리에 복사
panel-spec.md → 세션 디렉토리에 복사
global tool skills (data/tools/*/skills/) → .claude/skills/ + .agents/skills/
```

**RP 세션 Open** (`POST /api/sessions/[id]/open`):
```
session-primer{-codex,-gemini}.yaml + session-shared.md → AI 런타임 시스템 프롬프트 (에페메럴)
panel-spec.md → 세션 디렉토리에 갱신 (최신본)
global tool skills → 세션 skills 디렉토리에 갱신
```

## Change Propagation Rules

코드 변경 시 아래 체크리스트를 따라 관련 문서를 함께 업데이트해야 한다.

### 패널 시스템 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 패널 렌더링 동작 변경 (Shadow DOM, 클릭 핸들러, CSS 격리 등) | `panel-spec.md` |
| panelBridge 메서드 추가/변경 | `panel-spec.md` |
| Handlebars 헬퍼 추가/변경 | `panel-spec.md` |
| layout.json 스키마 변경 (placement, theme, 새 필드) | `panel-spec.md` |
| 패널 관련 WebSocket 이벤트 변경 | `panel-spec.md` |
| 패널 관련 API 엔드포인트 변경 | `panel-spec.md` + 이 문서 (API Routes 표) |

### 세션 런타임 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 응답 형식 규칙 변경 (dialog_response, choice, 토큰 등) | `session-shared.md` |
| OOC 동작 변경 | `session-shared.md` |
| 이미지 생성 워크플로우 변경 | `session-shared.md` |
| MCP 도구 인터페이스 변경 | `session-shared.md` + `src/mcp/claude-bridge-mcp-server.mjs` |
| 세션 AI 시스템 프롬프트 변경 | `session-primer.yaml` (+ `-codex` / `-gemini` 변형) |

### 빌더 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| 페르소나 파일 스키마 변경 (새 파일 추가, 필드 변경) | `builder-prompt.md` |
| 빌더 워크플로우 변경 | `builder-prompt.md` |
| 빌더 AI 시스템 프롬프트 변경 | `builder-primer.yaml` |
| voice.json 스키마 변경 | `builder-prompt.md` (음성 설정 섹션) |

### 서비스 인프라 변경

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| API 엔드포인트 추가/변경 | 이 문서 (API Routes 표) |
| 환경 변수 추가/변경 | 이 문서 (Environment Variables) |
| 세션 라이프사이클 변경 | 이 문서 (Session Lifecycle) |
| MCP 서버 인증/설정 변경 | 이 문서 (MCP Server, Infrastructure Conventions) |
| 프론트엔드 페이지/컴포넌트 추가 | 이 문서 (Frontend Pages/Components) |

### 스킬 전파

| 변경 내용 | 업데이트 대상 |
|-----------|--------------|
| `data/tools/{name}/skills/` 글로벌 스킬 변경 | 변경 즉시 반영 안 됨 — 세션 Open 시 자동 갱신 (`refreshToolSkills()`) |
| 스킬 내 `{{PORT}}` 플레이스홀더 | 세션 Open 시 현재 서버 포트로 치환됨 |

## Session Lifecycle

1. **Create**: `POST /api/sessions` — 페르소나 디렉토리 → 세션 디렉토리 복사, CLAUDE.md/AGENTS.md/GEMINI.md 조립, 런타임 설정 파일 생성
2. **Open**: `POST /api/sessions/[id]/open` — AI 프로세스 spawn, PanelEngine 시작, panel-spec.md 및 글로벌 스킬 갱신
3. **Chat**: WebSocket `chat:send` or `POST /api/chat/send` — 사용자 메시지를 AI stdin으로 전달, NDJSON 스트리밍 응답
4. **Accumulate**: `services.ts`에서 `text_delta` 이벤트를 수집, dialog/choice 추출, 히스토리 저장
5. **Panel refresh**: AI 턴 종료 시 `PanelEngine.reload()`로 데이터 파일 재로드 및 패널 재렌더링
6. **Sync** (수동): `POST /api/sessions/[id]/sync` — 양방향. Forward(페르소나→세션)는 OOC 알림 전송, Reverse(세션→페르소나)는 페르소나 템플릿에 역기록
7. **Leave/Disconnect**: 마지막 클라이언트 연결 해제 후 5초 유예 → AI 프로세스 종료, PanelEngine 중지

## Dual Runtime (Claude / Codex)

- Provider determined by model at session creation, locked for session lifetime
- Claude: `claude -p` persistent process, NDJSON streaming
- Codex: `codex app-server` persistent JSON-RPC 2.0 over stdin/stdout
- Both share same EventEmitter interface (`message/status/error/sessionId`)
- Instruction files: `CLAUDE.md` (Claude) + `AGENTS.md` (Codex) + `GEMINI.md` (Gemini) generated in parallel
- MCP config: `.mcp.json` (Claude) + `.codex/config.toml` (Codex)
- Builder mode supports service switching (Claude↔Codex)

## Infrastructure Conventions

- **Setup wizard**: `node setup.js` (CLI) + `/setup` web wizard. `data/.setup-complete` flag controls redirect.
- **Port auto-calculation**: `TTS_PORT` defaults to `PORT+1`, `GPU_MANAGER_PORT` defaults to `PORT+2`.
- **MCP authentication**: Internal token per server process → `.mcp.json` / `.codex/config.toml` env vars → `x-bridge-token` header.
- **MCP bootstrap**: Claude launched with `--mcp-config <cwd>/.mcp.json --strict-mcp-config`.
- **Permission sandboxing**: `.claude/settings.json` per session restricts Claude tools to session directory.
- **Admin authentication**: Optional via `ADMIN_PASSWORD`. HMAC-SHA256 tokens in httpOnly cookies (90-day). Rate-limited login (5/min per IP). MCP server bypasses via `x-bridge-token`.
- **Global singleton pattern**: `services.ts` and `ws-server.ts` use `globalThis[key]` for HMR-safe state sharing.
- **Windows process killing**: Uses `taskkill /T /F /PID` because `shell: true` wraps in cmd.exe.
- **GPU Manager**: Python child process auto-spawned by `server.ts`. Serial queue, health check (30s timeout), auto-restart (max 3, 10s backoff).
- **TTS dual provider**: Edge TTS (cloud, `tts-server.mjs`) + Local TTS (GPU Manager, Qwen3-TTS). Output saved as MP3 to session `audio/` dir. `audio:ready` WebSocket event notifies frontend.

## Environment Variables

- `DATA_DIR` — Data directory path (default: `./data`)
- `PORT` — Server port (default: 3340)
- `COMFYUI_URL`, `COMFYUI_WORKFLOW_PATH` — Optional ComfyUI integration
- `GEMINI_API_KEY` — Optional Gemini image generation API key
- `OPENAI_API_KEY` — Optional OpenAI image generation API key
- `OPENAI_IMAGE_MODEL` — OpenAI image model (default: `gpt-image-1.5`)
- `CLAUDE_BRIDGE_API_BASE` — Override API base URL for MCP server (default: `http://127.0.0.1:{PORT}`)
- `COMFYUI_HOST` — ComfyUI host (default: `127.0.0.1`)
- `COMFYUI_PORT` — ComfyUI port (default: `8188`)
- `TTS_ENABLED` — Enable/disable TTS globally (default: `true`)
- `TTS_PORT` — Edge TTS server port (default: `PORT+1`)
- `GPU_MANAGER_PORT` — GPU Manager port (default: `PORT+2`)
- `GPU_MANAGER_PYTHON` — Python executable for GPU Manager (default: `python`)
- `ADMIN_PASSWORD` — Admin login password. If not set, authentication is disabled (open access).

## Skills & Plugins

- **frontend-design**: UI 컴포넌트, 페이지, 패널 HTML 등 프론트엔드 작업 시 `/frontend-design` 스킬을 사용할 것.
