# API Routes (`src/app/api/`)

Optional admin password auth via `ADMIN_PASSWORD` env var. MCP server requests include `x-bridge-token` for internal validation.

## Authentication

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/auth/login` | POST | Admin login (rate-limited: 5/min per IP) |
| `/api/auth/logout` | POST | Admin logout (clear cookie) |

## Personas

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/personas` | GET, POST | List all personas / create new persona |
| `/api/personas/[name]` | DELETE | Delete persona |
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

## Sessions

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/sessions` | GET, POST | List sessions / create new session |
| `/api/sessions/[id]` | DELETE | Delete session |
| `/api/sessions/[id]/open` | POST | Open session (spawn AI process, start panels) |
| `/api/sessions/[id]/sync` | GET, POST | GET: diff (`?direction=reverse`); POST: selective sync with `direction` + `variablesMode` |
| `/api/sessions/[id]/conversations` | GET | List provider-side conversations (jsonl/rollouts) tied to this session folder for the resume menu |
| `/api/sessions/[id]/relink` | POST | Tear down live SessionInstance and rewrite session.json's provider conversation id (`{ conversationId }` body) |
| `/api/sessions/[id]/variables` | PATCH | Patch session variables (supports `?file=` for custom data files) |
| `/api/sessions/[id]/modals` | POST | Group-aware modal open/close/closeAll (body: `{ action, name?, mode?, except? }`) |
| `/api/sessions/[id]/events` | POST | Queue event header for next chat message (body: `{ header: string }`) |
| `/api/sessions/[id]/files` | GET, HEAD | Serve session files (images, etc.) |
| `/api/sessions/[id]/files/[...filepath]` | GET, HEAD | Serve session files (nested path) |
| `/api/sessions/[id]/images` | GET | List session images |
| `/api/sessions/[id]/layout` | PATCH | Update session layout config |
| `/api/sessions/[id]/options` | GET, PUT | Read/write session options |
| `/api/sessions/[id]/options/apply` | POST | Apply options changes to active session |
| `/api/sessions/[id]/crop-profile` | POST | Crop and save profile image |
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

## Styles

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/styles` | GET, POST, DELETE | List/create/delete writing style presets |

## Tools (Image Generation)

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/tools/comfyui/generate` | POST | Trigger ComfyUI image generation |
| `/api/tools/comfyui/models` | GET | List ComfyUI models |
| `/api/tools/comfyui/stt` | POST | Speech-to-text via ComfyUI |
| `/api/tools/comfyui/update-profile` | POST | Update profile image via ComfyUI |
| `/api/tools/gemini/generate` | POST | Trigger Gemini image generation |
| `/api/tools/openai/generate` | POST | Trigger OpenAI image generation |

## Debug

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/debug` | GET | Debug info |
