import { spawn, execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const AGY_PATH = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");

interface LSProcess {
  pid: number;
  port: number;
  csrfToken: string;
  commandLine: string;
}

function log(stage: string, data: unknown): void {
  console.log(`[${stage}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

interface PsRow {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string | null;
}

function listAllProcesses(): PsRow[] {
  const out = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Depth 2 -Compress"`,
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as PsRow | PsRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function findLSProcess(rootPid: number): LSProcess | null {
  const all = listAllProcesses();
  const byPid = new Map<number, PsRow>();
  const byParent = new Map<number, PsRow[]>();
  for (const p of all) {
    byPid.set(p.ProcessId, p);
    const arr = byParent.get(p.ParentProcessId) ?? [];
    arr.push(p);
    byParent.set(p.ParentProcessId, arr);
  }
  const visited = new Set<number>();
  const queue: number[] = [rootPid];
  const tryMatch = (row: PsRow | undefined): LSProcess | null => {
    if (!row) return null;
    const cmd = row.CommandLine ?? "";
    if (!cmd.includes("--csrf_token")) return null;
    const cmdMatch = cmd.match(/--csrf_token\s+(\S+)/);
    const portMatch = cmd.match(/--extension_server_port\s+(\d+)/);
    if (!cmdMatch || !portMatch) return null;
    return { pid: row.ProcessId, port: Number(portMatch[1]), csrfToken: cmdMatch[1], commandLine: cmd };
  };
  while (queue.length) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const selfMatch = tryMatch(byPid.get(pid));
    if (selfMatch) return selfMatch;
    for (const c of byParent.get(pid) ?? []) queue.push(c.ProcessId);
  }
  return null;
}

function listListeningPorts(pid: number): number[] {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json -Compress"`,
      { encoding: "utf-8" },
    ).trim();
    if (!out) return [];
    const parsed = JSON.parse(out) as { LocalPort: number } | { LocalPort: number }[];
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((r) => r.LocalPort);
  } catch {
    return [];
  }
}

function startAgyViaPowerShell(): number {
  // -WindowStyle Hidden: 작업표시줄에 console window가 뜨지 않게 한다.
  // console 앱이라 OS가 conhost를 attach하지만 hidden flag로 가려진다.
  const argList = "'--prompt-interactive','spike-init','--dangerously-skip-permissions'";
  const cmd = `powershell -NoProfile -Command "$p = Start-Process -FilePath '${AGY_PATH}' -ArgumentList ${argList} -WorkingDirectory 'C:\\WINDOWS\\System32' -WindowStyle Hidden -PassThru; $p.Id"`;
  const out = execSync(cmd, { encoding: "utf-8" }).trim();
  const pid = Number(out);
  if (!pid || Number.isNaN(pid)) throw new Error(`Failed to parse agy pid from: ${out}`);
  return pid;
}

