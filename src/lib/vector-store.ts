// 파일 기반 벡터 컬렉션 — 임베딩 인프라의 저장 계층.
// 컬렉션 하나 = {baseDir}/vectors/{name}.json. 벡터는 float32 base64로 저장한다.
// 헤더의 model/dim이 다른 벡터는 섞지 않는다(검색·추가 모두 거부) — 모델 교체나
// Matryoshka 차원 혼용으로 공간이 섞이는 걸 막는 유일한 장치다.
// 설계: docs/specs/2026-10-07-embedding-core-design.md
import * as fs from "fs";
import * as path from "path";

export type VectorModality = "text" | "image";

export interface VectorItem {
  id: string;
  vector: number[];
  modality: VectorModality;
  /** 텍스트 원문(텍스트 항목) 또는 캡션(이미지 항목). 검색 결과에 그대로 돌아온다. */
  text?: string;
  /** 원본 파일(스코프 기준 상대 경로). index_dir/index_file의 증분·정리에 쓰인다. */
  source?: string;
  sourceMtimeMs?: number;
  meta?: Record<string, unknown>;
}

interface StoredItem extends Omit<VectorItem, "vector"> {
  v: string; // float32 little-endian, base64
  updatedAt: string;
}

export interface VectorCollection {
  version: 1;
  name: string;
  model: string;
  dim: number;
  createdAt: string;
  updatedAt: string;
  items: StoredItem[];
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  /** meta 필드 값이 전부 일치하는 항목만(얕은 비교). */
  filter?: Record<string, unknown>;
  modality?: VectorModality;
  /** 같은 source에서 가장 높은 점수 하나만 남긴다(이미지 + 캡션을 함께 넣었을 때 등). */
  dedupeBySource?: boolean;
}

export interface SearchHit {
  id: string;
  score: number;
  modality: VectorModality;
  text?: string;
  source?: string;
  meta?: Record<string, unknown>;
}

export class VectorStoreError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "VectorStoreError";
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function collectionPath(baseDir: string, name: string): string {
  if (!NAME_RE.test(name) || name.includes("..")) {
    throw new VectorStoreError(`invalid collection name "${name}" (letters, digits, . _ -; max 64)`, 400);
  }
  return path.join(baseDir, "vectors", `${name}.json`);
}

export function encodeVector(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString("base64");
}

export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  // 정렬된 새 버퍼로 복사 — Buffer 풀의 offset이 4의 배수라는 보장이 없다.
  const out = new Float32Array(buf.length / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

/** 두 벡터 모두 L2 정규화돼 있다는 전제 — 내적이 곧 코사인. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function emptyCollection(name: string, model: string, dim: number): VectorCollection {
  const now = new Date().toISOString();
  return { version: 1, name, model, dim, createdAt: now, updatedAt: now, items: [] };
}

export function loadCollection(file: string): VectorCollection | null {
  if (!fs.existsSync(file)) return null;
  const col = JSON.parse(fs.readFileSync(file, "utf8")) as VectorCollection;
  if (col.version !== 1 || !Array.isArray(col.items)) throw new VectorStoreError(`unsupported collection file: ${file}`, 500);
  return col;
}

/** tmp → rename 원자 쓰기. 같은 프로세스 안의 동시 갱신은 withCollectionLock으로 직렬화한다. */
export function saveCollection(file: string, col: VectorCollection): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  col.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(col));
  fs.renameSync(tmp, file);
}

const locks = new Map<string, Promise<unknown>>();

export function withCollectionLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(file, next);
  void next.finally(() => { if (locks.get(file) === next) locks.delete(file); }).catch(() => undefined);
  return next;
}

export function assertCompatible(col: VectorCollection, model: string, dim: number): void {
  if (col.model !== model || col.dim !== dim) {
    throw new VectorStoreError(
      `collection "${col.name}" was built with ${col.model} @ dim ${col.dim}; this request uses ${model} @ dim ${dim}. ` +
      `Use the same dim, or drop and rebuild the collection.`, 409);
  }
}

