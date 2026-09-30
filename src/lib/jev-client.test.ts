import { test } from "node:test";
import assert from "node:assert/strict";
import { askJev, JevError } from "./jev-client";

const Q = {
  next: {
    type: "choice" as const,
    instructions: "What would `actor` do next?",
    criteria: { eat: "Eat at camp", fish: "Fish at the river" },
  },
};
const OK_BODY = {
  model: "jev-1.13.0",
  answers: { next: { type: "choice", choice: "eat", confidence: 0.7, probabilities: { eat: 0.8, fish: 0.2 } } },
  usage: { input_tokens: 100, output_tokens: 10 },
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("키가 없으면 503 JevError — 네트워크를 타지 않는다", async () => {
  const f = fakeFetch([]);
  await assert.rejects(askJev({}, Q, { apiKey: "", fetchImpl: f.impl }), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.status, 503);
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test("질문 검증 실패는 400 — 빈 questions / 잘못된 type / score 레벨 1개 / choice 기준 없음", async () => {
  const f = fakeFetch([]);
  const bad: unknown[] = [
    {},
    { a: { type: "yesno", instructions: "x" } },
    { a: { type: "score", instructions: "x", criteria: ["only one"] } },
    { a: { type: "choice", instructions: "x", criteria: {} } },
    { a: { type: "noul" } },
  ];
  for (const q of bad) {
    await assert.rejects(
      askJev({}, q as never, { apiKey: "k", fetchImpl: f.impl }),
      (e: unknown) => e instanceof JevError && e.status === 400,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("state가 없으면 400 — TypeSafe까지 가지 않는다", async () => {
  const f = fakeFetch([]);
  for (const s of [undefined, null]) {
    await assert.rejects(
      askJev(s, Q, { apiKey: "k", fetchImpl: f.impl }),
      (e: unknown) => e instanceof JevError && e.status === 400 && /state/.test(e.message),
    );
  }
  assert.equal(f.calls.length, 0);
});

test("정상 응답은 가공 없이 통과하고 Bearer 키·기본 모델을 보낸다", async () => {
  const f = fakeFetch([json(200, OK_BODY)]);
  const r = await askJev({ actor: "Elena" }, Q, { apiKey: "k-123", fetchImpl: f.impl, baseUrl: "https://example.test" });
  assert.deepEqual(r, OK_BODY);
  assert.equal(f.calls[0].url, "https://example.test/v1/systemone");
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer k-123");
  const sent = JSON.parse(String(f.calls[0].init.body));
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(sent.state, { actor: "Elena" });
});

test("429는 retry-after를 따라 재시도한 뒤 성공한다", async () => {
  const f = fakeFetch([json(429, { error: "rate" }, { "retry-after": "0" }), json(200, OK_BODY)]);
  const r = await askJev({}, Q, { apiKey: "k", fetchImpl: f.impl });
  assert.equal(r.model, "jev-1.13.0");
  assert.equal(f.calls.length, 2);
});

test("400은 재시도하지 않고 TypeSafe 에러 본문을 전달한다", async () => {
  const f = fakeFetch([json(400, { detail: "bad criteria" })]);
  await assert.rejects(askJev({}, Q, { apiKey: "k", fetchImpl: f.impl }), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.status, 400);
    assert.match(e.message, /bad criteria/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("재시도 소진 후 5xx는 502로 실패한다", async () => {
  const f = fakeFetch([json(500, { e: 1 }), json(500, { e: 2 })]);
  await assert.rejects(
    askJev({}, Q, { apiKey: "k", fetchImpl: f.impl, retries: 1, backoffMs: 0 }),
    (e: unknown) => e instanceof JevError && e.status === 502,
  );
  assert.equal(f.calls.length, 2);
});

test("타임아웃은 504", async () => {
  const hang = (async (_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as typeof fetch;
  await assert.rejects(
    askJev({}, Q, { apiKey: "k", fetchImpl: hang, timeoutMs: 20, retries: 0 }),
    (e: unknown) => e instanceof JevError && e.status === 504,
  );
});