function killTree(pid: number): void {
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { encoding: "utf-8", stdio: "pipe" });
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  log("spike", "start");
  log("spawn", `Start-Process agy --prompt-interactive spike-init --dangerously-skip-permissions (Minimized window, cwd=System32)`);
  const agyPid = startAgyViaPowerShell();
  log("spawn", { pid: agyPid });

  const proc = { pid: agyPid, kill: () => killTree(agyPid) };
  let stdoutBuf = "";
  let stderrBuf = "";

  function dumpDescendants(rootPid: number): void {
    const all = listAllProcesses();
    const byParent = new Map<number, PsRow[]>();
    for (const p of all) {
      const arr = byParent.get(p.ParentProcessId) ?? [];
      arr.push(p);
      byParent.set(p.ParentProcessId, arr);
    }
    const visited = new Set<number>();
    const queue: number[] = [rootPid];
    const descendants: { pid: number; ppid: number; cmd: string }[] = [];
    while (queue.length) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      for (const c of byParent.get(pid) ?? []) {
        descendants.push({ pid: c.ProcessId, ppid: c.ParentProcessId, cmd: (c.CommandLine ?? "").slice(0, 200) });
        queue.push(c.ProcessId);
      }
    }
    log("descendants", descendants.length === 0 ? "(none)" : descendants);
  }

  const spawnTime = Date.now();
  await new Promise((r) => setTimeout(r, 5000));
  log("after-grace", "dumping descendants + listen ports");
  dumpDescendants(proc.pid);
  const selfPorts = listListeningPorts(proc.pid);
  log("agy-self-listen-ports", selfPorts);

  function scanRecentAgyLog(): { content: string; path: string } | null {
    const dir = path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir)
      .filter((n) => n.startsWith("cli-") && n.endsWith(".log"))
      .map((n) => ({ name: n, full: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .filter((e) => e.mtime >= spawnTime - 2000)
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length === 0) return null;
    return { content: fs.readFileSync(entries[0].full, "utf-8"), path: entries[0].full };
  }

  let ls: LSProcess | null = findLSProcess(proc.pid);
  if (!ls && selfPorts.length > 0) {
    // agy is in-process LS host. Try extracting CSRF from its fresh log file.
    for (let i = 0; i < 10; i++) {
      const lg = scanRecentAgyLog();
      if (lg) {
        log("agy-log-path", lg.path);
        const csrfM = lg.content.match(/csrf[_-]?token['"=:\s]+([A-Za-z0-9_\-+/=]{16,})/i);
        const portM = lg.content.match(/listening on random port at (\d+)/);
        if (portM) log("log-port-found", portM[1]);
        if (csrfM) log("log-csrf-found-length", csrfM[1].length);
        if (csrfM && portM) {
          ls = { pid: proc.pid, port: Number(portM[1]), csrfToken: csrfM[1], commandLine: "(from log)" };
          break;
        }
        // If log has port but no csrf, still attempt probes without csrf to see response shape
        if (portM && !csrfM && i >= 4) {
          ls = { pid: proc.pid, port: Number(portM[1]), csrfToken: "", commandLine: "(port-only)" };
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!ls) {
    log("ls-not-found", "final descendant dump:");
    dumpDescendants(proc.pid);
    log("self-ports-final", selfPorts);
    const lg = scanRecentAgyLog();
    if (lg) log("log-preview", { path: lg.path, head: lg.content.slice(0, 2000) });
    log("agy-stdout-final", stdoutBuf.slice(0, 1000));
    log("agy-stderr-final", stderrBuf.slice(0, 1000));
    proc.kill();
    throw new Error("Language Server CSRF token not discoverable from log or process tree");
  }
  log("ls-found", { pid: ls.pid, port: ls.port, csrfTokenLength: ls.csrfToken.length, source: ls.commandLine });

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const https = await import("https");
  const probe = (urlPath: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: ls!.port,
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": ls!.csrfToken,
            "Content-Length": "0",
          },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf-8").slice(0, 500),
            }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.end();
    });

  const endpoints = [
    "/",
    "/healthz",
    "/v1/health",
    "/google.antigravity.v1.LanguageServerService/GetVersion",
    "/google.antigravity.v1.AgentService/Hello",
  ];
  let reached = false;
  for (const ep of endpoints) {
    try {
      const r = await probe(ep);
      log("probe", { ep, status: r.status, bodyPreview: r.body });
      if (r.status >= 200 && r.status < 500) {
        log("handshake-reached", { ep, status: r.status });
        reached = true;
        break;
      }
    } catch (e) {
      log("probe-error", { ep, err: String(e) });
    }
  }

  if (!reached) {
    log("verdict", "FAIL — no probe reached the LS with usable status");
  } else {
    log("verdict", "SUCCESS — LS reachable via ConnectRPC");
  }

  log("cleanup", "killing agy");
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
}

main().catch((err) => {
  log("fatal", String(err));
  process.exit(1);
});
