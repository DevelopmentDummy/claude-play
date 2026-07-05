# fire_ai 멀티 프로바이더 지원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fire_ai` 백그라운드 AI 스폰이 Claude뿐 아니라 Codex/Gemini/Kimi/Antigravity를 원하는 모델로 실행할 수 있게 한다. 모델 미지정 시 기존처럼 Claude로 동작(하위 호환).

**Architecture:** `src/lib/background-session.ts`의 Claude 전용 `spawn("claude", …)`을 걷어내고, 서브에이전트가 검증한 `createProcess(provider)` 프로세스 엔진을 재사용한다. provider는 `providerFromModel(model)`로 도출하고, 지속-프로세스를 one-shot처럼(한 턴 실행 → `{type:"result"}` 수신 → kill) 운용한다. provider별 MCP/CODEX_HOME/시스템프롬프트 셋업은 process 클래스에 이미 캡슐화되어 있어 재사용만으로 따라온다.

**Tech Stack:** TypeScript (strict), Node child process(간접, provider 클래스 내부), Next.js API route, MCP(zod 스키마).

## Global Constraints

- **테스트 프레임워크 없음** — 이 저장소는 자동 테스트가 없다(`CLAUDE.md`: "No test framework is configured"). 각 태스크의 자동 게이트는 `npm run build`(tsc strict + Next 빌드) 그린이며, 행위 검증은 dev 서버 스모크로 한다.
- **경로에 공백** — 프로젝트 경로 `C:\repository\claude bridge`. 셸 명령 시 인용 주의.
- **하위 호환 필수** — `model` 미지정 fire_ai 호출은 반드시 기존과 동일하게 Claude(opus) + minimal task 프롬프트로 동작해야 한다.
- **함수명 변경** — `spawnBackgroundClaude` → `spawnBackgroundAI`. 호출부 4곳 전부 교체(하위 호환 alias 두지 않음). `destroyAllBackgroundProcesses` 이름은 유지(server.ts가 import).
- **provider 파라미터 신설 금지** — provider는 `model`에서 도출(YAGNI).
- **커밋 메시지 말미**: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/lib/background-session.ts` | 백그라운드 AI 스폰 엔진 | **주 재작성**: provider 라우팅, createProcess 엔진, settle/timeout, 시스템프롬프트 분기, provider-process 추적, 함수 개명 |
| `src/app/api/sessions/[id]/fire-ai/route.ts` | fire_ai HTTP 진입점 | import·호출 개명 |
| `src/lib/session-instance.ts` | on-assistant / on-style-check 훅 | import·호출 2곳 개명 + 로그 문구 |
| `src/app/api/sessions/[id]/tools/[name]/route.ts` | 커스텀 툴 엔진 fireAi | import·호출 개명 |
| `src/mcp/claude-play-mcp-server.mjs` | MCP `fire_ai` 도구 | description + `model` 설명 확장 |
| `docs/architecture.md`, `docs/session-lifecycle.md`, `docs/style-check-system.md` | 구조 문서 | fire-ai 설명 멀티 프로바이더화 |

---

## Task 1: 백그라운드 AI 엔진 재작성 + 호출부 개명

fire_ai를 provider-라우팅 엔진으로 교체하고, 4개 호출부를 새 이름으로 갱신한다. 이 태스크의 산출물은 "빌드 그린 + Claude fire_ai가 기존과 동일하게 동작"이다. 개명이 호출부로 번지므로 엔진과 4개 호출부를 한 태스크에서 함께 랜딩해야 빌드가 깨지지 않는다.

**Files:**
- Modify(전체 재작성): `src/lib/background-session.ts`
- Modify: `src/app/api/sessions/[id]/fire-ai/route.ts:3,55`
- Modify: `src/lib/session-instance.ts:11,755,968`
- Modify: `src/app/api/sessions/[id]/tools/[name]/route.ts:5,147`

**Interfaces:**
- Consumes:
  - `providerFromModel(model: string): AIProvider`, `parseModelEffort(value: string): { model: string; effort: string | undefined }`, `AIProvider` — `src/lib/ai-provider.ts`
  - `createProcess(provider: AIProvider): AIProcess`, `AIProcess` — `src/lib/ai-process-factory.ts`
  - `AIProcess.spawn(cwd, resumeId?, model?, appendSystemPrompt?, effort?, skipPermissions?, logName?): void`, `.send(text)`, `.kill()`, `.isRunning()`, `.waitForReady(ms): Promise<boolean>`, EventEmitter `message`/`error`/`exit`
  - `newSubTextState()`, `reduceSubMessage(state, msg)`, `SubTextState` — `src/lib/subagent-transcript.ts`
  - `sm.buildServiceSystemPrompt(personaName?, provider?, options?, userName?)`, `sm.resolveOptions(sessionDir)`, `sm.getProfile(slug)` — `getSessionManager()`
- Produces:
  - `spawnBackgroundAI(opts: FireAIOptions): FireAIResult` — 대체 진입점(기존 `spawnBackgroundClaude` 시그니처와 동일 필드)
  - `destroyAllBackgroundProcesses(): void` — 이름 유지
  - `FireAIOptions`, `FireAIOnExit`, `FireAIResult` — 타입 불변

---

- [ ] **Step 1: `background-session.ts` 전체 재작성**

`src/lib/background-session.ts`를 아래 내용으로 완전히 교체한다.

```ts
import * as fs from "fs";
import * as path from "path";
import { getSessionManager, getSessionInstance } from "./session-registry";
import { wsBroadcast } from "./ws-server";
import { AIProvider, providerFromModel, parseModelEffort } from "./ai-provider";
import { AIProcess, createProcess } from "./ai-process-factory";
import { newSubTextState, reduceSubMessage, type SubTextState } from "./subagent-transcript";

