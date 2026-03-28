# Claude Play Setup Guide

> This guide is designed for both humans and AI agents.
> AI agents: use `node setup.js --yes` for non-interactive mode, then call the setup APIs directly.

## Prerequisites

- **Node.js 18+** — `node --version`
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
| 1 | Node.js version check (18+) | Yes |
| 2 | `npm install` | Yes |
| 3 | Python detection | No |
| 4 | Python venv + dependencies in `gpu-manager/` | No |
| 5 | PyTorch GPU setup (CUDA auto-detect) | No |
| 6 | ComfyUI clone + setup (if VRAM >= 8GB) | No |
| 7 | Claude Code CLI check | No |
| 8 | Port configuration | Yes |
| 9 | `.env.local` creation | Yes |
| 10 | Port conflict check | Info only |
| 11 | `data/` directory initialization | Yes |

**Expected prompts (--yes mode uses defaults):**
- "Continue without Python?" → Y
- "Install PyTorch with cuXXX support?" → Y
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

Expected response:
```json
{"setupComplete":false,"adminPassword":false,"comfyui":false,...}
```

### 3. Web Setup (Browser)

Open `http://localhost:3340` — auto-redirects to `/setup` wizard.

**Wizard steps:**
1. Set admin password
2. Configure ComfyUI connection (optional — start ComfyUI first)
3. Enter API keys: Gemini (optional), CivitAI (optional)
4. Enable/disable TTS providers
5. Review and save

### 3-alt. API Setup (AI Agents)

Skip the browser wizard by calling APIs directly:

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

**After save:** Server restarts automatically. Wait ~5 seconds, then verify:
```bash
curl http://localhost:3340/api/setup/status
```
Expected: `{"setupComplete":true,...}`

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

### PyTorch CUDA mismatch
Reinstall with the correct CUDA tag:
```bash
# In gpu-manager/venv:
pip install torch --index-url https://download.pytorch.org/whl/cu124  # for CUDA 12.4+
pip install torch --index-url https://download.pytorch.org/whl/cu121  # for CUDA 12.1+
pip install torch --index-url https://download.pytorch.org/whl/cu118  # for CUDA 11.8+
pip install torch --index-url https://download.pytorch.org/whl/cpu    # CPU only
```

### ComfyUI connection failed
1. Ensure ComfyUI is running (`python main.py` in ComfyUI directory)
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
