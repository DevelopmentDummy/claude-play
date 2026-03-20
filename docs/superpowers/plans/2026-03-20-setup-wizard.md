# Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a three-phase setup system (CLI script, web wizard, AI guide) to streamline Claude Bridge deployment.

**Architecture:** CLI `setup.js` (pure JS, zero deps) handles infrastructure bootstrap (npm install, Python venv, PyTorch, ComfyUI, ports). Web wizard at `/setup` handles service configuration (admin password, ComfyUI connection, API keys, TTS). `server.ts` intercepts requests to redirect to `/setup` when `data/.setup-complete` is missing. Port allocation is derived from `PORT` env var: main=PORT, TTS=PORT+1, GPU Manager=PORT+2.

**Tech Stack:** Node.js (vanilla JS for setup.js), Next.js 15 App Router (React 19, Tailwind CSS 3, TypeScript), existing auth system (HMAC-SHA256).

**Spec:** `docs/superpowers/specs/2026-03-20-setup-wizard-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `setup.js` | CLI bootstrap script — Node/Python/PyTorch/ComfyUI setup, .env.local creation, port config, data/ init |
| `.env.example` | Reference template of all environment variables with defaults and descriptions |
| `SETUP.md` | AI agent-readable setup guide with exact commands, expected outputs, success criteria |
| `src/app/setup/page.tsx` | Web wizard UI — multi-step form (password, ComfyUI, API keys, TTS, confirm) |
| `src/app/api/setup/status/route.ts` | GET: return current config status (which services configured, which missing) |
| `src/app/api/setup/save/route.ts` | POST: write .env.local + create .setup-complete + trigger restart |
| `src/app/api/setup/test-comfyui/route.ts` | POST: test ComfyUI connection at given host:port |
| `src/app/api/setup/test-gemini/route.ts` | POST: validate Gemini API key via lightweight API call |
| `src/lib/env-file.ts` | Utility for reading/writing .env.local (parse, update, atomic write) |
| `src/lib/setup-guard.ts` | Shared logic: check .setup-complete existence, setup auth guard |

### Modified Files
| File | Changes |
|------|---------|
| `server.ts` | Add /setup redirect logic, port auto-calculation (PORT+1, PORT+2), restart mechanism |
| `src/middleware.ts` | Add /setup and /api/setup/* to auth exclusion list during initial setup |

---

## Task 1: `.env.example` 및 환경변수 유틸리티

**Files:**
- Create: `.env.example`
- Create: `src/lib/env-file.ts`

- [ ] **Step 1: `.env.example` 생성**

```env
# Claude Bridge Configuration
# Copy this to .env.local and fill in your values

# === Core ===
PORT=3340                    # Main server port (TTS=PORT+1, GPU Manager=PORT+2)
DATA_DIR=./data              # Data directory path

# === Authentication ===
ADMIN_PASSWORD=              # Admin login password (leave empty to disable auth)

# === ComfyUI (optional) ===
COMFYUI_HOST=127.0.0.1       # ComfyUI host
COMFYUI_PORT=8188             # ComfyUI port

# === API Keys (optional) ===
GEMINI_API_KEY=               # Gemini image generation API key
CIVITAI_API_KEY=              # CivitAI model download API key

# === TTS ===
TTS_ENABLED=true              # Enable/disable TTS globally

# === Advanced (usually no need to change) ===
# TTS_PORT=                   # Override TTS port (default: PORT+1)
# GPU_MANAGER_PORT=           # Override GPU Manager port (default: PORT+2)
# GPU_MANAGER_PYTHON=python   # Python executable for GPU Manager
```

- [ ] **Step 2: `src/lib/env-file.ts` 작성 — .env.local 읽기/쓰기 유틸리티**

```typescript
// src/lib/env-file.ts
import fs from "fs";
import path from "path";

const ENV_PATH = path.join(process.cwd(), ".env.local");

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (only outside quotes)
    const value = stripQuotes(raw.startsWith('"') || raw.startsWith("'") ? raw : raw.replace(/\s+#.*$/, ""));
    result[key] = value;
  }
  return result;
}