export function upsertItems(col: VectorCollection, items: VectorItem[]): { added: number; updated: number } {
  const index = new Map(col.items.map((it, i) => [it.id, i]));
  const now = new Date().toISOString();
  let added = 0, updated = 0;
  for (const it of items) {
    if (!it.id) throw new VectorStoreError("every item needs an id", 400);
    if (it.vector.length !== col.dim) throw new VectorStoreError(`item "${it.id}": vector dim ${it.vector.length} ≠ collection dim ${col.dim}`, 400);
    const { vector, ...rest } = it;
    const stored: StoredItem = { ...rest, v: encodeVector(vector), updatedAt: now };
    const at = index.get(it.id);
    if (at === undefined) { index.set(it.id, col.items.length); col.items.push(stored); added++; }
    else { col.items[at] = stored; updated++; }
  }
  return { added, updated };
}

export function removeItems(col: VectorCollection, pred: (it: Omit<VectorItem, "vector">) => boolean): number {
  const before = col.items.length;
  col.items = col.items.filter((it) => !pred(it));
  return before - col.items.length;
}

function matchesFilter(meta: Record<string, unknown> | undefined, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (!meta || meta[k] !== v) return false;
  }
  return true;
}

export function searchCollection(col: VectorCollection, query: ArrayLike<number>, opts: SearchOptions = {}): SearchHit[] {
  if (query.length !== col.dim) throw new VectorStoreError(`query dim ${query.length} ≠ collection dim ${col.dim}`, 409);
  const topK = Math.max(1, Math.min(opts.topK ?? 5, 100));
  const hits: SearchHit[] = [];
  for (const it of col.items) {
    if (opts.modality && it.modality !== opts.modality) continue;
    if (opts.filter && !matchesFilter(it.meta, opts.filter)) continue;
    const score = dot(query, decodeVector(it.v));
    if (opts.minScore !== undefined && score < opts.minScore) continue;
    hits.push({ id: it.id, score: Math.round(score * 10000) / 10000, modality: it.modality, text: it.text, source: it.source, meta: it.meta });
  }
  hits.sort((a, b) => b.score - a.score);
  if (!opts.dedupeBySource) return hits.slice(0, topK);
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = h.source ?? h.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= topK) break;
  }
  return out;
}

export function describeCollection(col: VectorCollection) {
  const sources = new Set(col.items.map((i) => i.source).filter(Boolean));
  return {
    name: col.name, model: col.model, dim: col.dim, count: col.items.length,
    text: col.items.filter((i) => i.modality === "text").length,
    image: col.items.filter((i) => i.modality === "image").length,
    sources: sources.size, createdAt: col.createdAt, updatedAt: col.updatedAt,
  };
}

/** {baseDir}/vectors/*.json 컬렉션 이름 목록. */
export function listCollections(baseDir: string): string[] {
  const dir = path.join(baseDir, "vectors");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/**
 * 마크다운/평문을 검색 단위로 자른다. 제목(#)과 빈 줄을 경계로 문단을 모으고,
 * maxChars를 넘는 문단은 문장/줄 단위로 다시 자른다. 각 조각 앞에 가장 가까운 제목을 붙여 문맥을 살린다.
 */
export function chunkText(text: string, maxChars = 1000): string[] {
  const limit = Math.max(200, Math.min(maxChars, 4000));
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n|(?=^#{1,6}\s)/m).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let heading = "";
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const block of blocks) {
    let body = block;
    const h = block.match(/^#{1,6}\s+(.+)$/m);
    if (h && block.startsWith("#")) {
      // 제목 줄은 본문에서 빼고 이후 조각들의 [제목] 접두로만 쓴다(제목만 있는 조각이 생기지 않게).
      flush();
      heading = h[1].trim();
      body = block.split("\n").slice(1).join("\n").trim();
      if (!body) continue;
    }
    const prefix = heading ? `[${heading}] ` : "";
    const room = Math.max(100, limit - prefix.length);
    for (const p of body.length > room ? splitLong(body, room) : [body]) {
      if (cur && cur.length + p.length + 2 > limit) flush();
      cur = cur ? `${cur}\n\n${p}` : prefix + p;
    }
  }
  flush();
  return chunks;
}

function splitLong(block: string, limit: number): string[] {
  const parts = block.split(/(?<=[.!?。！？])\s+|\n/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (p.length > limit) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < p.length; i += limit) out.push(p.slice(i, i + limit));
      continue;
    }
    if (cur && cur.length + p.length + 1 > limit) { out.push(cur); cur = ""; }
    cur += (cur ? " " : "") + p;
  }
  if (cur) out.push(cur);
  return out;
}
