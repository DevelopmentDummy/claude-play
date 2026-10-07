// EmbeddingGemma 2 임베딩 서버(gpu-manager/embed_server.py) 클라이언트 — 코어의 단일 진입점.
// 서버는 GPU Manager와 별도 프로세스·별도 venv다(transformers 핀 충돌, playbook §5.19).
// 설계: docs/specs/2026-10-07-embedding-core-design.md
import { getEmbedUrl } from "./endpoints";

export type EmbedInput = { text: string } | { image: string };

/** 모델 내장 task 프롬프트 이름. 비대칭 검색은 query/document, 대칭 비교는 STS. */
export type EmbedTask =
  | "query" | "document" | "QuestionAnswering" | "CodeRetrieval"
  | "Classification" | "Clustering" | "STS" | (string & {});

export const EMBED_DIMS = [128, 256, 512, 768] as const;
export type EmbedDim = (typeof EMBED_DIMS)[number];
export const EMBED_MAX_INPUTS = 64;

export interface EmbedOptions {
  /** 텍스트 입력에만 붙는 task 프롬프트. 이미지에는 붙지 않는다. */
  task?: EmbedTask;
  /** Matryoshka 차원. 기본 768. 같은 컬렉션 안에서는 반드시 같은 값. */
  dim?: EmbedDim;
  timeoutMs?: number;
  // ── 테스트 주입용 ──
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface EmbedResult {
  model: string;
  dim: number;
  /** L2 정규화됨 — 코사인 = 내적. */
  vectors: number[][];
}

export class EmbedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "EmbedError";
  }
}

export function validateEmbedInputs(inputs: unknown): asserts inputs is EmbedInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new EmbedError("inputs must be a non-empty array", 400);
  inputs.forEach((it, i) => {
    const o = it as Record<string, unknown> | null;
    const ok = o && typeof o === "object" &&
      ((typeof o.text === "string" && o.text.trim() !== "") || (typeof o.image === "string" && o.image !== ""));
    if (!ok) throw new EmbedError(`inputs[${i}] must be { text } (non-empty) or { image: absolute path }`, 400);
  });
}

/**
 * 입력을 임베딩한다. EMBED_MAX_INPUTS(64)를 넘으면 자동으로 나눠 순서대로 보낸다.
 * 서버가 없으면(venv-embed 미설치·EMBED_ENABLED=false) 503 EmbedError.
 */
export async function embed(inputs: EmbedInput[], opts: EmbedOptions = {}): Promise<EmbedResult> {
  validateEmbedInputs(inputs);
  const dim = opts.dim ?? 768;
  if (!(EMBED_DIMS as readonly number[]).includes(dim)) throw new EmbedError(`dim must be one of ${EMBED_DIMS.join("/")}`, 400);
  const out: number[][] = [];
  let model = "";
  for (let i = 0; i < inputs.length; i += EMBED_MAX_INPUTS) {
    const r = await embedBatch(inputs.slice(i, i + EMBED_MAX_INPUTS), dim, opts);
    model = r.model;
    out.push(...r.vectors);
  }
  return { model, dim, vectors: out };
}

async function embedBatch(inputs: EmbedInput[], dim: number, opts: EmbedOptions): Promise<EmbedResult> {
  const f = opts.fetchImpl ?? fetch;
  // 콜드 로드(~13초) + 배치 시간. 전역 fetch 300초 벽(playbook §5.10)보다 충분히 짧다.
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await f(`${opts.baseUrl ?? getEmbedUrl()}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs, dim, ...(opts.task ? { task: opts.task } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new EmbedError(`embedding timed out after ${timeoutMs}ms`, 504);
    }
    throw new EmbedError("embedding server unavailable (gpu-manager/venv-embed not installed or EMBED_ENABLED=false)", 503);
  }
  const text = await res.text();
  let data: Partial<EmbedResult> & { error?: string };
  try { data = JSON.parse(text); } catch { throw new EmbedError(`embedding server returned non-JSON (${res.status})`, 502); }
  if (!res.ok) throw new EmbedError(data.error || `embedding failed (${res.status})`, res.status);
  if (!Array.isArray(data.vectors) || data.vectors.length !== inputs.length) {
    throw new EmbedError("embedding server returned a malformed response", 502);
  }
  console.log(`[embed] n=${inputs.length} task=${opts.task ?? "-"} dim=${dim} ms=${Date.now() - t0}`);
  return { model: String(data.model), dim, vectors: data.vectors };
}

/** 모델 선로딩(응답을 기다리지 않음). 10초 제한이 있는 페르소나 도구가 콜드 로드에 걸리지 않게 먼저 부른다. */
export async function warmupEmbedder(opts: Pick<EmbedOptions, "baseUrl" | "fetchImpl"> = {}): Promise<{ ok: boolean; loaded?: boolean }> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? getEmbedUrl()}/warmup`, {
      method: "POST", signal: AbortSignal.timeout(3000),
    });
    return (await res.json()) as { ok: boolean; loaded?: boolean };
  } catch {
    return { ok: false };
  }
}
