/**
 * Standalone behavior harness for codex-process notification routing
 * (no test framework configured).
 * Run:  npx tsx src/lib/codex-process.test.mts
 * Exits non-zero on any failure.
 *
 * Regression origin (2026-07-21): a failed Codex turn was silently reported as a
 * successful one. `turn/completed` carries status/error nested under `params.turn`,
 * but the handler read `params.status` / `params.codexErrorInfo` — always undefined —
 * so every Codex turn failure (bad model, rate limit, expired auth) reached the UI as
 * a normal empty result. Payloads below are captured verbatim from a real session log.
 */
const mod = (await import("./codex-process.ts")) as unknown as Record<string, unknown>;
const CodexProcess = (mod.CodexProcess ?? mod.default) as new () => {
  on(ev: string, fn: (arg: unknown) => void): unknown;
  [key: string]: unknown;
};

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; } else { fail++; console.log(`FAIL ${label}${detail ? `\n  ${detail}` : ""}`); }
}

/** Feed one JSON-RPC message through the private router, capturing emitted events. */
function route(msg: unknown) {
  const proc = new CodexProcess();
  const errors: unknown[] = [];
  const messages: unknown[] = [];
  proc.on("error", (e) => errors.push(e));
  proc.on("message", (m) => messages.push(m));
  (proc["handleJsonRpcMessage"] as (m: unknown) => void).call(proc, msg);
  return { errors, messages };
}

// ── Captured verbatim from data/sessions/.../claude-stream.log (gpt-5.6-sol on codex-cli 0.124.0)
const API_MESSAGE = "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
const FAILED_TURN = {
  method: "turn/completed",
  params: {
    threadId: "019f8031-d069-70c3-adac-250e7a4f56e1",
    turn: {
      id: "019f8031-d082-78b1-8ffb-ae5721d4b44a",
      items: [],
      status: "failed",
      error: {
        message: JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: API_MESSAGE },
        }),
        codexErrorInfo: "other",
        additionalDetails: null,
      },
      startedAt: 1784562176,
      completedAt: 1784562183,
      durationMs: 7193,
    },
  },
};

const OK_TURN = {
  method: "turn/completed",
  params: {
    threadId: "019f8031-d069-70c3-adac-250e7a4f56e1",
    turn: { id: "t2", items: [], status: "completed", error: null, durationMs: 1200 },
  },
};

{
  const { errors, messages } = route(FAILED_TURN);
  ok("failed turn emits an error", errors.length === 1, `got ${errors.length} error(s): ${JSON.stringify(errors)}`);
  ok(
    "error surfaces the human-readable API message",
    typeof errors[0] === "string" && (errors[0] as string).includes(API_MESSAGE),
    `got=${JSON.stringify(errors[0])}`,
  );
  // The result message must still fire so the UI leaves its streaming state.
  ok("failed turn still emits result", messages.some((m) => (m as { type?: string })?.type === "result"));
}

{
  const { errors, messages } = route(OK_TURN);
  ok("successful turn emits no error", errors.length === 0, `got=${JSON.stringify(errors)}`);
  ok("successful turn emits result", messages.some((m) => (m as { type?: string })?.type === "result"));
}

console.log(`\ncodex-process: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