// ── Interfaces ──────────────────────────────────────────────

/** Exit-time actions for a background spawn.
 *  `broadcast` fires a static WS message to the caller's clients (UI spinners, badges, delayed
 *  reveal, etc.). `script` requires a JS module inside the session dir and lets it return
 *  *dynamic* broadcasts/queueEvents based on exit code or log tail. */
export interface FireAIOnExit {
  /** Static WS broadcast to the caller session's clients. */
  broadcast?: { event: string; data?: unknown };
  /** Path (relative to sessionDir) to a Node module exporting a function.
   *  Receives `{ pid, exitCode, sessionDir, logTail }`, may return
   *  `{ broadcast?: { event, data }, queueEvent?: string }`. */
  script?: string;
}

export interface FireAIOptions {
  sessionDir: string;
  prompt: string;
  /** Model id; provider is derived via providerFromModel(). Empty/undefined → Claude (opus). */
  model?: string;
  effort?: string;
  notify?: boolean;
  callerSessionId?: string;
  /** When true, inject the full persona system prompt (CLAUDE.md, persona.md, worldview).
   *  When false (default), use a minimal task-execution prompt — the spawn focuses on
   *  *acting on the user prompt* (calling tools, writing files) rather than roleplaying. */
  useSessionContext?: boolean;
  /** Exit-time hook beyond `notify`. WS broadcast and/or callback script. */
  onExit?: FireAIOnExit;
}

/** Minimal system prompt for task-execution spawns.
 *  Optimised for tool use — explicitly tells the model to use Write/Read/etc. tools
 *  rather than producing in-character narrative responses. */
const TASK_EXECUTION_SYSTEM_PROMPT = [
  "You are a focused background agent executing a single task in a session directory.",
  "You are NOT roleplaying any character. You are NOT producing narrative dialogue.",
  "When the user prompt asks you to write a file, ALWAYS call the Write tool — do not respond with text describing what you would write.",
  "When the user prompt asks you to read or analyse files, ALWAYS use the Read/Glob/Grep tools — do not fabricate contents.",
  "Your final text response should be brief (one short sentence) confirming the action you took. The actual work happens through tool calls.",
  "If a tool fails, report the failure verbatim. Do not invent success.",
].join("\n");

export interface FireAIResult {
  pid: number;
  status: "fired";
}

// ── Active process tracking ─────────────────────────────────

/** Live background provider processes. Killed en masse on server shutdown. */
const activeProcesses = new Set<AIProcess>();

/** Structural accessor for a provider process's underlying child pid.
 *  Pipe-based providers (claude/codex/gemini/kimi) expose `proc?.pid`; AntigravityProcess
 *  tracks `agyPid` instead, so this yields undefined for it — agy is reaped via its own
 *  PID registry (data/.runtime/agy-procs.json), not via this pid. */
type ProcCarrier = { proc?: { pid?: number } | null };

