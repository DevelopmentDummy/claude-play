import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { flattenGeneratedFile, cleanupEmptyImagesDir } from "./flatten";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flatten-"));
}

test("images/ 하위 파일을 outputDir 직하로 이동하고 절대경로 반환", () => {
  const dir = makeTmp();
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "images", "foo.png"), "x");
  const abs = flattenGeneratedFile(dir, "images/foo.png");
  assert.strictEqual(abs, path.join(dir, "foo.png"));
  assert.ok(fs.existsSync(abs));
  assert.ok(!fs.existsSync(path.join(dir, "images", "foo.png")));
});

test("하위 디렉토리 포함 상대경로도 보존 이동", () => {
  const dir = makeTmp();
  fs.mkdirSync(path.join(dir, "images", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "images", "sub", "bar.png"), "x");
  const abs = flattenGeneratedFile(dir, "images/sub/bar.png");
  assert.strictEqual(abs, path.join(dir, "sub", "bar.png"));
  assert.ok(fs.existsSync(abs));
});

test("images/ 접두사 없는 경로는 이동 없이 절대화만", () => {
  const dir = makeTmp();
  fs.writeFileSync(path.join(dir, "baz.png"), "x");
  assert.strictEqual(flattenGeneratedFile(dir, "baz.png"), path.join(dir, "baz.png"));
});

test("동명 파일 존재 시 덮어쓰기", () => {
  const dir = makeTmp();
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "images", "foo.png"), "new");
  fs.writeFileSync(path.join(dir, "foo.png"), "old");
  flattenGeneratedFile(dir, "images/foo.png");
  assert.strictEqual(fs.readFileSync(path.join(dir, "foo.png"), "utf-8"), "new");
});

test("cleanupEmptyImagesDir — 빈 경우만 제거", () => {
  const dir = makeTmp();
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  cleanupEmptyImagesDir(dir);
  assert.ok(!fs.existsSync(path.join(dir, "images")));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "images", "keep.png"), "x");
  cleanupEmptyImagesDir(dir);
  assert.ok(fs.existsSync(path.join(dir, "images", "keep.png")));
});
