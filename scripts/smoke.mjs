#!/usr/bin/env node
/**
 * smoke.mjs — 프로브 전용 라이브 스모크 테스트
 *
 * ⚠️ CRITICAL: 이 스크립트는 절대 server.ts를 spawn하거나 import하지 않는다.
 * server.ts는 import 시점 부수효과가 있다 — killProcessOnPort(GPU_MANAGER_PORT)와
 * killStaleAntigravityProcesses()가 모듈 로드만으로 실행되어 **살아있는 RP 세션을
 * 죽인다**. 이 스크립트는 이미 떠 있는 서버에 HTTP 프로브만 보낸다 (probe-only).
 * 서버가 없으면 아무것도 시작하지 않고 SKIPPED로 종료한다.
 *
 * 프로브 순서:
 *   1. data/.server.pid 읽기 ({pid, port, mode, startedAt}) + 포트 리스닝 확인
 *      → 없거나 안 떠 있으면 "SKIPPED" 출력 후 exit 0
 *   2. GET / → 200/302/401 기대 (부팅+라우팅+미들웨어 증명)
 *   3. .env.local의 ADMIN_PASSWORD를 직접 파싱 (src/lib TS 모듈 import 금지)
 *      - 있으면: POST /api/auth/login 을 **정확히 1회** (레이트리밋 5회/분 — 절대 루프 금지)
 *        → bridge_auth 쿠키 획득 → GET /api/service/status 쿠키 인증 + summary shape 검증
 *        → 429면 백오프 경고 출력하고 WARN 처리
 *      - 없으면: 401/200 모두 pass-degraded
 *   4. GET /api/setup/status 두 번째 저비용 프로브
 *
 * 사용법:
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --json
 *
 * Exit codes (lint-persona 컨벤션):
 *   0 — pass 또는 skip
 *   1 — warn 발견
 *   2 — fail 발견
 */

import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const wantJson = args.includes("--json");

const PID_FILE = path.join(REPO_ROOT, "data", ".server.pid");
const ENV_FILE = path.join(REPO_ROOT, ".env.local");
const FETCH_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────
// 결과 수집 (lint-persona.mjs와 동일한 컨벤션)
// ─────────────────────────────────────────────────────────────
const findings = []; // { severity: "error"|"warn"|"pass", rule, msg }

function record(severity, rule, msg) {
  findings.push({ severity, rule, msg });
}

