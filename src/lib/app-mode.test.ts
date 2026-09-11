import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppMode } from "./app-mode";

test("app 설정이 없으면 null — 기존 페르소나 무영향", () => {
  assert.equal(resolveAppMode({ panels: { position: "right" } }), null);
  assert.equal(resolveAppMode(null), null);
  assert.equal(resolveAppMode({ app: null }), null);
});

test("app 설정의 기본값을 채운다", () => {
  const r = resolveAppMode({ app: { entry: "app/index.html" } });
  assert.deepEqual(r, {
    entry: "app/index.html",
    engine: "world",
    worldFile: "world.json",
    chatMode: "normal",
  });
});

test("chat.mode를 읽되 기존 chat 필드를 요구하지 않는다", () => {
  const r = resolveAppMode({ app: { entry: "a/i.html" }, chat: { maxWidth: 800, mode: "hidden" } });
  assert.equal(r?.chatMode, "hidden");
});

test("알 수 없는 chat.mode는 normal로 떨어진다", () => {
  const r = resolveAppMode({ app: { entry: "a/i.html" }, chat: { mode: "bogus" } });
  assert.equal(r?.chatMode, "normal");
});

test("worldFile은 .json이 강제되고 경로 구분자를 거부한다", () => {
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "w" } })?.worldFile, "w.json");
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "../w.json" } }), null);
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", worldFile: "sub/w.json" } }), null);
});

test("engine 이름은 경로 구분자를 거부한다", () => {
  assert.equal(resolveAppMode({ app: { entry: "a/i.html", engine: "../evil" } }), null);
});

test("entry가 없으면 null", () => {
  assert.equal(resolveAppMode({ app: { engine: "world" } }), null);
});