/** Safety timeout for a background turn. A persistent provider process (unlike the old
 *  one-shot `claude -p`) does not self-exit, so a hung turn must be killed. */
const DEFAULT_FIRE_AI_TIMEOUT_MS = 600_000; // 10 min

// ── Helpers ─────────────────────────────────────────────────

/** Read session.json and build the full persona system prompt for the given provider. */
function buildSystemPromptForSession(sessionDir: string, provider: AIProvider): string {
  const sm = getSessionManager();
  const metaPath = path.join(sessionDir, "session.json");
  let personaName: string | undefined;
  let userName: string | undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    personaName = meta.persona;
    if (meta.profileSlug) {
      const profile = sm.getProfile(meta.profileSlug);
      userName = profile?.name;
    }
  } catch { /* ignore — will build prompt without persona */ }
  const resolvedOptions = sm.resolveOptions(sessionDir);
  return sm.buildServiceSystemPrompt(personaName, provider, resolvedOptions, userName);
}

/** Push a completion event to the caller session's pending-events.json.
 *  Tries the live SessionInstance first (so the WS broadcast fires); falls back to
 *  direct disk write when the instance has been cleaned up (10-min grace expired,
 *  page closed, etc.) — otherwise the notification is lost forever. */
function pushCompletionEvent(sessionDir: string, callerSessionId: string, pid: number, exitCode: number | null): void {
  const header = `[BACKGROUND_SESSION_COMPLETE] pid=${pid} exit_code=${exitCode ?? "null"}`;
  try {
    const instance = getSessionInstance(callerSessionId);
    if (instance) {
      instance.queueEvent(header);
      return;
    }
  } catch (err) {
    console.error("[background-session] queueEvent via instance failed, falling back to disk:", err);
  }
  // Fallback: write directly to pending-events.json so the next session open picks it up.
  try {
    const fp = path.join(sessionDir, "pending-events.json");
    let headers: string[] = [];
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) headers = parsed;
    }
    headers = headers.filter(h => h !== header);
    headers.push(header);
    fs.writeFileSync(fp, JSON.stringify(headers), "utf-8");
  } catch (err) {
    console.error("[background-session] Failed to persist completion event to disk:", err);
  }
}

/** Read the tail of a file safely (returns "" on any error). Used to give onExit scripts
 *  a small slice of the spawn log so they can detect specific failure strings. */
