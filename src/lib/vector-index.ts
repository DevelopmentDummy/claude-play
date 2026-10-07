// 임베딩 인프라의 액션 디스패처 — 모든 소비자(API /api/sessions/[id]/vectors, MCP vector_*,
// 페르소나 도구 context.vectors, 패널 __panelBridge.vectors)가 이 함수 하나를 거친다.
// 설계: docs/specs/2026-10-07-embedding-core-design.md
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./data-dir";
import { embed, warmupEmbedder, EmbedError, type EmbedDim, type EmbedInput, type EmbedTask } from "./embedding-client";
import {
  assertCompatible, chunkText, collectionPath, describeCollection, emptyCollection, listCollections,
  loadCollection, pruneMissingSources, removeItems, saveCollection, searchCollection, upsertItems, withCollectionLock,
  VectorStoreError, type SearchOptions, type VectorCollection, type VectorItem,
} from "./vector-store";

export type VectorScope = "session" | "persona" | "global";

export interface VectorContext {
  sessionDir: string;
  personaDir: string | null;
}

export const VECTOR_ACTIONS = [
  "warmup", "embed", "upsert", "search", "delete", "list", "info", "drop", "index_dir", "index_file",
] as const;
export type VectorAction = (typeof VECTOR_ACTIONS)[number];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const INDEX_DIR_DEFAULT_LIMIT = 200;

type Params = Record<string, unknown>;

function str(p: Params, k: string, required = false): string | undefined {
  const v = p[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new VectorStoreError(`"${k}" is required`, 400);
    return undefined;
  }
  if (typeof v !== "string") throw new VectorStoreError(`"${k}" must be a string`, 400);
  return v;
}

function num(p: Params, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new VectorStoreError(`"${k}" must be a number`, 400);
  return n;
}

function scopeOf(p: Params): VectorScope {
  const s = p.scope ?? "session";
  if (s !== "session" && s !== "persona" && s !== "global") throw new VectorStoreError(`scope must be session | persona | global`, 400);
  return s;
}

export function scopeBaseDir(ctx: VectorContext, scope: VectorScope): string {
  if (scope === "session") return ctx.sessionDir;
  if (scope === "persona") {
    if (!ctx.personaDir) throw new VectorStoreError("this session has no persona — persona scope is unavailable", 400);
    return ctx.personaDir;
  }
  return getDataDir();
}

/** 스코프 기준 상대 경로(또는 절대 경로)를 data/ 안쪽 절대 경로로 푼다. 밖으로 나가면 거부. */
export function resolveInScope(baseDir: string, rel: string): string {
  const abs = path.resolve(baseDir, rel);
  const root = path.resolve(getDataDir());
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new VectorStoreError(`path escapes the data directory: ${rel}`, 400);
  }
  return abs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** 입력 항목의 image 경로를 절대 경로로 바꿔 임베딩 서버에 넘길 형태로 만든다. */
function toEmbedInput(baseDir: string, it: { text?: string; image?: string }): EmbedInput {
  if (it.image) {
    const abs = resolveInScope(baseDir, it.image);
    if (!fs.existsSync(abs)) throw new VectorStoreError(`image not found: ${it.image}`, 404);
    return { image: abs };
  }
  if (typeof it.text === "string" && it.text.trim()) return { text: it.text };
  throw new VectorStoreError("each item needs text or image", 400);
}

type MutateResult = { col: VectorCollection | null; result: Record<string, unknown> };

async function mutate(file: string, fn: (col: VectorCollection | null) => Promise<MutateResult>): Promise<Record<string, unknown>> {
  return withCollectionLock(file, async () => {
    const { col, result } = await fn(loadCollection(file));
    if (col) saveCollection(file, col);
    return result;
  });
}

function openOrCreate(col: VectorCollection | null, name: string, model: string, dim: number): VectorCollection {
  if (!col) return emptyCollection(name, model, dim);
  assertCompatible(col, model, dim);
  return col;
}

/** 기존 컬렉션이 있으면 그 dim을 따르고, 없으면 요청값(기본 768). */
function pickDim(file: string, p: Params): EmbedDim {
  const asked = num(p, "dim");
  const existing = fs.existsSync(file) ? loadCollection(file)?.dim : undefined;
  if (existing && asked && existing !== asked) {
    throw new VectorStoreError(`collection dim is ${existing}; requested dim ${asked}. Omit dim or drop the collection.`, 409);
  }
  return (existing ?? asked ?? 768) as EmbedDim;
}

