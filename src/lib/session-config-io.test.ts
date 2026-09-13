import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readLayout } from "./session-config-io";
import { resolveAppMode } from "./app-mode";

function tmpLayout(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-io-"));
  if (content !== null) fs.writeFileSync(path.join(dir, "layout.json"), content, "utf-8");
  return dir;
}

test("app 블록이 없으면 결과에도 app 키가 없다 — 기존 페르소나 무영향", () => {
  const dir = tmpLayout(JSON.stringify({ panels: { position: "left" }, theme: { accent: "#123456" } }));
  const r = readLayout(dir);
  assert.equal("app" in r, false);
  assert.equal(r.panels.position, "left");
  assert.equal(r.panels.size, 380);
  assert.equal(r.theme.accent, "#123456");
  assert.equal(r.theme.bg, "#0f0f1a");
  assert.equal(resolveAppMode(r), null);
});

test("app 블록과 chat.mode가 보존되고 기본값이 병합된다", () => {
  const dir = tmpLayout(JSON.stringify({
    app: { entry: "app/index.html", engine: "world", worldFile: "world.json", worldTickMs: 200 },
    chat: { mode: "dock" },
    panels: { position: "hidden" },
  }));
  const r = readLayout(dir);
  assert.deepEqual(r.app, { entry: "app/index.html", engine: "world", worldFile: "world.json", worldTickMs: 200 });
  assert.equal(r.chat.mode, "dock");
  assert.equal(r.chat.align, "stretch");
  assert.equal(r.panels.position, "hidden");
  assert.equal(r.customCSS, "");

  const app = resolveAppMode(r);
  assert.ok(app);
  assert.equal(app.entry, "app/index.html");
  assert.equal(app.worldTickMs, 200);
  assert.equal(app.chatMode, "dock");
});

test("app이 객체가 아니면 통과시키지 않는다", () => {
  const dir = tmpLayout(JSON.stringify({ app: "app/index.html" }));
  const r = readLayout(dir);
  assert.equal("app" in r, false);
});

test("잘못된 app 설정은 readLayout이 통과시키고 resolveAppMode가 거른다", () => {
  const dir = tmpLayout(JSON.stringify({ app: { entry: "../evil.html" } }));
  const r = readLayout(dir);
  assert.deepEqual(r.app, { entry: "../evil.html" });
  assert.equal(resolveAppMode(r), null);
});

test("파일이 없거나 파싱 실패면 기본값 — app 없음", () => {
  assert.equal("app" in readLayout(tmpLayout(null)), false);
  assert.equal("app" in readLayout(tmpLayout("{ not json")), false);
});
