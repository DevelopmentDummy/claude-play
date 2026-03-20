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

async function stepNodeCheck() {
  header("Step 1: Node.js Version Check");
  const ver = process.versions.node;
  const major = parseInt(ver.split(".")[0], 10);
  if (major < 18) { error(`Node.js 18+ required (found ${ver})`); process.exit(1); }
  info(`Node.js ${ver}`);
}

async function stepNpmInstall() {
  header("Step 2: Installing Dependencies");
  // Check if node_modules exists after install (npm may return non-zero for audit warnings)
  run("npm install");
  if (!fs.existsSync(path.join(__dirname, "node_modules"))) { error("npm install failed"); process.exit(1); }
  info("Dependencies installed");
}

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
  info(`${ver}`);
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
  info("Installing Python dependencies...");
  run(`"${pip}" install -r "${path.join(__dirname, "gpu-manager", "requirements.txt")}"`);
  info("Python dependencies installed");
  return pip;
}

async function stepGpuDetect() {
  header("Step 5: GPU Detection");
  const nvidiaSmi = run("nvidia-smi --query-gpu=driver_version,memory.total --format=csv,noheader", { silent: true });
  if (!nvidiaSmi) {
    warn("No NVIDIA GPU detected");
    return { hasGpu: false, vram: 0, cudaTag: "cpu" };
  }
  const vramMatch = nvidiaSmi.match(/(\d+)\s*MiB/);
  const vramMB = vramMatch ? parseInt(vramMatch[1], 10) : 0;
  const cudaOut = run("nvidia-smi", { silent: true });
  const cudaMatch = cudaOut ? cudaOut.match(/CUDA Version:\s*([\d.]+)/) : null;
  const cudaVer = cudaMatch ? parseFloat(cudaMatch[1]) : 0;
  let cudaTag = "cpu";
  if (cudaVer >= 12.4) cudaTag = "cu124";
  else if (cudaVer >= 12.1) cudaTag = "cu121";
  else if (cudaVer >= 11.8) cudaTag = "cu118";
  info(`GPU: ${vramMB} MB VRAM, CUDA ${cudaVer} → ${cudaTag}`);
  return { hasGpu: true, vram: vramMB, cudaTag };
}

async function stepLocalTTS(pip, gpuInfo) {
  if (!pip || !gpuInfo.hasGpu) return;
  header("Step 6: Local TTS (Optional)");
  info("Qwen3-TTS — 음성 클로닝, GPU 음성 합성");
  warn("설치 시 약 1.5GB의 디스크 공간이 필요합니다 (PyTorch + Qwen3-TTS)");
  if (!await confirm("Local TTS를 설치하시겠습니까?", false)) return;

  info("Installing PyTorch...");
  if (gpuInfo.cudaTag !== "cpu") {
    run(`"${pip}" install torch --index-url https://download.pytorch.org/whl/${gpuInfo.cudaTag}`);
    info(`PyTorch (${gpuInfo.cudaTag}) installed`);
  } else {
    run(`"${pip}" install torch --index-url https://download.pytorch.org/whl/cpu`);
    info("PyTorch (CPU) installed");
  }

  info("Installing TTS dependencies...");
  run(`"${pip}" install -r "${path.join(__dirname, "gpu-manager", "requirements-tts.txt")}"`);
  info("Local TTS installed");
}

async function stepComfyUI(gpuInfo) {
  if (!gpuInfo || !gpuInfo.hasGpu || gpuInfo.vram < 8000) return false;
  header("Step 7: ComfyUI Setup (Optional)");
  info(`VRAM ${gpuInfo.vram} MB — ComfyUI image generation supported`);

  const submodulePath = path.join(__dirname, "comfyui_submodule");

  // Already installed as submodule?
  if (fs.existsSync(path.join(submodulePath, "main.py"))) {
    info("ComfyUI submodule already installed");
    return true;
  }

  if (await confirm("시스템에 ComfyUI가 이미 설치되어 있나요?")) {
    info("웹 셋업 마법사에서 ComfyUI 호스트/포트를 설정할 수 있습니다.");
    return true;
  }

  if (!await confirm("ComfyUI를 설치하시겠습니까?", false)) return false;

  info("Adding ComfyUI as git submodule...");
  const cloneResult = run(`git submodule add https://github.com/comfyanonymous/ComfyUI.git comfyui_submodule`);
  if (cloneResult === null || !fs.existsSync(path.join(submodulePath, "main.py"))) {
    error("Failed to add ComfyUI submodule");
    return false;
  }

  info("Installing ComfyUI dependencies...");
  const python = findPython();
  run(`${python} -m venv "${path.join(submodulePath, "venv")}"`);
  const comfyPip = os.platform() === "win32"
    ? path.join(submodulePath, "venv", "Scripts", "pip")
    : path.join(submodulePath, "venv", "bin", "pip");
  const pipResult = run(`"${comfyPip}" install -r "${path.join(submodulePath, "requirements.txt")}"`);
  if (pipResult === null) {
    warn("ComfyUI dependency installation failed. You may need to install them manually.");
  } else {
    info("ComfyUI installed");
  }

  if (await confirm("Download recommended checkpoint model (Illustrious XL)?", false)) {
    const civitaiKey = await ask("CivitAI API key (or press Enter to skip):");
    if (civitaiKey) {
      info("Downloading checkpoint model... (this may take a while)");
      const modelsDir = path.join(submodulePath, "models", "checkpoints");
      fs.mkdirSync(modelsDir, { recursive: true });
      const modelUrl = `https://civitai.com/api/download/models/1215564?token=${civitaiKey}`;
      const dlResult = run(`curl -L -o "${path.join(modelsDir, "illustrious-xl.safetensors")}" "${modelUrl}"`, { timeout: 600000 });
      if (dlResult === null) {
        warn("Download failed. You can download models manually later.");
      } else {
        info("Checkpoint downloaded");
      }
    } else {
      warn("No CivitAI key — download models manually to comfyui_submodule/models/checkpoints/");
    }
  }

  return true;
}