export function writeEnvFile(values: Record<string, string>): void {
  // Read existing to preserve comments and ordering
  const existingLines: string[] = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf-8").split("\n")
    : [];

  const remaining = { ...values };
  const outputLines: string[] = [];

  // Update existing keys in-place
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outputLines.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) { outputLines.push(line); continue; }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in remaining) {
      const v = remaining[key];
      outputLines.push(v.includes(" ") || v.includes("#") ? `${key}="${v}"` : `${key}=${v}`);
      delete remaining[key];
    } else {
      outputLines.push(line);
    }
  }

  // Append new keys
  for (const [key, value] of Object.entries(remaining)) {
    outputLines.push(value.includes(" ") || value.includes("#") ? `${key}="${value}"` : `${key}=${value}`);
  }

  // Atomic write: write to temp, then rename
  const tmpPath = ENV_PATH + ".tmp";
  fs.writeFileSync(tmpPath, outputLines.join("\n"), "utf-8");
  fs.renameSync(tmpPath, ENV_PATH);
}

export function getEnvPath(): string {
  return ENV_PATH;
}
```

- [ ] **Step 3: Commit**

```bash
git add .env.example src/lib/env-file.ts
git commit -m "feat: add .env.example template and env-file read/write utility"
```

---

## Task 2: 셋업 가드 및 server.ts 수정

**Files:**
- Create: `src/lib/setup-guard.ts`
- Modify: `server.ts` (port auto-calculation + /setup redirect)
- Modify: `src/middleware.ts` (setup route exclusions)

- [ ] **Step 1: `src/lib/setup-guard.ts` 작성**

```typescript
// src/lib/setup-guard.ts
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "./data-dir";
import { verifyAuthToken, parseCookieToken } from "./auth";

export function isSetupComplete(): boolean {
  return fs.existsSync(path.join(getDataDir(), ".setup-complete"));
}

export function markSetupComplete(): void {
  const dir = getDataDir();
  fs.writeFileSync(path.join(dir, ".setup-complete"), new Date().toISOString(), "utf-8");
}

const SETUP_EXCLUDE = ["/setup", "/api/setup", "/_next", "/favicon.ico"];

export function shouldRedirectToSetup(pathname: string): boolean {
  if (isSetupComplete()) return false;
  return !SETUP_EXCLUDE.some((prefix) => pathname.startsWith(prefix));
}

