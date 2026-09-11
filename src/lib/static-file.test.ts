import { test } from "node:test";
import assert from "node:assert/strict";
import { mimeForPath } from "./static-file";

test("앱 번들 확장자에 올바른 MIME을 준다", () => {
  assert.equal(mimeForPath("app/main.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeForPath("app/mod.mjs"), "text/javascript; charset=utf-8");
  assert.equal(mimeForPath("app/index.html"), "text/html; charset=utf-8");
  assert.equal(mimeForPath("app/style.css"), "text/css; charset=utf-8");
  assert.equal(mimeForPath("app/data.json"), "application/json; charset=utf-8");
});

test("기존 타입은 그대로다", () => {
  assert.equal(mimeForPath("a/b.png"), "image/png");
  assert.equal(mimeForPath("a/b.mp4"), "video/mp4");
  assert.equal(mimeForPath("a/b.unknown"), "application/octet-stream");
});