async function stepClaudeCLI() {
  header("Step 8: Claude Code CLI Check");
  const out = run("claude --version", { silent: true });
  if (out) { info(`Claude Code CLI ${out.trim()}`); }
  else { warn("Claude Code CLI not found. Install from https://claude.ai/code"); }
}

async function stepPort() {
  header("Step 9: Port Configuration");
  const portStr = await ask("Main server port (default: 3340):", "3340");
  const port = parseInt(portStr, 10) || 3340;
  info(`Main: ${port}, TTS: ${port + 1}, GPU Manager: ${port + 2}`);
  return port;
}

async function stepEnvLocal(port, hasComfyUI) {
  header("Step 10: Environment Configuration");
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
  if (hasComfyUI) {
    lines.push(`COMFYUI_HOST=127.0.0.1`);
    lines.push(`COMFYUI_PORT=8188`);
  }
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  info(".env.local created");
}

async function stepPortCheck(port) {
  header("Step 11: Port Conflict Check");
  for (const [name, p] of [["Main", port], ["TTS", port + 1], ["GPU Manager", port + 2]]) {
    const check = os.platform() === "win32"
      ? run(`netstat -ano | findstr ":${p} " | findstr "LISTENING"`, { silent: true })
      : run(`lsof -i :${p} -t`, { silent: true });
    if (check && check.trim()) {
      warn(`Port ${p} (${name}) is in use`);
    } else {
      info(`Port ${p} (${name}) — available`);
    }
  }
}

const COPY_SKIP = new Set([".git", ".claude", ".codex", ".mcp.json"]);
function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function stepDataDir() {
  header("Step 12: Data Directory");
  const dataDir = path.join(__dirname, "data");
  for (const sub of ["personas", "sessions", "profiles", "tools"]) {
    const dir = path.join(dataDir, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  info("data/ directory initialized");

  // Copy sample personas if personas dir is empty
  const personasDir = path.join(dataDir, "personas");
  const existing = fs.readdirSync(personasDir).filter(f => !f.startsWith("."));
  if (existing.length === 0) {
    const samplesDir = path.join(dataDir, "sample-personas");
    if (fs.existsSync(samplesDir)) {
      const samples = fs.readdirSync(samplesDir).filter(f => !f.startsWith("."));
      for (const name of samples) {
        copyDirRecursive(path.join(samplesDir, name), path.join(personasDir, name));
      }
      if (samples.length > 0) {
        info(`${samples.length} sample persona(s) installed`);
      }
    }
  }
}

async function main() {
  console.log("\n  Claude Bridge Setup\n");

  await stepNodeCheck();
  await stepNpmInstall();
  const python = await stepPython();
  const pip = await stepVenv(python);
  const gpuInfo = await stepGpuDetect();
  await stepLocalTTS(pip, gpuInfo);
  const hasComfyUI = await stepComfyUI(gpuInfo);
  await stepClaudeCLI();
  const port = await stepPort();
  await stepEnvLocal(port, hasComfyUI);
  await stepPortCheck(port);
  await stepDataDir();

  // Build for production
  header("Building...");
  run("npm run build");
  if (fs.existsSync(path.join(__dirname, ".next"))) {
    info("Build complete");
  } else {
    warn("Build may have failed — you can retry with: npm run build");
  }

  header("Setup Complete!");
  const url = `http://localhost:${port}/setup`;
  info("Starting server and opening web setup wizard...");
  rl.close();

  // Open browser after a delay to let server start
  setTimeout(() => {
    const openCmd = os.platform() === "win32" ? `start "" "${url}"`
      : os.platform() === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
    run(openCmd, { silent: true });
  }, 5000);

  // Start server (this blocks — keeps process alive)
  const { spawn: spawnChild } = require("child_process");
  const server = spawnChild("npm", ["run", "start"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
  });
  server.on("exit", (code) => process.exit(code || 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