// ─────────────────────────────────────────────────────────────
// .env.local 파서 — src/lib/env-file.ts readEnvFile()와 동일 의미론
// (TS 모듈을 import하지 않기 위해 자체 구현)
// ─────────────────────────────────────────────────────────────
function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const content = fs.readFileSync(ENV_FILE, "utf-8");
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // 따옴표 밖의 인라인 주석만 제거
    const value = stripQuotes(raw.startsWith('"') || raw.startsWith("'") ? raw : raw.replace(/\s+#.*$/, ""));
    result[key] = value;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// 포트 리스닝 확인 (TCP connect 프로브, 서버 실행 아님)
// ─────────────────────────────────────────────────────────────
function isPortListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (result) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function probe(url, options = {}) {
  return fetch(url, {
    redirect: "manual", // 302를 그대로 관찰
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...options,
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  // 1) .server.pid + 포트 확인
  let pidInfo = null;
  try {
    pidInfo = JSON.parse(fs.readFileSync(PID_FILE, "utf-8"));
  } catch {
    /* missing or unparsable → skip */
  }
  const port = Number(pidInfo?.port);
  if (!pidInfo || !Number.isInteger(port) || port <= 0) {
    console.log("SKIPPED: no server running (start with npm run dev)");
    process.exit(0);
  }
  if (!(await isPortListening(port))) {
    console.log("SKIPPED: no server running (start with npm run dev)");
    console.log(`  (data/.server.pid는 있으나 포트 ${port}이 리스닝하지 않음 — stale pid file)`);
    process.exit(0);
  }
  const base = `http://127.0.0.1:${port}`;
  record("pass", "server", `서버 감지: pid=${pidInfo.pid} port=${port} mode=${pidInfo.mode} startedAt=${pidInfo.startedAt}`);

  // 2) GET / — 부팅+라우팅+미들웨어 증명
  // 미들웨어의 NextResponse.redirect(/login)는 307을 반환 (302 아님) → 3xx 전부 허용
  try {
    const res = await probe(`${base}/`);
    const okStatuses = [200, 301, 302, 303, 307, 308, 401];
    if (okStatuses.includes(res.status)) {
      const note = res.status >= 300 && res.status < 400
        ? ` → ${res.headers.get("location") || "?"}` : "";
      record("pass", "root", `GET / → ${res.status}${note} (부팅+라우팅+미들웨어 OK)`);
    } else {
      record("error", "root", `GET / → ${res.status} (기대: 200/3xx/401)`);
    }
  } catch (err) {
    record("error", "root", `GET / 실패: ${err.message}`);
  }

  // 3) 인증 프로브 — .env.local 자체 파싱 (src/lib TS import 금지)
  const env = readEnvFile();
  const adminPassword = env.ADMIN_PASSWORD || "";
  let cookie = null;

  if (adminPassword) {
    // 레이트리밋 5회/분 — 로그인은 정확히 1회, 절대 재시도 루프 금지
    try {
      const res = await probe(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      if (res.status === 429) {
        record("warn", "login", "로그인 레이트리밋(429) — 5회/분 초과. 1분 이상 기다렸다가 다시 실행할 것 (백오프)");
      } else if (res.status === 200) {
        const setCookies = typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie")].filter(Boolean);
        const authCookie = setCookies.find((c) => c.startsWith("bridge_auth="));
        if (authCookie) {
          cookie = authCookie.split(";")[0];
          record("pass", "login", "POST /api/auth/login → 200, bridge_auth 쿠키 획득");
        } else {
          record("error", "login", "로그인 200이지만 bridge_auth 쿠키가 응답에 없음");
        }
      } else {
        record("error", "login", `POST /api/auth/login → ${res.status} (.env.local의 ADMIN_PASSWORD와 서버 불일치?)`);
      }
    } catch (err) {
      record("error", "login", `로그인 요청 실패: ${err.message}`);
    }

    // 인증된 /api/service/status — summary shape 검증
    if (cookie) {
      try {
        const res = await probe(`${base}/api/service/status`, { headers: { cookie } });
        if (res.status !== 200) {
          record("error", "service-status", `GET /api/service/status → ${res.status} (쿠키 인증인데 200 아님)`);
        } else {
          let body = null;
          try { body = await res.json(); } catch { /* non-JSON */ }
          const summaryOk = body && typeof body === "object"
            && body.summary && typeof body.summary === "object"
            && typeof body.summary.sessions === "number"
            && Array.isArray(body.sessions);
          if (summaryOk) {
            record("pass", "service-status",
              `GET /api/service/status → 200 JSON (sessions=${body.summary.sessions}, activeInstances=${body.summary.activeInstances}, clients=${body.summary.totalClients})`);
          } else {
            record("error", "service-status", "GET /api/service/status 응답이 기대 shape가 아님 (summary.sessions 숫자 + sessions 배열)");
          }
        }
      } catch (err) {
        record("error", "service-status", `GET /api/service/status 실패: ${err.message}`);
      }
    }
  } else {
    // ADMIN_PASSWORD 미설정 — 401/200 모두 pass-degraded
    try {
      const res = await probe(`${base}/api/service/status`);
      if (res.status === 200 || res.status === 401) {
        record("pass", "service-status", `GET /api/service/status → ${res.status} (ADMIN_PASSWORD 미설정, pass-degraded)`);
      } else {
        record("error", "service-status", `GET /api/service/status → ${res.status} (기대: 200/401)`);
      }
    } catch (err) {
      record("error", "service-status", `GET /api/service/status 실패: ${err.message}`);
    }
  }

  // 4) GET /api/setup/status — 두 번째 저비용 프로브
  try {
    const res = await probe(`${base}/api/setup/status`, cookie ? { headers: { cookie } } : {});
    if (res.status === 200) {
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      if (body && typeof body.setupComplete === "boolean") {
        record("pass", "setup-status", `GET /api/setup/status → 200 (setupComplete=${body.setupComplete}, adminPassword=${body.adminPassword})`);
      } else {
        record("warn", "setup-status", "GET /api/setup/status → 200이지만 setupComplete boolean이 없음");
      }
    } else if (res.status === 401 && !cookie) {
      record("pass", "setup-status", "GET /api/setup/status → 401 (쿠키 없음, pass-degraded)");
    } else {
      record("error", "setup-status", `GET /api/setup/status → ${res.status} (기대: 200${cookie ? "" : "/401"})`);
    }
  } catch (err) {
    record("error", "setup-status", `GET /api/setup/status 실패: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Run + Report
// ─────────────────────────────────────────────────────────────
try {
  await main();
} catch (err) {
  console.error(`[smoke] 스크립트 오류: ${err.message}`);
  process.exit(2);
}

function summarize(list) {
  return {
    errors: list.filter((f) => f.severity === "error").length,
    warnings: list.filter((f) => f.severity === "warn").length,
    passed: list.filter((f) => f.severity === "pass").length,
  };
}

const s = summarize(findings);

if (wantJson) {
  console.log(JSON.stringify({ findings, summary: s }, null, 2));
} else {
  for (const f of findings) {
    const tag = f.severity === "error" ? "✗ FAIL" : f.severity === "warn" ? "⚠ WARN" : "✓ PASS";
    console.log(`  ${tag} [${f.rule}] ${f.msg}`);
  }
  console.log(`\n총계: ${s.passed} pass, ${s.warnings} warn, ${s.errors} fail`);
}

process.exit(s.errors > 0 ? 2 : s.warnings > 0 ? 1 : 0);
