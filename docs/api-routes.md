# API Routes (`src/app/api/`)

Optional admin password auth via `ADMIN_PASSWORD` env var. MCP server requests include `x-bridge-token` for internal validation.

Next.js 밖에서 `server.ts`가 직접 처리하는 라우트: `/api/chat/tts`, `/api/personas/[name]/voice/generate` (TTS 인터셉트), **`POST /mcp/external`** (외부 에이전트용 Streamable HTTP MCP — `x-external-token` 인증, [external-mcp.md](external-mcp.md)).

## Authentication

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/auth/login` | POST | Admin login (rate-limited: 5/min per IP) |
| `/api/auth/logout` | POST | Admin logout (clear cookie) |

## Personas

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/personas` | GET | List all personas (creation happens via `POST /api/builder/start`) |
| `/api/personas/import` | POST | Install a persona from a GitHub repo URL |
| `/api/personas/import/preview` | POST | Inspect a persona repo's metadata (name, description, icon) before import |
| `/api/personas/[name]` | DELETE | Delete persona (moved to `data/deleted_personas/`) |
| `/api/personas/[name]/check-update` | POST | Compare local commit against remote for installed personas |
| `/api/personas/[name]/clone` | GET, POST | GET: name availability check / POST: duplicate persona under a new name |
| `/api/personas/[name]/publish` | POST | Push persona dir to a GitHub repo |
| `/api/personas/[name]/file` | GET, PUT | Read/write individual persona files |
| `/api/personas/[name]/overview` | GET | Full persona overview (files, panels, skills, data) |
| `/api/personas/[name]/images` | GET | Serve persona images |
| `/api/personas/[name]/options` | GET, PUT | Read/write persona options |
| `/api/personas/[name]/versions` | GET, POST, PUT | Version history — list, create snapshot, restore |
| `/api/personas/[name]/voice` | GET, PUT | Read/write voice.json config |
| `/api/personas/[name]/voice/generate` | GET, POST | Voice generation/testing |
| `/api/personas/[name]/voice/upload` | GET, POST, DELETE | Serve/upload/remove reference audio |
| `/api/personas/[name]/voice/youtube` | POST | Download voice reference from YouTube |
| `/api/personas/[name]/conversations` | GET | List provider-side conversations tied to the persona dir (builder Sessions menu) |
| `/api/personas/[name]/relink` | POST | Tear down builder SessionInstance and rewrite builder-session.json's conversation id (`{ conversationId }` body) |

