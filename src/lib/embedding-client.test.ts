import { test } from "node:test";
import assert from "node:assert/strict";
import { embed, EmbedError, EMBED_MAX_INPUTS } from "./embedding-client";

type Body = { inputs: unknown[]; dim: number; task?: string };
type Call = { url: string; body: Body };
function fakeFetch(handler: (body: Body) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ url: String(url), body });
    return handler(body);
  }) as typeof fetch;
  return { impl, calls };
}
const ok = (b: Body) => new Response(JSON.stringify({
  model: "google/embeddinggemma-2", dim: b.dim, vectors: b.inputs.map(() => new Array(b.dim).fill(0)),
}), { status: 200 });

test("입력 검증은 네트워크 전에 400", async () => {
  const f = fakeFetch(ok);
  for (const bad of [[], [{}], [{ text: "  " }], [{ image: 1 }]]) {
    await assert.rejects(embed(bad as never, { fetchImpl: f.impl }), (e: unknown) => e instanceof EmbedError && e.status === 400);
  }
  await assert.rejects(embed([{ text: "a" }], { dim: 300 as never, fetchImpl: f.impl }), (e: unknown) => e instanceof EmbedError && e.status === 400);
  assert.equal(f.calls.length, 0);
});

test("64개 초과는 나눠 보내고 순서를 유지한다", async () => {
  const f = fakeFetch(ok);
  const inputs = Array.from({ length: EMBED_MAX_INPUTS + 6 }, (_, i) => ({ text: `t${i}` }));
  const r = await embed(inputs, { dim: 128, task: "document", fetchImpl: f.impl, baseUrl: "http://x" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.inputs.length, EMBED_MAX_INPUTS);
  assert.equal(f.calls[1].body.inputs.length, 6);
  assert.equal(f.calls[0].body.task, "document");
  assert.equal(f.calls[0].url, "http://x/embed");
  assert.equal(r.vectors.length, EMBED_MAX_INPUTS + 6);
  assert.equal(r.vectors[0].length, 128);
});

test("서버 오류 상태와 메시지를 그대로 올린다", async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ error: "unknown task 'x'" }), { status: 400 }));
  await assert.rejects(embed([{ text: "a" }], { fetchImpl: f.impl }), (e: unknown) =>
    e instanceof EmbedError && e.status === 400 && /unknown task/.test(e.message));
});

test("서버가 없으면 503", async () => {
  const impl = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(embed([{ text: "a" }], { fetchImpl: impl }), (e: unknown) => e instanceof EmbedError && e.status === 503);
});

test("벡터 개수가 안 맞는 응답은 502", async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ model: "m", vectors: [] }), { status: 200 }));
  await assert.rejects(embed([{ text: "a" }], { fetchImpl: f.impl }), (e: unknown) => e instanceof EmbedError && e.status === 502);
});
