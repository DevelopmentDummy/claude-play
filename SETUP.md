# Claude Play Setup Guide

> This guide is designed for both humans and AI agents.
> AI agents: see [AI Agent Setup Flow](#ai-agent-setup-flow) for the recommended non-interactive workflow.

## Prerequisites

- **Node.js 18.18+** (20 LTS 이상 권장) — `node --version`. `setup.js`는 major 18 미만만 거부하므로 18.0~18.17은 통과했다가 Next.js/sharp 설치에서 깨진다.
- **Python 3.10+** (optional) — for GPU Manager (local TTS, image generation)
- **Git** — for ComfyUI installation (optional)
- **NVIDIA GPU with 8GB+ VRAM** (optional) — for ComfyUI image generation and local TTS

## Quick Start

### 1. CLI Setup

```bash
node setup.js
```

Non-interactive (AI agents):
```bash
node setup.js --yes
```

**What it does:**
| Step | Action | Required? |
|------|--------|-----------|
| 1 | Node.js version check (major ≥ 18) | Yes |
| 2 | `npm install` | Yes |
| 3 | Python detection | No |
| 4 | Python venv + dependencies in `gpu-manager/` | No |
| 5 | GPU detection (VRAM, CUDA tag) | No |
| 6 | Local TTS (Qwen3-TTS / VoxCPM2 / both / skip) — PyTorch is installed here, only if a TTS engine is chosen | No |
| 7 | ComfyUI clone + setup (if VRAM >= 8GB) | No |
| 8 | Claude Code CLI check | No |
| 9 | Port configuration | Yes |
| 10 | `.env.local` creation (+ sample persona clone) | Yes |
| 11 | Port conflict check | Info only |
| 12 | `data/` directory initialization | Yes |
| 13 | `npm run build` (production build) | Yes |

**Expected prompts (--yes mode uses defaults):**
- "Continue without Python?" → Y
- "Local TTS 선택 [1-4]" → 4 (건너뛰기). `--yes` mode therefore never installs PyTorch — install it later from `gpu-manager/venv` if you want local TTS (see Troubleshooting).
- "Install ComfyUI?" → N (--yes skips optional installs)
- "Main server port:" → 3340

**Success indicator:** Ends with `Setup Complete!` message.

### 2. Start Server

Development:
```bash
npm run dev
```

Production:
```bash
npm run build && npm run start
```

**Verify server is running:**
```bash
curl http://localhost:3340/api/setup/status
```

Expected response on a fresh install:
```json
{"setupComplete":false,"adminPassword":false,"comfyui":false,...}
```

Once setup is complete **and** an admin password is set, this endpoint (and every other API call without the `bridge_auth` cookie) returns **401** — that is the success signal, not an error.

### 3. Web Setup (Browser)

Open `http://localhost:3340` — auto-redirects to `/setup` wizard.

**Wizard steps:**
1. Set admin password
2. Configure ComfyUI connection (optional — start ComfyUI first)
3. Enter API keys: Gemini (optional), CivitAI (optional)
4. Enable/disable TTS providers
5. Review and save

### 3-alt. API Setup (AI Agents)

Skip the browser wizard by calling APIs directly. This only works **before** setup is marked complete — afterwards `/api/setup/save` requires the admin cookie (`POST /api/auth/login` first).

```bash
# Save all settings at once
curl -X POST http://localhost:3340/api/setup/save \
  -H "Content-Type: application/json" \
  -d '{
    "adminPassword": "your-secure-password",
    "ttsEnabled": true
  }'
```

**Optional: Test ComfyUI connection**
```bash
curl -X POST http://localhost:3340/api/setup/test-comfyui \
  -H "Content-Type: application/json" \
  -d '{"host": "127.0.0.1", "port": 8188}'
```
Expected: `{"ok":true,"data":{...}}` or `{"ok":false,"error":"..."}`

**Optional: Validate Gemini API key**
```bash
curl -X POST http://localhost:3340/api/setup/test-gemini \
  -H "Content-Type: application/json" \
  -d '{"key": "your-gemini-api-key"}'
```
Expected: `{"ok":true}` or `{"ok":false,"error":"..."}`

**After save:** the server writes `.env.local`, marks setup complete, and **exits after 3 seconds** (`process.exit(0)`). Nothing restarts it by itself — `setup-web.js`/`start.bat` handle that when they are driving; under `npm run dev` you start it again yourself. Then verify:
```bash
curl http://localhost:3340/api/setup/status
```
Expected: `401` if you set an admin password (auth gate active), otherwise `{"setupComplete":true,...}`.

## AI Agent Setup Flow

For AI agents (Claude Code, Codex, etc.) setting up a fresh install:

### Step 1: CLI Setup

```bash
node setup.js --yes
```

This installs dependencies, builds the project, and exits. **It does not start the server.** Its closing message suggests `npm run dev` → `/setup`; that manual path works too, but the recommended agent path is Step 2 below (same as [docs/ai-setup-guide.md](docs/ai-setup-guide.md)).

### Step 2: Web Setup

```bash
node setup-web.js
```

This script:
1. Starts the production server in the background
2. Opens the browser to the setup wizard (`/setup`)
3. Waits for the user to complete web configuration (admin password, API keys, etc.)
4. Shuts down the server and exits with a completion message

**Wait for this script to finish before proceeding.** The output will tell you setup is complete and how to start the server.

### Step 3: Guide the User

Once `setup-web.js` exits, tell the user:
- Double-click `start.bat` to start the server, or run `npm run start`
- For development: `npm run dev`

### Notes
- Do NOT chain steps 1 and 2 in a single command — report step 1 results to the user first
- `setup-web.js` blocks until web setup completes, so run it and wait for its output
- If setup was already completed, `setup-web.js` detects this and exits immediately

## Health Checks

| Service | Endpoint | Default Port |
|---------|----------|-------------|
| Main server | `GET /api/setup/status` | PORT (3340) |
| GPU Manager | `GET http://localhost:{PORT+2}/health` | 3342 |
| TTS Server | `POST http://localhost:{PORT+1}/synthesize` | 3341 |

## Port Allocation

Ports are derived from the main `PORT` setting:

| Service | Port | Override Env Var |
|---------|------|-----------------|
| Main server | PORT | `PORT` |
| TTS server | PORT + 1 | `TTS_PORT` |
| GPU Manager | PORT + 2 | `GPU_MANAGER_PORT` |

## Environment Variables

See `.env.example` for all available variables with defaults and descriptions.

## Troubleshooting

### Port already in use
Change `PORT` in `.env.local` (e.g., `PORT=4000`). TTS and GPU Manager ports adjust automatically.

### Python not found
Install Python 3.10+. On Windows, ensure Python is in PATH. Or set `GPU_MANAGER_PYTHON` to the full path.

### PyTorch CUDA mismatch / RTX 50-series (Blackwell, sm_120)
`setup.js` auto-detects a CUDA tag only up to `cu124`. RTX 50xx GPUs need `cu126` or newer (`cu130` recommended) — install manually:
```bash
# In gpu-manager/venv:
pip install torch --index-url https://download.pytorch.org/whl/cu130  # RTX 50xx / CUDA 13
pip install torch --index-url https://download.pytorch.org/whl/cu124  # for CUDA 12.4+
pip install torch --index-url https://download.pytorch.org/whl/cu121  # for CUDA 12.1+
pip install torch --index-url https://download.pytorch.org/whl/cpu    # CPU only
```

### ComfyUI connection failed
1. Ensure ComfyUI is running — either start it yourself (`python main.py` in the ComfyUI directory) or set `COMFYUI_DIR` + `COMFYUI_AUTOSTART=true` in `.env.local` so `server.ts` spawns it on boot (skipped if the port is already in use)
2. Check host/port match (default: `127.0.0.1:8188`)
3. Test: `curl http://127.0.0.1:8188/system_stats`

### npm install fails
Delete `node_modules/` and `package-lock.json`, then retry:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Server won't start after setup
Delete `.next/` cache and rebuild:
```bash
rm -rf .next
npm run build
npm run start
```