/** Returns 401 response if setup is complete and request is not authenticated. null = OK. */
export function requireSetupAuth(req: NextRequest): NextResponse | null {
  if (!isSetupComplete()) return null; // During initial setup, no auth needed
  if (!process.env.ADMIN_PASSWORD) return null; // No password set, no auth
  const token = parseCookieToken(req.headers.get("cookie") || undefined);
  if (token && verifyAuthToken(token)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

- [ ] **Step 2: `server.ts` — 포트 자동 계산 적용**

현재 코드 (lines 13-16):
```typescript
const port = parseInt(process.env.PORT || "3340", 10);
const ttsPort = parseInt(process.env.TTS_PORT || "3341", 10);
const GPU_MANAGER_PORT = parseInt(process.env.GPU_MANAGER_PORT || "3342", 10);
```

변경:
```typescript
const port = parseInt(process.env.PORT || "3340", 10);
const ttsPort = parseInt(process.env.TTS_PORT || String(port + 1), 10);
const GPU_MANAGER_PORT = parseInt(process.env.GPU_MANAGER_PORT || String(port + 2), 10);
```

- [ ] **Step 3: `server.ts` — /setup 리다이렉트 로직 추가**

`server.on("request", ...)` 핸들러 최상단에 추가 (기존 route interception 이전):

```typescript
import { shouldRedirectToSetup } from "./src/lib/setup-guard";

// Inside request handler, before TTS route interception:
const parsedUrl = new URL(req.url || "/", `http://localhost:${port}`);
if (shouldRedirectToSetup(parsedUrl.pathname)) {
  res.writeHead(302, { Location: "/setup" });
  res.end();
  return;
}
```

- [ ] **Step 4: `src/middleware.ts` — 초기 셋업 중에만 예외 처리**

`/api/setup/*` 라우트는 자체 auth guard (`requireSetupAuth`)가 있으므로 middleware에서는 항상 통과시킴.
`/setup` 페이지는 server.ts에서 이미 리다이렉트 처리. 셋업 완료 후 `/setup` 접근은 middleware 인증을 거침 (기존 로직 유지).

```typescript
// Add to the early-return conditions (alongside /api/auth/* checks):
// Setup API routes have their own auth guard (requireSetupAuth)
if (pathname.startsWith("/api/setup")) {
  return NextResponse.next();
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/setup-guard.ts server.ts src/middleware.ts
git commit -m "feat: add setup guard, /setup redirect in server.ts, port auto-calculation"
```

---

## Task 3: 셋업 API 엔드포인트

**Files:**
- Create: `src/app/api/setup/status/route.ts`
- Create: `src/app/api/setup/save/route.ts`
- Create: `src/app/api/setup/test-comfyui/route.ts`
- Create: `src/app/api/setup/test-gemini/route.ts`

- [ ] **Step 1: `GET /api/setup/status` — 현재 설정 상태 반환**

```typescript
// src/app/api/setup/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import { readEnvFile } from "@/lib/env-file";
import { isSetupComplete, requireSetupAuth } from "@/lib/setup-guard";

export async function GET(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const env = readEnvFile();
  return NextResponse.json({
    setupComplete: isSetupComplete(),
    adminPassword: !!env.ADMIN_PASSWORD,
    comfyui: !!(env.COMFYUI_HOST || env.COMFYUI_PORT),
    comfyuiHost: env.COMFYUI_HOST || "127.0.0.1",
    comfyuiPort: env.COMFYUI_PORT || "8188",
    geminiKey: !!env.GEMINI_API_KEY,
    civitaiKey: !!env.CIVITAI_API_KEY,
    ttsEnabled: env.TTS_ENABLED !== "false",
    port: env.PORT || "3340",
  });
}
```

- [ ] **Step 2: `POST /api/setup/save` — 설정 저장 + 재시작**

```typescript
// src/app/api/setup/save/route.ts
import { NextRequest, NextResponse } from "next/server";
import { writeEnvFile, readEnvFile } from "@/lib/env-file";
import { isSetupComplete, markSetupComplete, requireSetupAuth } from "@/lib/setup-guard";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  // After initial setup, require auth
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const body = await req.json();
  const updates: Record<string, string> = {};

  if (body.adminPassword) updates.ADMIN_PASSWORD = body.adminPassword;
  if (body.comfyuiHost) updates.COMFYUI_HOST = body.comfyuiHost;
  if (body.comfyuiPort) updates.COMFYUI_PORT = body.comfyuiPort;
  if (body.geminiKey) updates.GEMINI_API_KEY = body.geminiKey;
  if (body.civitaiKey) updates.CIVITAI_API_KEY = body.civitaiKey;
  if (body.ttsEnabled !== undefined) updates.TTS_ENABLED = String(body.ttsEnabled);
  if (body.port) updates.PORT = body.port;

  // Merge with existing
  const existing = readEnvFile();
  writeEnvFile({ ...existing, ...updates });

  // Update process.env immediately
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }

  // Mark setup complete
  markSetupComplete();

  // Trigger restart: touch server.ts for dev mode (tsx watch),
  // or schedule process exit for production
  const triggerPath = path.join(process.cwd(), ".restart-trigger");
  fs.writeFileSync(triggerPath, Date.now().toString(), "utf-8");

  if (process.env.NODE_ENV === "production") {
    // Give time for response to be sent, then exit
    setTimeout(() => process.exit(0), 500);
  }

  return NextResponse.json({ ok: true, restart: true });
}
```

- [ ] **Step 3: `POST /api/setup/test-comfyui` — ComfyUI 연결 테스트**

```typescript
// src/app/api/setup/test-comfyui/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSetupAuth } from "@/lib/setup-guard";

export async function POST(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const { host, port } = await req.json();
  const url = `http://${host || "127.0.0.1"}:${port || 8188}/system_stats`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data });
    }
    return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Connection failed";
    return NextResponse.json({ ok: false, error: msg });
  }
}
```

- [ ] **Step 4: `POST /api/setup/test-gemini` — Gemini API 키 검증**

```typescript
// src/app/api/setup/test-gemini/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireSetupAuth } from "@/lib/setup-guard";

export async function POST(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const { key } = await req.json();
  if (!key) return NextResponse.json({ ok: false, error: "No key provided" });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: `API returned ${res.status}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Validation failed";
    return NextResponse.json({ ok: false, error: msg });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/setup/
git commit -m "feat: add setup API endpoints (status, save, test-comfyui, test-gemini)"
```

---

## Task 4: 웹 셋업 마법사 UI

**Files:**
- Create: `src/app/setup/page.tsx`

- [ ] **Step 1: 웹 마법사 UI 구현**

`src/app/setup/page.tsx` — Multi-step wizard with 5 steps:
1. Admin password (input + confirm)
2. ComfyUI connection (toggle, host/port, "start service then test" button)
3. API keys (Gemini toggle+input+verify, CivitAI toggle+input)
4. TTS settings (Edge TTS toggle, Local TTS toggle)
5. Summary + complete

**UI 일관성 기준** (기존 login 페이지 스타일):
- CSS custom properties: `var(--bg)`, `var(--surface)`, `var(--accent)`, `var(--text)`, `var(--border)`
- Form container: max-width 480px (wizard는 login보다 넓게), centered
- Inputs: 14px font, 10px padding, 8px border-radius
- Buttons: accent background, white text
- Step indicator: 상단에 1-2-3-4-5 프로그레스 바

**핵심 로직:**
- 각 step은 state로 관리, Next/Back 네비게이션
- ComfyUI 연결 테스트: `POST /api/setup/test-comfyui` 호출, "서비스를 실행 후 버튼을 눌러주세요" 안내
- Gemini 키 검증: `POST /api/setup/test-gemini` 호출, 즉시 결과 표시
- 완료: `POST /api/setup/save`로 전체 설정 저장 → 폴링으로 서버 복귀 감지 → 홈 이동
- 재설정 모드 (setup-complete 이후 /setup 접속): 기존 값을 `/api/setup/status`에서 로드

**frontend-design 스킬 사용**: 이 step은 `/frontend-design` 스킬을 사용하여 구현할 것.

- [ ] **Step 2: Commit**

```bash
git add src/app/setup/
git commit -m "feat: add web setup wizard UI with 5-step configuration flow"
```

---

## Task 5: 서버 재시작 메커니즘

**Files:**
- Modify: `server.ts` (restart trigger handling)
- Modify: `package.json` (tsx watch ignore pattern)

- [ ] **Step 1: `package.json` dev 스크립트 수정 — `.restart-trigger` 감시 추가**

`tsx watch`는 `server.ts`의 import 그래프만 감시하므로, `.restart-trigger`를 명시적으로 watch 대상에 추가해야 합니다.

현재:
```json
"dev": "tsx watch --ignore ./data/** --ignore ./.next/** server.ts"
```

변경:
```json
"dev": "tsx watch --watch .restart-trigger --ignore ./data/** --ignore ./.next/** server.ts"
```

Production 모드에서는 `POST /api/setup/save`의 `setTimeout(() => process.exit(0), 500)` 처리. 프로덕션 배포 시 pm2 등 프로세스 매니저 사용 권장.

- [ ] **Step 2: `.restart-trigger`를 `.gitignore`에 추가**

```bash
echo ".restart-trigger" >> .gitignore
```

- [ ] **Step 3: 프론트엔드 재시작 폴링 로직 확인**

`src/app/setup/page.tsx`의 완료 step에서:
```typescript
// After save response, poll until server is back
const pollUntilReady = async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch("/api/setup/status");
      if (res.ok) { window.location.href = "/"; return; }
    } catch {}
  }
  // Fallback: show manual reload message
};
```

- [ ] **Step 4: Commit**

```bash
git add server.ts .gitignore
git commit -m "feat: add restart trigger mechanism for setup wizard"
```

---

## Task 6: CLI 셋업 스크립트 (`setup.js`)

**Files:**
- Create: `setup.js`

이 파일은 크므로 섹션별로 구현합니다.

- [ ] **Step 1: 기본 구조 + readline 헬퍼 + --yes 플래그**

```javascript
#!/usr/bin/env node
// setup.js — Claude Bridge Setup (pure JS, zero dependencies)

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

const AUTO_YES = process.argv.includes("--yes");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question, defaultValue = "") {
  if (AUTO_YES && defaultValue !== undefined) {
    console.log(`  ${question} ${defaultValue} (auto)`);
    return Promise.resolve(defaultValue);
  }
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => resolve(answer.trim() || defaultValue));
  });
}
function confirm(question, defaultYes = true) {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  if (AUTO_YES) {
    console.log(`  ${question} ${hint} Y (auto)`);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint} `, (a) => {
      const answer = a.trim().toLowerCase();
      resolve(defaultYes ? answer !== "n" : answer === "y");
    });
  });
}
function run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: "utf-8", stdio: opts.silent ? "pipe" : "inherit", ...opts }); }
  catch { return null; }
}
function header(text) { console.log(`\n${"=".repeat(50)}\n  ${text}\n${"=".repeat(50)}`); }
function info(text) { console.log(`  ✓ ${text}`); }
function warn(text) { console.log(`  ⚠ ${text}`); }
function error(text) { console.log(`  ✗ ${text}`); }
```

- [ ] **Step 2: Step 1-2 — Node.js 체크 + npm install**

```javascript
async function stepNodeCheck() {
  header("Step 1: Node.js Version Check");
  const ver = process.versions.node;
  const major = parseInt(ver.split(".")[0], 10);
  if (major < 18) { error(`Node.js 18+ required (found ${ver})`); process.exit(1); }
  info(`Node.js ${ver} — OK`);
}

async function stepNpmInstall() {
  header("Step 2: Installing Dependencies");
  const result = run("npm install");
  if (result === null) { error("npm install failed"); process.exit(1); }
  info("Dependencies installed");
}
```

- [ ] **Step 3: Step 3-5 — Python + venv + PyTorch**

```javascript
function findPython() {
  for (const cmd of ["python", "python3"]) {
    const out = run(`${cmd} --version`, { silent: true });
    if (out) return cmd;
  }
  return null;
}

async function stepPython() {
  header("Step 3: Python Check");
  const python = findPython();
  if (!python) {
    warn("Python not found. GPU Manager (local TTS, image gen) will not work.");
    if (!await confirm("Continue without Python?")) process.exit(0);
    return null;
  }
  const ver = run(`${python} --version`, { silent: true }).trim();
  info(`${ver} — OK`);
  return python;
}

async function stepVenv(python) {
  if (!python) return null;
  header("Step 4: Python Virtual Environment");
  const venvDir = path.join(__dirname, "gpu-manager", "venv");
  if (fs.existsSync(venvDir)) {
    info("venv already exists — skipping creation");
  } else {
    run(`${python} -m venv "${venvDir}"`);
    if (!fs.existsSync(venvDir)) { error("Failed to create venv"); return null; }
    info("venv created");
  }
  const pip = os.platform() === "win32"
    ? path.join(venvDir, "Scripts", "pip")
    : path.join(venvDir, "bin", "pip");
  run(`"${pip}" install -r "${path.join(__dirname, "gpu-manager", "requirements.txt")}"`);
  info("Python dependencies installed");
  return pip;
}

async function stepPyTorch(pip) {
  if (!pip) return;
  header("Step 5: PyTorch GPU Setup");
  // Detect CUDA
  const nvidiaSmi = run("nvidia-smi --query-gpu=driver_version,memory.total --format=csv,noheader", { silent: true });
  if (!nvidiaSmi) {
    warn("No NVIDIA GPU detected — installing CPU-only PyTorch");
    run(`"${pip}" install torch --index-url https://download.pytorch.org/whl/cpu`);
    info("PyTorch (CPU) installed");
    return { hasGpu: false, vram: 0 };
  }

  // Parse VRAM
  const vramMatch = nvidiaSmi.match(/(\d+)\s*MiB/);
  const vramMB = vramMatch ? parseInt(vramMatch[1], 10) : 0;
  info(`GPU detected — VRAM: ${vramMB} MB`);

  // Detect CUDA version
  const cudaOut = run("nvidia-smi", { silent: true });
  const cudaMatch = cudaOut?.match(/CUDA Version:\s*([\d.]+)/);
  const cudaVer = cudaMatch ? parseFloat(cudaMatch[1]) : 0;

  let cudaTag = "cpu";
  if (cudaVer >= 12.4) cudaTag = "cu124";
  else if (cudaVer >= 12.1) cudaTag = "cu121";
  else if (cudaVer >= 11.8) cudaTag = "cu118";

  if (cudaTag !== "cpu") {
    info(`CUDA ${cudaVer} detected → PyTorch ${cudaTag}`);
    if (await confirm(`Install PyTorch with ${cudaTag} support?`)) {
      run(`"${pip}" install torch --index-url https://download.pytorch.org/whl/${cudaTag}`);
      info(`PyTorch (${cudaTag}) installed`);
    }
  } else {
    warn(`CUDA ${cudaVer} — no matching PyTorch build. Installing CPU version.`);
    run(`"${pip}" install torch --index-url https://download.pytorch.org/whl/cpu`);
  }

  return { hasGpu: true, vram: vramMB };
}
```

- [ ] **Step 4: Step 6 — ComfyUI 자동 설치**

```javascript
async function stepComfyUI(gpuInfo) {
  if (!gpuInfo?.hasGpu || gpuInfo.vram < 8000) return null;
  header("Step 6: ComfyUI Setup (Optional)");
  info(`VRAM ${gpuInfo.vram} MB — ComfyUI image generation supported`);

  if (!await confirm("Install ComfyUI?", false)) return null;

  const defaultPath = path.resolve(__dirname, "..", "ComfyUI");
  const installPath = await ask(`Install location (default: ${defaultPath}):`, defaultPath);

  if (fs.existsSync(installPath)) {
    info(`ComfyUI already exists at ${installPath}`);
  } else {
    info("Cloning ComfyUI...");
    run(`git clone https://github.com/comfyanonymous/ComfyUI.git "${installPath}"`);
    if (!fs.existsSync(installPath)) { error("Failed to clone ComfyUI"); return null; }
    info("Installing ComfyUI dependencies...");
    const python = findPython();
    run(`${python} -m venv "${path.join(installPath, "venv")}"`);
    const pip = os.platform() === "win32"
      ? path.join(installPath, "venv", "Scripts", "pip")
      : path.join(installPath, "venv", "bin", "pip");
    run(`"${pip}" install -r "${path.join(installPath, "requirements.txt")}"`);
    info("ComfyUI installed");
  }

  // Checkpoint download
  if (await confirm("Download recommended checkpoint model (Illustrious XL)?", false)) {
    const civitaiKey = await ask("CivitAI API key (or press Enter to skip):");
    if (civitaiKey) {
      info("Downloading checkpoint model...");
      const modelsDir = path.join(installPath, "models", "checkpoints");
      fs.mkdirSync(modelsDir, { recursive: true });
      // CivitAI download with API key
      // Model ID for a recommended Illustrious XL variant
      const modelUrl = `https://civitai.com/api/download/models/1215564?token=${civitaiKey}`;
      run(`curl -L -o "${path.join(modelsDir, "illustrious-xl.safetensors")}" "${modelUrl}"`, { timeout: 600000 });
      info("Checkpoint downloaded");
    } else {
      warn("No CivitAI key — download models manually to ComfyUI/models/checkpoints/");
    }
  }

  return installPath;
}
```

- [ ] **Step 5: Step 7-12 — Claude CLI, 포트, .env.local, data/ 초기화, 완료**

```javascript
async function stepClaudeCLI() {
  header("Step 7: Claude Code CLI Check");
  const out = run("claude --version", { silent: true });
  if (out) { info(`Claude Code CLI ${out.trim()} — OK`); }
  else { warn("Claude Code CLI not found. Install it from https://claude.ai/code"); }
}

async function stepPort() {
  header("Step 8: Port Configuration");
  const portStr = await ask("Main server port (default: 3340):", "3340");
  const port = parseInt(portStr, 10) || 3340;
  info(`Main: ${port}, TTS: ${port + 1}, GPU Manager: ${port + 2}`);
  return port;
}

async function stepEnvLocal(port, comfyuiPath) {
  header("Step 9: Environment Configuration");
  const envPath = path.join(__dirname, ".env.local");
  if (fs.existsSync(envPath)) {
    info(".env.local already exists — skipping");
    return;
  }
  const lines = [
    `PORT=${port}`,
    `DATA_DIR=./data`,
    `ADMIN_PASSWORD=`,
    `TTS_ENABLED=true`,
  ];
  if (comfyuiPath) {
    lines.push(`COMFYUI_HOST=127.0.0.1`);
    lines.push(`COMFYUI_PORT=8188`);
  }
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  info(".env.local created");
}

async function stepPortCheck(port) {
  header("Step 10: Port Conflict Check");
  for (const [name, p] of [["Main", port], ["TTS", port + 1], ["GPU Manager", port + 2]]) {
    const check = os.platform() === "win32"
      ? run(`netstat -ano | findstr ":${p} " | findstr "LISTENING"`, { silent: true })
      : run(`lsof -i :${p} -t`, { silent: true });
    if (check?.trim()) {
      warn(`Port ${p} (${name}) is in use`);
    } else {
      info(`Port ${p} (${name}) — available`);
    }
  }
}

async function stepDataDir() {
  header("Step 11: Data Directory");
  const dataDir = path.join(__dirname, "data");
  for (const sub of ["personas", "sessions", "profiles", "tools"]) {
    const dir = path.join(dataDir, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  info("data/ directory initialized");
}

async function main() {
  console.log("\n  Claude Bridge Setup\n");
  await stepNodeCheck();
  await stepNpmInstall();
  const python = await stepPython();
  const pip = await stepVenv(python);
  const gpuInfo = await stepPyTorch(pip);
  const comfyuiPath = await stepComfyUI(gpuInfo);
  await stepClaudeCLI();
  const port = await stepPort();
  await stepEnvLocal(port, comfyuiPath);
  await stepPortCheck(port);
  await stepDataDir();

  header("Setup Complete!");
  console.log(`
  To start in development mode:
    npm run dev

  To start in production mode:
    npm run build && npm run start

  Then open http://localhost:${port} in your browser
  to complete the web setup wizard.
`);
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Commit**

```bash
git add setup.js
git commit -m "feat: add CLI setup script with full bootstrap flow"
```

---

## Task 7: AI 셋업 가이드 (`SETUP.md`)

**Files:**
- Create: `SETUP.md`

- [ ] **Step 1: SETUP.md 작성**

CLI 셋업의 각 단계별 실행 명령어, 예상 프롬프트/응답, 성공 기준을 포함한 문서 작성.
웹 셋업 마법사의 각 step별 API 호출 방법과 필수 입력값 문서화.
헬스체크 엔드포인트와 트러블슈팅 섹션 포함.

핵심: AI 에이전트가 `--yes` 플래그로 CLI를 자동 실행하고, 웹 셋업은 API를 직접 호출하여 완료할 수 있도록 API 기반 설정 방법도 기술.

```markdown
# Claude Bridge Setup Guide

> This guide is designed for both humans and AI agents.
> AI agents: use `node setup.js --yes` for non-interactive mode,
> then call the setup APIs directly.

## Prerequisites
- Node.js 18+ (`node --version`)
- Python 3.10+ (optional, for GPU Manager)
- Git (for ComfyUI installation)

## Quick Start

### 1. CLI Setup
    node setup.js
    # Or non-interactive: node setup.js --yes

Expected output: step-by-step progress with ✓/⚠/✗ markers.
Success: ends with "Setup Complete!" message.

### 2. Start Server
    npm run dev          # Development
    npm run build && npm run start  # Production

Verify: `curl http://localhost:3340/api/setup/status` returns JSON.

### 3. Web Setup (Browser)
Open http://localhost:3340 — auto-redirects to /setup.

### 3-alt. API Setup (AI Agents)
    # Save all settings at once:
    curl -X POST http://localhost:3340/api/setup/save \
      -H "Content-Type: application/json" \
      -d '{"adminPassword":"...","ttsEnabled":true}'

    # Test ComfyUI connection:
    curl -X POST http://localhost:3340/api/setup/test-comfyui \
      -H "Content-Type: application/json" \
      -d '{"host":"127.0.0.1","port":8188}'

## Health Checks
- Main server: GET http://localhost:{PORT}/api/setup/status
- GPU Manager: GET http://localhost:{PORT+2}/health
- TTS: POST http://localhost:{PORT+1}/synthesize (with body)

## Troubleshooting
- Port in use: change PORT in .env.local
- Python not found: install Python 3.10+ or set GPU_MANAGER_PYTHON
- PyTorch CUDA mismatch: reinstall with correct CUDA tag
- ComfyUI connection failed: ensure ComfyUI is running first
```

- [ ] **Step 2: Commit**

```bash
git add SETUP.md
git commit -m "docs: add AI-readable setup guide (SETUP.md)"
```

---

## Task 8: CLAUDE.md 업데이트

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md에 셋업 관련 섹션 추가**

Commands 섹션에 `node setup.js` 추가.
Environment Variables 섹션에 포트 자동 계산 규칙 업데이트 (TTS_PORT/GPU_MANAGER_PORT 기본값이 PORT+1/PORT+2로 변경됨).
Key Conventions에 셋업 마법사 관련 컨벤션 추가 (`.setup-complete` 플래그, `/setup` 리다이렉트 등).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with setup wizard conventions and port auto-calculation"
```