## Profiles

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/profiles` | GET, POST | List profiles / create new profile |
| `/api/profiles/[slug]` | GET, PUT, DELETE | Read / update / delete a profile |

## Sessions

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | DELETE | Delete session (moved to `data/deleted_sessions/`) |
| `/api/sessions/[id]/open` | POST | Open session (spawn AI process, start panels) |
| `/api/sessions/[id]/sync` | GET, POST | GET: diff (`?direction=reverse`); POST: selective sync with `direction` + `variablesMode` |
| `/api/sessions/[id]/conversations` | GET | List provider-side conversations (jsonl/rollouts) tied to this session folder for the resume menu |
| `/api/sessions/[id]/relink` | POST | Tear down live SessionInstance and rewrite session.json's provider conversation id (`{ conversationId }` body) |
| `/api/sessions/[id]/variables` | PATCH | Patch session variables (supports `?file=` for custom data files) |
| `/api/sessions/[id]/modals` | POST | Group-aware modal open/close/closeAll (body: `{ action, name?, mode?, except? }`) |
| `/api/sessions/[id]/events` | POST | Queue event header for next chat message (body: `{ header: string, silent?: boolean }`) — `silent` skips the `event:pending` broadcast; `[SUB:name]`-prefixed headers are also mirrored into that sub-agent's transcript |
| `/api/sessions/[id]/panel-actions` | POST, DELETE | POST: queue a panel action / DELETE: pop the last queued action |
| `/api/sessions/[id]/panel-actions-meta` | GET | Read the panel-action spec metadata (`panels/_actions.meta.json`) |
| `/api/sessions/[id]/fire-ai` | POST | Spawn a detached background AI run (provider derived from `model`; Claude default). Body: `{ prompt, model?, effort?, notify?, autoResume?, onExit? }` — `autoResume` fires a spontaneous turn on completion, `onExit` supports WS broadcast / session-dir script callback |
| `/api/sessions/[id]/subagents` | GET | List declared sub-agents with live detail (`subAgents.listDetailed()`) |
| `/api/sessions/[id]/subagents/[name]/dispatch` | POST | Dispatch a task to a sub-agent on the delegate channel (body: `{ task }`; backend of the `bridge_delegate` MCP tool) |
| `/api/sessions/[id]/subagents/[name]/message` | POST | Operator direct message to a sub-agent (channel `"operator"`, body: `{ text }`) |
| `/api/sessions/[id]/subagents/[name]/transcript` | GET | Read a sub-agent's transcript tail (`?n=` default 200, max 1000) |
| `/api/sessions/[id]/tool-answer` | POST | Submit an AskUserQuestion answer to the live session instance (body: `{ toolUseId, answer: { answers } }`) |
| `/api/sessions/[id]/pipeline-scheduler/start` | POST | Start the per-session pipeline scheduler |
| `/api/sessions/[id]/pipeline-scheduler/stop` | POST | Stop the per-session pipeline scheduler |
| `/api/sessions/[id]/persona-images` | GET | List persona images / serve a single image (thumbnail support) |
| `/api/sessions/[id]/files` | GET, HEAD | Serve session files (images, etc.) |
| `/api/sessions/[id]/files/[...filepath]` | GET, HEAD | Serve session files (nested path) |
| `/api/sessions/[id]/images` | GET | List session images |
| `/api/sessions/[id]/layout` | PATCH | Update session layout config |
| `/api/sessions/[id]/options` | GET, PUT | Read/write session options |
| `/api/sessions/[id]/options/apply` | POST | Apply options changes to active session |
| `/api/sessions/[id]/crop-profile` | POST | Crop and save profile image |
| `/api/sessions/[id]/crop-source` | GET | Serve images from a `character-lora-dataset` source dir for cropping UI |
| `/api/sessions/[id]/derive-icon` | POST | Fallback 256×256 face icon: crop top-center square from persona portrait `images/girls/{girl_id}.png` → `{girl_id}_icon.png` when the ComfyUI face-detector workflow fails (body: `{ girl_id }`) |
| `/api/sessions/[id]/voice` | GET, PATCH | Read/update session voice config |
| `/api/sessions/[id]/tools/[name]` | POST | Execute custom panel tool script |

## Chat

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/chat/send` | POST | Send message to AI process |
| `/api/chat/history` | GET, PATCH | GET: paginated history; PATCH: toggle message OOC flag |
| `/api/chat/tts` | POST | Text-to-speech synthesis for chat message |

## Chat Options

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/chat-options/schema` | GET | Get chat options schema definition |

## Builder

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/builder/start` | POST | Start persona builder session |
| `/api/builder/edit` | POST | Send message in builder mode |
| `/api/builder/cancel` | POST | Cancel builder session |

## Setup

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/setup/status` | GET | Check setup completion status |
| `/api/setup/save` | POST | Save setup configuration |
| `/api/setup/test-comfyui` | POST | Test ComfyUI connection |
| `/api/setup/test-gemini` | POST | Test Gemini API key |
| `/api/setup/tts-status` | GET | Check TTS server status |

## Service

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/service/status` | GET | Active sessions, instances, schedulers, WS-client snapshot |
| `/api/service/restart` | POST | Rebuild and restart the server via the background restart orchestrator |

## Usage

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/usage` | GET | Provider token usage (`?provider=claude\|codex\|gemini\|antigravity`) — utilization windows, `resets_at`, time progress (30s cache). `provider=codex` additionally requires `&sessionId=<active codex session>` |

## Styles

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/styles` | GET, POST, DELETE | List/create/delete writing style presets |

## Tools (Image Generation & Health)

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/tools/comfyui/generate` | POST | Trigger ComfyUI image generation. `outputDir`(절대경로, 내부 토큰 전용) 지정 시 세션 대신 해당 디렉토리 직하에 저장 — 외부 MCP 경유 |
| `/api/tools/comfyui/models` | GET | List ComfyUI models |
| `/api/tools/comfyui/health` | GET | ComfyUI + GPU Manager connectivity status |
| `/api/tools/comfyui/stt` | POST | Speech-to-text via ComfyUI |
| `/api/tools/comfyui/update-profile` | POST | Update profile image via ComfyUI |
| `/api/tools/gemini/generate` | POST | Trigger Gemini image generation. `outputDir`(내부 토큰 전용) 분기는 완료 대기 후 절대경로 응답 |
| `/api/tools/openai/generate` | POST | Trigger OpenAI image generation. `outputDir`(내부 토큰 전용) 분기는 완료 대기 후 절대경로 응답 |

## Debug

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/debug` | GET | Debug info |
