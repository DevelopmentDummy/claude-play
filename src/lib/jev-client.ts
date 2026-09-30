// TypeSafe System One(Jev) 클라이언트 — 코어의 단일 진입점.
// 키(TYPESAFE_API_KEY)는 서버 밖으로 나가지 않는다: MCP·패널·페르소나 도구 모두 이 모듈을 거친다.
// 코어는 질문을 해석하지 않는다. 검증·전달·재시도만 하고 응답은 가공 없이 돌려준다.
// 설계: docs/specs/2026-10-01-jev-core-design.md

export type JevQuestion =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] }
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities?: Record<string, number> | number[] }
  | { type: "noul"; noul: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AskJevOptions {
  /** 기본 "jev-latest". 버전 고정이 필요하면 "jev-1.13.0" 등. */
  model?: string;
  timeoutMs?: number;
  /** 429·5xx·네트워크 오류 재시도 횟수 (첫 시도 제외). */
  retries?: number;
  /** 재시도 기본 대기(ms). 지수 증가, 상한 5초. retry-after 헤더가 있으면 그쪽이 우선. */
  backoffMs?: number;
  // ── 테스트 주입용 ──
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class JevError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "JevError";
  }
}

const DEFAULT_BASE = "https://api.typesafe.ai";
const MAX_BACKOFF_MS = 5_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 네트워크를 타기 전에 명백한 형식 오류를 걸러낸다 — 메시지는 호출한 AI/코드가 바로 고칠 수 있게. */
export function validateJevQuestions(questions: unknown): asserts questions is Record<string, JevQuestion> {
  if (!isObject(questions) || Object.keys(questions).length === 0) {
    throw new JevError("questions must be a non-empty object map of { id: question }", 400);
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!isObject(q)) throw new JevError(`questions.${id}: must be an object`, 400);
    if (q.instructions === undefined || q.instructions === null || q.instructions === "") {
      throw new JevError(`questions.${id}: instructions is required`, 400);
    }
    if (q.type === "choice") {
      const n = isObject(q.criteria) ? Object.keys(q.criteria).length : 0;
      if (n < 1 || n > 255) throw new JevError(`questions.${id}: choice criteria must be an object with 1-255 options`, 400);
    } else if (q.type === "score") {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < 2 || n > 10) throw new JevError(`questions.${id}: score criteria must be an ordered array of 2-10 levels`, 400);
    } else if (q.type === "noul") {
      if (q.criteria !== undefined && !isObject(q.criteria)) {
        throw new JevError(`questions.${id}: noul criteria must be { true?, false? }`, 400);
      }
    } else {
      throw new JevError(`questions.${id}: type must be "choice", "score", or "noul"`, 400);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt: number, base: number, retryAfter: string | null): number {
  const sec = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, MAX_BACKOFF_MS);
  return Math.min(base * 2 ** attempt, MAX_BACKOFF_MS);
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: AskJevOptions = {},
): Promise<JevResponse> {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? "";
  if (!apiKey) throw new JevError("TYPESAFE_API_KEY not configured", 503);
  validateJevQuestions(questions);

  const model = opts.model?.trim() || "jev-latest";
  const url = `${(opts.baseUrl || process.env.TYPESAFE_API_BASE || DEFAULT_BASE).replace(/\/+$/, "")}/v1/systemone`;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = Math.max(0, opts.retries ?? 2);
  const backoffMs = opts.backoffMs ?? 400;
  const body = JSON.stringify({ state: state ?? "", model, questions });
  const started = Date.now();

  let lastError: JevError = new JevError("Jev request failed", 502);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as Error)?.name === "AbortError";
      lastError = aborted
        ? new JevError(`Jev request timed out after ${timeoutMs}ms`, 504)
        : new JevError(`Jev network error: ${(err as Error)?.message ?? String(err)}`, 502);
      if (attempt < retries) { await sleep(retryDelay(attempt, backoffMs, null)); continue; }
      throw lastError;
    }
    clearTimeout(timer);

    const text = await res.text();
    if (res.ok) {
      let data: JevResponse;
      try { data = JSON.parse(text) as JevResponse; } catch {
        throw new JevError("Jev returned a non-JSON response", 502);
      }
      console.log(
        `[jev] model=${data.model} q=${Object.keys(questions).length} in=${data.usage?.input_tokens ?? "?"} out=${data.usage?.output_tokens ?? "?"} ms=${Date.now() - started}${attempt ? ` retries=${attempt}` : ""}`,
      );
      return data;
    }

    const detail = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new JevError(`Jev rejected the request (${res.status}): ${detail}`, res.status);
    lastError = new JevError(`Jev upstream error (${res.status}): ${detail}`, res.status === 429 ? 429 : 502);
    if (attempt < retries) { await sleep(retryDelay(attempt, backoffMs, res.headers.get("retry-after"))); continue; }
  }
  throw lastError;
}