export async function runVectorAction(ctx: VectorContext, action: string, params: Params = {}): Promise<unknown> {
  const p = params ?? {};
  switch (action as VectorAction) {
    case "warmup":
      return warmupEmbedder();

    case "embed": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const items = p.inputs;
      if (!Array.isArray(items)) throw new VectorStoreError(`"inputs" must be an array of { text } | { image }`, 400);
      const inputs = items.map((it) => toEmbedInput(base, (it ?? {}) as { text?: string; image?: string }));
      return embed(inputs, { task: str(p, "task") as EmbedTask | undefined, dim: num(p, "dim") as EmbedDim | undefined });
    }

    case "upsert": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const file = collectionPath(base, name);
      const raw = p.items;
      if (!Array.isArray(raw) || raw.length === 0) throw new VectorStoreError(`"items" must be a non-empty array`, 400);
      const items = raw.map((r, i) => {
        const o = (r ?? {}) as Record<string, unknown>;
        if (typeof o.id !== "string" || !o.id) throw new VectorStoreError(`items[${i}].id is required`, 400);
        return o as { id: string; text?: string; image?: string; caption?: string; source?: string; meta?: Record<string, unknown> };
      });
      const dim = pickDim(file, p);
      const task = (str(p, "task") ?? "document") as EmbedTask;
      // 이미지와 텍스트는 서버가 알아서 나눠 처리한다(task는 텍스트에만 붙는다).
      const r = await embed(items.map((it) => toEmbedInput(base, it)), { task, dim });
      return mutate(file, async (cur) => {
        const col = openOrCreate(cur, name, r.model, dim);
        const vitems: VectorItem[] = items.map((it, i) => ({
          id: it.id,
          vector: r.vectors[i],
          modality: it.image ? "image" : "text",
          text: it.image ? it.caption ?? it.text : it.text,
          source: it.source ?? it.image,
          meta: it.meta,
        }));
        const counts = upsertItems(col, vitems);
        return { col, result: { collection: name, ...counts, total: col.items.length } };
      });
    }

    case "search": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const col = loadCollection(collectionPath(base, name));
      if (!col) throw new VectorStoreError(`collection "${name}" does not exist in this scope`, 404);
      const query = str(p, "query");
      const image = str(p, "image");
      if (!query && !image) throw new VectorStoreError(`search needs "query" (text) or "image" (path)`, 400);
      const r = await embed([image ? toEmbedInput(base, { image }) : { text: query! }], {
        task: (str(p, "task") ?? "query") as EmbedTask, dim: col.dim as EmbedDim,
      });
      assertCompatible(col, r.model, r.dim);
      const opts: SearchOptions = {
        topK: num(p, "topK"), minScore: num(p, "minScore"),
        filter: p.filter && typeof p.filter === "object" ? (p.filter as Record<string, unknown>) : undefined,
        modality: p.modality === "text" || p.modality === "image" ? p.modality : undefined,
        dedupeBySource: p.dedupeBySource === true,
      };
      return { collection: name, hits: searchCollection(col, r.vectors[0], opts) };
    }

    case "delete": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const ids = Array.isArray(p.ids) ? new Set(p.ids.map(String)) : null;
      const source = str(p, "source");
      if (!ids && !source) throw new VectorStoreError(`delete needs "ids" or "source"`, 400);
      return mutate(collectionPath(base, name), async (col) => {
        if (!col) return { col: null, result: { removed: 0 } };
        const removed = removeItems(col, (it) => (ids?.has(it.id) ?? false) || (source !== undefined && it.source === source));
        return { col, result: { collection: name, removed, total: col.items.length } };
      });
    }

    case "list": {
      const scopes: VectorScope[] = p.scope ? [scopeOf(p)] : ctx.personaDir ? ["session", "persona", "global"] : ["session", "global"];
      const out: Record<string, unknown[]> = {};
      for (const s of scopes) {
        const base = scopeBaseDir(ctx, s);
        out[s] = listCollections(base).map((n) => {
          try { const c = loadCollection(collectionPath(base, n)); return c ? describeCollection(c) : { name: n }; }
          catch { return { name: n, error: "unreadable" }; }
        });
      }
      return out;
    }

    case "info": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const col = loadCollection(collectionPath(base, name));
      if (!col) throw new VectorStoreError(`collection "${name}" does not exist in this scope`, 404);
      const sample = col.items.slice(0, 5).map((i) => ({ id: i.id, modality: i.modality, source: i.source, text: i.text?.slice(0, 80) }));
      return { ...describeCollection(col), sample };
    }

    case "drop": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const file = collectionPath(base, str(p, "collection", true)!);
      return withCollectionLock(file, () => {
        const existed = fs.existsSync(file);
        if (existed) fs.unlinkSync(file);
        return { dropped: existed };
      });
    }

    case "index_dir": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const file = collectionPath(base, name);
      const dirRel = str(p, "dir") ?? "images";
      const dirAbs = resolveInScope(base, dirRel);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) throw new VectorStoreError(`directory not found: ${dirRel}`, 404);
      const limit = Math.max(1, Math.min(num(p, "limit") ?? INDEX_DIR_DEFAULT_LIMIT, 1000));
      const prune = p.prune !== false;
      const files = fs.readdirSync(dirAbs, { withFileTypes: true })
        .filter((d) => d.isFile() && IMAGE_EXTS.has(path.extname(d.name).toLowerCase()) && !d.name.startsWith("_"))
        .map((d) => {
          const abs = path.join(dirAbs, d.name);
          return { rel: toPosix(path.relative(base, abs)), abs, mtimeMs: Math.floor(fs.statSync(abs).mtimeMs) };
        });
      const dim = pickDim(file, p);
      const existing = loadCollection(file);
      const known = new Map((existing?.items ?? []).filter((i) => i.modality === "image").map((i) => [i.id, i.sourceMtimeMs]));
      const todo = files.filter((f) => known.get(f.rel) !== f.mtimeMs);
      const batch = todo.slice(0, limit);
      const r = batch.length ? await embed(batch.map((f) => ({ image: f.abs })), { dim }) : null;
      return mutate(file, async (cur) => {
        const col = r ? openOrCreate(cur, name, r.model, dim) : cur;
        let added = 0, updated = 0, pruned = 0;
        if (col && r) {
          ({ added, updated } = upsertItems(col, batch.map((f, i) => ({
            id: f.rel, vector: r.vectors[i], modality: "image", source: f.rel, sourceMtimeMs: f.mtimeMs,
          }))));
        }
        if (col && prune) {
          // 이미지 벡터만이 아니라 같은 source의 캡션 텍스트까지 지운다 — 남으면 죽은 $IMAGE 경로가 검색에 뜬다.
          pruned = pruneMissingSources(col, toPosix(path.relative(base, dirAbs)),
            (src) => { try { return fs.existsSync(resolveInScope(base, src)); } catch { return false; } });
        }
        return {
          col,
          result: { collection: name, scanned: files.length, embedded: batch.length, added, updated, pruned,
            remaining: todo.length - batch.length, total: col?.items.length ?? 0 },
        };
      });
    }

    case "index_file": {
      const base = scopeBaseDir(ctx, scopeOf(p));
      const name = str(p, "collection", true)!;
      const file = collectionPath(base, name);
      const rel = str(p, "file", true)!;
      const abs = resolveInScope(base, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new VectorStoreError(`file not found: ${rel}`, 404);
      const source = toPosix(path.relative(base, abs));
      const mtimeMs = Math.floor(fs.statSync(abs).mtimeMs);
      const existing = loadCollection(file);
      const prior = (existing?.items ?? []).filter((i) => i.source === source);
      if (prior.length && p.force !== true && prior.every((i) => i.sourceMtimeMs === mtimeMs)) {
        return { collection: name, source, unchanged: true, chunks: prior.length };
      }
      const chunks = chunkText(fs.readFileSync(abs, "utf8"), num(p, "chunkChars") ?? 1000);
      const dim = pickDim(file, p);
      const r = chunks.length ? await embed(chunks.map((text) => ({ text })), { task: "document", dim }) : null;
      return mutate(file, async (cur) => {
        const col = r ? openOrCreate(cur, name, r.model, dim) : cur;
        if (!col) return { col: null, result: { collection: name, source, chunks: 0 } };
        const removed = removeItems(col, (it) => it.source === source);
        if (r) {
          upsertItems(col, chunks.map((text, i) => ({
            id: `${source}#${i}`, vector: r.vectors[i], modality: "text", text, source, sourceMtimeMs: mtimeMs, meta: { chunk: i },
          })));
        }
        return { col, result: { collection: name, source, chunks: chunks.length, replaced: removed, total: col.items.length } };
      });
    }

    default:
      throw new VectorStoreError(`unknown action "${action}". Actions: ${VECTOR_ACTIONS.join(", ")}`, 400);
  }
}

/** API/도구 응답용 — 오류를 HTTP 상태로 매핑. */
export function vectorErrorStatus(err: unknown): number {
  if (err instanceof VectorStoreError || err instanceof EmbedError) return err.status;
  return 500;
}