function tailFile(fp: string, maxBytes = 4096): string {
  try {
    const stat = fs.statSync(fp);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(fp, "r");
    try {
      const len = stat.size - start;
      if (len <= 0) return "";
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Resolve and validate an onExit.script path. Refuses paths that escape sessionDir
 *  (path traversal). Returns the absolute path, or null if rejected/missing. */
function resolveScriptPath(sessionDir: string, scriptRel: string): string | null {
  const sessionRoot = path.resolve(sessionDir);
  const abs = path.resolve(sessionRoot, scriptRel);
  if (abs !== sessionRoot && !abs.startsWith(sessionRoot + path.sep)) {
    console.error(`[background-session] onExit.script rejected (outside sessionDir): ${scriptRel}`);
    return null;
  }
  if (!fs.existsSync(abs)) {
    console.error(`[background-session] onExit.script not found: ${abs}`);
    return null;
  }
  return abs;
}

/** Run the onExit hook. Order: static broadcast → script callback → script-returned
 *  broadcast/queueEvent. The `notify` completion event is handled separately by the caller.
 *  `logName` selects which per-provider log file the script's logTail reads from. */
function runOnExit(
  onExit: FireAIOnExit,
  sessionDir: string,
  callerSessionId: string | undefined,
  pid: number,
  exitCode: number | null,
  logName: string,
): void {
  // 1) Static broadcast — caller-session-scoped only.
  if (onExit.broadcast && typeof onExit.broadcast.event === "string") {
    if (callerSessionId) {
      try {
        wsBroadcast(onExit.broadcast.event, onExit.broadcast.data ?? {}, { sessionId: callerSessionId });
      } catch (err) {
        console.error("[background-session] onExit.broadcast failed:", err);
      }
    } else {
      console.warn("[background-session] onExit.broadcast skipped — no callerSessionId");
    }
  }

  // 2) Script callback — sessionDir-scoped JS module.
  if (typeof onExit.script === "string" && onExit.script.trim()) {
    const scriptPath = resolveScriptPath(sessionDir, onExit.script);
    if (scriptPath) {
      try {
        const logPath = path.join(sessionDir, logName);
        const logTail = tailFile(logPath, 4096);

        // eslint-disable-next-line no-eval
        const nativeRequire = eval("require") as NodeRequire;
        delete nativeRequire.cache[scriptPath];
        const mod = nativeRequire(scriptPath);
        const fn = typeof mod === "function" ? mod : mod.default;
        if (typeof fn !== "function") {
          console.error(`[background-session] onExit.script has no callable export: ${scriptPath}`);
        } else {
          const result = fn({ pid, exitCode, sessionDir, logTail });
          if (result && typeof result === "object") {
            const r = result as { broadcast?: { event: string; data?: unknown }; queueEvent?: string };

            if (r.broadcast && typeof r.broadcast.event === "string" && callerSessionId) {
              try {
                wsBroadcast(r.broadcast.event, r.broadcast.data ?? {}, { sessionId: callerSessionId });
              } catch (err) {
                console.error("[background-session] onExit.script broadcast failed:", err);
              }
            }

            if (typeof r.queueEvent === "string" && r.queueEvent.trim() && callerSessionId) {
              try {
                const instance = getSessionInstance(callerSessionId);
                if (instance) {
                  instance.queueEvent(r.queueEvent);
                } else {
                  // Same disk fallback as pushCompletionEvent.
                  const fp = path.join(sessionDir, "pending-events.json");
                  let headers: string[] = [];
                  if (fs.existsSync(fp)) {
                    try {
                      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
                      if (Array.isArray(parsed)) headers = parsed;
                    } catch { /* ignore corrupt file */ }
                  }
                  headers = headers.filter(h => h !== r.queueEvent);
                  headers.push(r.queueEvent);
                  fs.writeFileSync(fp, JSON.stringify(headers), "utf-8");
                }
              } catch (err) {
                console.error("[background-session] onExit.script queueEvent failed:", err);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[background-session] onExit.script error (${scriptPath}):`, err);
      }
    }
  }
}

// ── Core function ───────────────────────────────────────────

/**
 * Spawn an independent one-shot background AI turn in the given session directory,
 * on the provider derived from `model` (default Claude). Reuses the session/subagent
 * provider-process engine: spawn → send prompt → on turn-ending `{type:"result"}` →
 * kill + fire onExit/notify. Returns immediately with the child pid (0 for antigravity,
 * whose pid is not exposed on the process object) — does not wait for completion.
 */
export function spawnBackgroundAI(opts: FireAIOptions): FireAIResult {
  const { sessionDir, prompt, model, effort, notify, callerSessionId, useSessionContext, onExit } = opts;

  // Parse model (may carry an embedded effort suffix, e.g. "opus:ultracode"); explicit
  // `effort` wins over the embedded one. Provider is derived from the model (default claude).
  const { model: parsedModel, effort: embeddedEffort } = parseModelEffort(model || "");
  const effectiveModel = parsedModel || undefined;
  const effectiveEffort = effort || embeddedEffort || undefined;

  let provider: AIProvider;
  try {
    provider = effectiveModel ? providerFromModel(effectiveModel) : "claude";
  } catch (err) {
    // providerFromModel throws e.g. when Gemini is disabled. Surface to the caller
    // (route/hook already wrap in try/catch, so the session turn is unaffected).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[background-session] provider routing failed for model="${model}": ${msg}`);
    throw new Error(`fire_ai: ${msg}`);
  }

  // System prompt: minimal task prompt (default) or full persona context.
  const systemPrompt = useSessionContext
    ? buildSystemPromptForSession(sessionDir, provider)
    : TASK_EXECUTION_SYSTEM_PROMPT;

  // Claude applies the spawn's appendSystemPrompt arg as a real `--system-prompt` (full
  // replacement). Other provider classes ignore that arg, so for them the system prompt is
  // delivered as a leading message block instead (provider-uniform, mirrors subagent role
  // delivery). Note: non-Claude providers also load the session config's own baseInstructions
  // (persona), so the minimal prompt layers on top rather than fully replacing it.
  const claudeSystemPrompt = provider === "claude" ? systemPrompt : undefined;
  const payload = provider === "claude"
    ? prompt
    : `${systemPrompt}\n\n--- TASK ---\n${prompt}`;

  const logName = `background-${provider}.log`;
  const logPath = path.join(sessionDir, logName);

  const proc = createProcess(provider);
  activeProcesses.add(proc);

  // Per-turn text accumulator — final text harvested to the log for debugging.
  let textState: SubTextState = newSubTextState();
  let finalText = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pidOf = (): number => (proc as unknown as ProcCarrier).proc?.pid ?? -1;

  const settle = (code: number | null): void => {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    activeProcesses.delete(proc);
    const pid = pidOf();
    try { proc.kill(); } catch { /* already dead */ }

    // Append a settle marker (+ harvested final text) so onExit scripts / debugging have it.
    try {
      const stream = fs.createWriteStream(logPath, { flags: "a" });
      stream.write(`\n--- fire_ai settle provider=${provider} code=${code} at ${new Date().toISOString()} ---\n`);
      if (finalText) {
        stream.write(`[final] ${finalText.slice(0, 500)}${finalText.length > 500 ? "..." : ""}\n`);
      }
      stream.end();
    } catch { /* best-effort */ }

    if (onExit && (onExit.broadcast || onExit.script)) {
      runOnExit(onExit, sessionDir, callerSessionId, pid, code, logName);
    }
    if (notify && callerSessionId) {
      pushCompletionEvent(sessionDir, callerSessionId, pid, code);
    }
    console.log(`[background-session] settled provider=${provider} pid=${pid} code=${code}`);
  };

  proc.on("message", (d: unknown) => {
    const msg = d as Record<string, unknown>;
    const { state, final } = reduceSubMessage(textState, msg);
    textState = state;
    if (final) finalText = final;
    // Turn-ending result → normal completion.
    if (msg.type === "result") settle(0);
  });
  proc.on("error", (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[background-session] provider=${provider} error: ${msg}`);
    settle(1);
  });
  proc.on("exit", () => {
    // Persistent process exited without a prior `result` → crash/abnormal. If a result
    // already settled us, this is the kill()-triggered exit and is a no-op (idempotent).
    settle(1);
  });

  // Fresh conversation (no resumeId). Log to background-<provider>.log.
  proc.spawn(sessionDir, undefined, effectiveModel, claudeSystemPrompt, effectiveEffort, true, logName);

  const spawnedPid = pidOf();
  console.log(`[background-session] spawned provider=${provider} pid=${spawnedPid} model=${effectiveModel || "(default)"} effort=${effectiveEffort || "(default)"} notify=${notify || false}`);

  // Safety timeout — kill + treat as error if the turn never completes.
  const timeoutMs = Number(process.env.FIRE_AI_TIMEOUT_MS) || DEFAULT_FIRE_AI_TIMEOUT_MS;
  timer = setTimeout(() => {
    console.warn(`[background-session] provider=${provider} timed out after ${timeoutMs}ms — killing`);
    settle(1);
  }, timeoutMs);

  // Gate the send on provider readiness (codex/kimi have an async JSON-RPC handshake during
  // which isRunning() is briefly false; claude/gemini resolve immediately).
  void proc.waitForReady(20_000)
    .then((ready) => {
      if (settled) return;
      if (!ready || !proc.isRunning()) {
        console.warn(`[background-session] provider=${provider} not ready — aborting`);
        settle(1);
        return;
      }
      proc.send(payload);
    })
    .catch((err) => {
      if (settled) return;
      console.warn(`[background-session] provider=${provider} waitForReady failed:`, err);
      settle(1);
    });

  return { pid: spawnedPid >= 0 ? spawnedPid : 0, status: "fired" };
}

// ── Cleanup ─────────────────────────────────────────────────

/** Destroy all active background provider processes (called on server shutdown).
 *  Each provider's kill() handles its own process-tree teardown (Windows taskkill /T, etc.). */
export function destroyAllBackgroundProcesses(): void {
  for (const proc of Array.from(activeProcesses)) {
    try { proc.kill(); } catch { /* already exited */ }
  }
  activeProcesses.clear();
}
```

- [ ] **Step 2: `fire-ai/route.ts` 호출부 개명**

`src/app/api/sessions/[id]/fire-ai/route.ts`에서 두 곳을 바꾼다.

3번 줄:
```ts
import { spawnBackgroundClaude, type FireAIOnExit } from "@/lib/background-session";
```
→
```ts
import { spawnBackgroundAI, type FireAIOnExit } from "@/lib/background-session";
```

55번 줄:
```ts
    const result = spawnBackgroundClaude({
```
→
```ts
    const result = spawnBackgroundAI({
```

- [ ] **Step 3: `session-instance.ts` 호출부 2곳 개명 + 로그 문구**

`src/lib/session-instance.ts`에서:

11번 줄:
```ts
import { spawnBackgroundClaude } from "./background-session";
```
→
```ts
import { spawnBackgroundAI } from "./background-session";
```

754~755번 줄(on-assistant):
```ts
                  console.log(`[hooks/on-assistant fireAi] spawning bg claude for ${this.id} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
                  spawnBackgroundClaude({
```
→
```ts
                  console.log(`[hooks/on-assistant fireAi] spawning bg AI for ${this.id} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
                  spawnBackgroundAI({
```

967~968번 줄(on-style-check):
```ts
            console.log(`[hooks/on-style-check fireAi] spawning bg claude for ${this.id} (counter=${counter}, model=${fa.model || config.model || "default"})`);
            spawnBackgroundClaude({
```
→
```ts
            console.log(`[hooks/on-style-check fireAi] spawning bg AI for ${this.id} (counter=${counter}, model=${fa.model || config.model || "default"})`);
            spawnBackgroundAI({
```

- [ ] **Step 4: `tools/[name]/route.ts` 호출부 개명 + 로그 문구**

`src/app/api/sessions/[id]/tools/[name]/route.ts`에서:

5번 줄:
```ts
import { spawnBackgroundClaude } from "@/lib/background-session";
```
→
```ts
import { spawnBackgroundAI } from "@/lib/background-session";
```

146~147번 줄:
```ts
          console.log(`[tools/${name} fireAi] spawning bg claude for ${sessionId} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
          spawnBackgroundClaude({
```
→
```ts
          console.log(`[tools/${name} fireAi] spawning bg AI for ${sessionId} (model=${fa.model || "default"}, effort=${fa.effort || "default"})`);
          spawnBackgroundAI({
```

- [ ] **Step 5: 빌드 게이트**

Run: `npm run build`
Expected: tsc strict 통과 + Next 빌드 성공(그린). `spawnBackgroundClaude` 잔여 참조로 인한 에러 없음.

만약 `spawnBackgroundClaude` 미해결 참조 에러가 나면 `grep -rn spawnBackgroundClaude src` 로 누락 호출부를 찾아 개명한다.

- [ ] **Step 6: Claude 하위 호환 스모크 (dev 서버 필요)**

Run: `npm run dev` (별도 터미널, port 3340)

기존 Claude 세션을 열고, RP 중 AI가 `fire_ai`를 model 없이 호출하도록 유도(또는 on-assistant 훅이 있는 페르소나로 트리거). 확인:
- 세션 디렉터리에 `background-claude.log` 생성 + `--- fire_ai settle provider=claude code=0 ---` 마커.
- `notify:true`였다면 다음 user 턴에 `[BACKGROUND_SESSION_COMPLETE] pid=… exit_code=0` 이벤트 주입.

Expected: Claude 스폰이 기존과 동일하게 동작(백그라운드 태스크 수행 후 정상 settle).

> 참고: ADMIN_PASSWORD가 설정되어 있어 쿠키 없는 직접 curl은 401. 라이브 세션(MCP 도구/훅) 경로로 트리거하는 것이 확실. 이 스모크는 운영 환경이 필요하므로 사용자 동반 확인 권장.

- [ ] **Step 7: 커밋**

```bash
git add src/lib/background-session.ts "src/app/api/sessions/[id]/fire-ai/route.ts" src/lib/session-instance.ts "src/app/api/sessions/[id]/tools/[name]/route.ts"
git commit -m "feat(fire-ai): route background AI to any provider via createProcess engine

Rename spawnBackgroundClaude -> spawnBackgroundAI; derive provider from
model (providerFromModel), reuse the session/subagent provider-process
engine (spawn -> send -> settle on {type:result} -> kill). Claude stays
the default and behavior when no model is given. Adds a safety timeout
(FIRE_AI_TIMEOUT_MS, default 10m) and per-provider log files.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: MCP `fire_ai` 도구 설명 확장

MCP 도구의 description과 `model` 필드 설명을 멀티 프로바이더로 갱신한다. 스키마 필드는 불변(모델에서 provider 도출). `.mjs`라 tsc 대상이 아니므로 빌드 영향 없음 — 게이트는 세션 재open 후 도구 설명 확인.

**Files:**
- Modify: `src/mcp/claude-play-mcp-server.mjs:1358-1371`

**Interfaces:**
- Consumes: 없음(문자열 변경). Produces: 없음.

- [ ] **Step 1: description 문자열 교체**

`src/mcp/claude-play-mcp-server.mjs`의 `fire_ai` 등록에서:

```js
    description:
      "Fire an independent AI session in the background. " +
      "Spawns claude in one-shot mode with the current session's system prompt and MCP tools. " +
      "Returns immediately without waiting for completion. " +
      "Use for time-consuming content generation that shouldn't block the conversation.\n" +
```
→
```js
    description:
      "Fire an independent AI session in the background. " +
      "Runs a one-shot turn on the provider derived from `model` (default: Claude) with " +
      "the session's system prompt and MCP tools. Any provider model id works: opus/sonnet " +
      "(Claude), gpt-5.4 (Codex), gemini-3.1-pro-preview (Gemini), antigravity-flash " +
      "(Antigravity), kimi-auto (Kimi). Returns immediately without waiting for completion. " +
      "Use for time-consuming content generation that shouldn't block the conversation.\n" +
```

- [ ] **Step 2: `model` 필드 설명 교체**

1370번 줄:
```js
      model: z.string().optional().describe("Model override (e.g. sonnet, opus)"),
```
→
```js
      model: z.string().optional().describe("Model id — provider is auto-derived (e.g. opus, gpt-5.4, gemini-3.1-pro-preview, antigravity-flash, kimi-auto). Omit for Claude default."),
```

- [ ] **Step 3: 검증 (세션 재open 필요)**

MCP 서버는 세션별로 뜨므로, 세션을 재open해 새 도구 설명이 반영되는지 확인(또는 `.mjs` 문법만 확인):

Run: `node --check src/mcp/claude-play-mcp-server.mjs`
Expected: 문법 에러 없음(출력 없음, exit 0).

- [ ] **Step 4: 커밋**

```bash
git add src/mcp/claude-play-mcp-server.mjs
git commit -m "docs(fire-ai): document multi-provider model routing in fire_ai MCP tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 구조 문서 갱신

change-propagation 규칙에 따라 fire-ai를 언급하는 구조 문서를 멀티 프로바이더로 갱신한다.

**Files:**
- Modify: `docs/architecture.md:32`
- Modify: `docs/session-lifecycle.md:28`
- Modify: `docs/style-check-system.md:69,161`

**Interfaces:** 없음(문서).

- [ ] **Step 1: `architecture.md` 갱신**

32번 줄:
```
| `background-session.ts` | Spawns detached Claude subprocesses (`spawnBackgroundClaude()`) for long-running side jobs invoked from hooks or the `fire_ai` MCP tool. Optional minimal vs full persona-context system prompt. |
```
→
```
| `background-session.ts` | Spawns background AI turns (`spawnBackgroundAI()`) for long-running side jobs invoked from hooks or the `fire_ai` MCP tool. Provider derived from `model` (default Claude) via `createProcess()`; runs one turn then settles on `{type:"result"}`. Optional minimal vs full persona-context system prompt; safety timeout via `FIRE_AI_TIMEOUT_MS`. |
```

- [ ] **Step 2: `session-lifecycle.md` 갱신**

28번 줄:
```
- `background-session.ts`의 `spawnBackgroundClaude()`가 detached Claude를 spawn — PID 즉시 반환, 메인 턴 비차단
```
→
```
- `background-session.ts`의 `spawnBackgroundAI()`가 `model`에서 도출된 provider(기본 Claude)로 백그라운드 턴을 spawn(`createProcess` 엔진 재사용) — PID 즉시 반환, 메인 턴 비차단. 한 턴 실행 후 `{type:"result"}` 수신 시 settle(kill+notify/onExit).
```

- [ ] **Step 3: `style-check-system.md` 갱신**

69번 줄:
```
- hook에서 `fireAi` 반환 → 코어가 `spawnBackgroundClaude()` 호출 (기존 fire_ai 인프라 재사용)
```
→
```
- hook에서 `fireAi` 반환 → 코어가 `spawnBackgroundAI()` 호출 (기존 fire_ai 인프라 재사용; model 지정 시 provider 도출)
```

161번 줄:
```
- fire_ai 백그라운드 세션: `src/lib/background-session.ts:spawnBackgroundClaude()`
```
→
```
- fire_ai 백그라운드 세션: `src/lib/background-session.ts:spawnBackgroundAI()`
```

- [ ] **Step 4: 커밋**

```bash
git add docs/architecture.md docs/session-lifecycle.md docs/style-check-system.md
git commit -m "docs(fire-ai): update structural docs for multi-provider fire_ai

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 멀티 프로바이더 라이브 스모크 (dev 서버 + 라이브 세션 필요)

비-Claude 경로와 부가 기능을 실제로 검증한다. 자동 테스트가 없으므로 이 태스크가 실질 수용 게이트다. dev 서버와 각 provider의 라이브 세션이 필요하므로 **사용자 환경 동반**이 필요할 수 있다.

**Files:** 없음(검증 전용).

- [ ] **Step 1: Codex 경로**

Codex 세션(또는 아무 세션)에서 `fire_ai({ prompt: "…", model: "gpt-5.4", notify: true })` 트리거. 확인:
- `background-codex.log` 생성, codex가 세션 `.codex`(CODEX_HOME)로 스폰되어 MCP 도구 접근.
- turn 완료 후 `--- fire_ai settle provider=codex code=0 ---`.
- notify 이벤트가 다음 턴에 주입.

Expected: codex가 백그라운드로 태스크 수행 후 정상 settle.

- [ ] **Step 2: Gemini 경로 (Gemini 비활성 아니면)**

`fire_ai({ prompt: "…", model: "gemini-3.1-pro-preview" })` 트리거. `background-gemini.log`에 spawn+settle 확인.

`NEXT_PUBLIC_DISABLE_GEMINI=true`면: `fire_ai({ model: "gemini-…" })`가 `fire_ai: Gemini provider is disabled …` 에러로 실패하고 세션 턴은 유지되는지 확인.

- [ ] **Step 3: onExit.script 경로**

세션 디렉터리에 콜백 모듈을 두고(예: `on-bg-done.js`가 `{ queueEvent: "[BG] done" }` 반환) `fire_ai({ prompt: "…", onExit: { script: "on-bg-done.js" } })` 트리거. 확인:
- 콜백이 `logTail`(= `background-<provider>.log` tail)을 받고, 반환한 `queueEvent`가 다음 턴에 주입.

- [ ] **Step 4: 타임아웃 경로**

`FIRE_AI_TIMEOUT_MS=5000`로 dev 서버를 띄우고 오래 걸리는 prompt로 `fire_ai` 트리거. 상한 초과 시 프로세스 kill + `settle code=1` + (notify 시) `exit_code=1` 이벤트 확인.

- [ ] **Step 5: 최종 빌드 확인**

Run: `npm run build`
Expected: 그린.

- [ ] **Step 6: 결과 기록**

스모크 결과(통과/실패 항목)를 이 계획서 하단이나 커밋 메시지에 기록. 실패 시 systematic-debugging으로 회귀.

---

## Self-Review (작성자 체크)

**Spec coverage:**
- 아키텍처(Approach B 재사용) → Task 1 ✅
- 기본값 Claude 유지 → Task 1(provider 도출 default "claude") + Step 6 스모크 ✅
- 진입점 4곳 개명(spec은 3곳이라 했으나 tools/[name] 포함 4곳) → Task 1 Step 2~4 ✅
- 시스템 프롬프트 Claude=`--system-prompt` / 비-Claude=leading → Task 1 Step 1(`claudeSystemPrompt`/`payload` 분기) ✅
- onExit/notify 매핑(result=0, error/timeout=1, logTail=provider 로그) → Task 1 `settle`/`runOnExit(logName)` ✅
- 안전 타임아웃(`FIRE_AI_TIMEOUT_MS`) → Task 1 + Task 4 Step 4 ✅
- MCP 설명 확장 → Task 2 ✅
- 문서 갱신 → Task 3 ✅
- 스모크 7항목(하위호환/codex/gemini/notify/onExit/timeout/build) → Task 1 Step 6 + Task 4 ✅

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함, TBD/TODO 없음. ✅

**Type consistency:** `spawnBackgroundAI`/`FireAIOptions`/`FireAIResult`/`destroyAllBackgroundProcesses`/`runOnExit(…, logName)`/`settle(code)` 이름이 태스크 전반 일관. `ProcCarrier`는 subagent-instance와 동일 구조. ✅
