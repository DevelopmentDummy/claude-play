import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertCompatible, chunkText, collectionPath, decodeVector, emptyCollection, encodeVector, listCollections,
  loadCollection, pruneMissingSources, removeItems, saveCollection, searchCollection, upsertItems, withCollectionLock, VectorStoreError,
} from "./vector-store";

const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };

test("float32 base64 왕복", () => {
  const v = [0.1, -0.5, 0.25, 1];
  const back = Array.from(decodeVector(encodeVector(v)));
  back.forEach((x, i) => assert.ok(Math.abs(x - v[i]) < 1e-6));
});

test("검색은 내적 내림차순, topK·minScore·filter·modality 적용", () => {
  const col = emptyCollection("t", "m", 3);
  upsertItems(col, [
    { id: "a", vector: unit([1, 0, 0]), modality: "text", text: "A", meta: { kind: "x" } },
    { id: "b", vector: unit([1, 1, 0]), modality: "text", meta: { kind: "y" } },
    { id: "c", vector: unit([0, 0, 1]), modality: "image", source: "images/c.png" },
  ]);
  const q = unit([1, 0.1, 0]);
  assert.deepEqual(searchCollection(col, q).map((h) => h.id), ["a", "b", "c"]);
  assert.deepEqual(searchCollection(col, q, { topK: 1 }).map((h) => h.id), ["a"]);
  assert.deepEqual(searchCollection(col, q, { minScore: 0.5 }).map((h) => h.id), ["a", "b"]);
  assert.deepEqual(searchCollection(col, q, { filter: { kind: "y" } }).map((h) => h.id), ["b"]);
  assert.deepEqual(searchCollection(col, q, { modality: "image" }).map((h) => h.id), ["c"]);
  assert.equal(searchCollection(col, q)[0].text, "A");
});

test("dedupeBySource는 source당 최고점 하나만", () => {
  const col = emptyCollection("t", "m", 2);
  upsertItems(col, [
    { id: "img", vector: unit([1, 0]), modality: "image", source: "images/x.png" },
    { id: "cap", vector: unit([1, 0.2]), modality: "text", source: "images/x.png" },
    { id: "y", vector: unit([0, 1]), modality: "image", source: "images/y.png" },
  ]);
  const hits = searchCollection(col, unit([1, 0]), { dedupeBySource: true });
  assert.deepEqual(hits.map((h) => h.id), ["img", "y"]);
});

test("upsert는 같은 id를 교체하고 dim 불일치를 거부한다", () => {
  const col = emptyCollection("t", "m", 2);
  assert.deepEqual(upsertItems(col, [{ id: "a", vector: [1, 0], modality: "text" }]), { added: 1, updated: 0 });
  assert.deepEqual(upsertItems(col, [{ id: "a", vector: [0, 1], modality: "text" }]), { added: 0, updated: 1 });
  assert.equal(col.items.length, 1);
  assert.throws(() => upsertItems(col, [{ id: "b", vector: [1, 0, 0], modality: "text" }]), VectorStoreError);
});

test("모델·차원이 다르면 409", () => {
  const col = emptyCollection("t", "model-a", 768);
  assert.doesNotThrow(() => assertCompatible(col, "model-a", 768));
  assert.throws(() => assertCompatible(col, "model-a", 256), (e: unknown) => e instanceof VectorStoreError && e.status === 409);
  assert.throws(() => assertCompatible(col, "model-b", 768), (e: unknown) => e instanceof VectorStoreError && e.status === 409);
  assert.throws(() => searchCollection(col, [1, 0]), (e: unknown) => e instanceof VectorStoreError && e.status === 409);
});

test("컬렉션 이름 검증 — 경로 탈출 금지", () => {
  assert.ok(collectionPath("/base", "images.v1").endsWith(path.join("vectors", "images.v1.json")));
  for (const bad of ["../x", "a/b", "", ".hidden", "a..b"]) {
    assert.throws(() => collectionPath("/base", bad), VectorStoreError, bad);
  }
});

test("저장·로드 왕복 + 목록 + 삭제", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-"));
  try {
    const file = collectionPath(dir, "mem");
    const col = emptyCollection("mem", "m", 2);
    upsertItems(col, [{ id: "a", vector: [1, 0], modality: "text", source: "memory.md" }, { id: "b", vector: [0, 1], modality: "text" }]);
    saveCollection(file, col);
    const back = loadCollection(file)!;
    assert.equal(back.items.length, 2);
    assert.deepEqual(listCollections(dir), ["mem"]);
    assert.equal(removeItems(back, (it) => it.source === "memory.md"), 1);
    assert.deepEqual(back.items.map((i) => i.id), ["b"]);
    assert.equal(loadCollection(path.join(dir, "vectors", "none.json")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("같은 파일의 작업은 직렬화된다", async () => {
  const order: string[] = [];
  const slow = withCollectionLock("f", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); });
  const fast = withCollectionLock("f", async () => { order.push("fast"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["slow", "fast"]);
  await assert.rejects(withCollectionLock("f", () => { throw new Error("boom"); }));
  assert.equal(await withCollectionLock("f", () => 1), 1); // 앞선 실패가 다음 작업을 막지 않는다
});

test("chunkText — 제목 문맥을 붙이고 상한을 지킨다", () => {
  const md = "# 인물\n\n희명은 남자다.\n\n## 관계\n\n" + "아주 긴 문장입니다. ".repeat(80);
  const chunks = chunkText(md, 300);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 300 + 20));
  assert.ok(chunks.some((c) => c.includes("[관계]")));
  assert.deepEqual(chunkText("  \n\n "), []);
});

test("pruneMissingSources — 사라진 이미지의 캡션까지 지우고 다른 폴더는 건드리지 않는다", () => {
  const col = emptyCollection("g", "m", 2);
  upsertItems(col, [
    { id: "images/a.png", vector: [1, 0], modality: "image", source: "images/a.png" },
    { id: "images/a.png#caption", vector: [1, 0], modality: "text", source: "images/a.png", text: "유나, 옥상" },
    { id: "images/b.png", vector: [0, 1], modality: "image", source: "images/b.png" },
    { id: "images/sub/c.png", vector: [0, 1], modality: "image", source: "images/sub/c.png" },
    { id: "note", vector: [0, 1], modality: "text" },
  ]);
  const alive = new Set(["images/b.png"]);
  const removed = pruneMissingSources(col, "images", (s) => alive.has(s));
  assert.equal(removed, 2);
  assert.deepEqual(col.items.map((i) => i.id), ["images/b.png", "images/sub/c.png", "note"]);
});
