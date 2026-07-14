import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getExternalToken, getExternalTokenPath, validateExternalToken } from "./token";

// getDataDir()는 호출 시점에 DATA_DIR env를 읽으므로, 첫 함수 호출 전에만 설정하면 격리된다
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ext-token-"));

test("최초 호출 시 토큰 생성·영속화, 이후 동일 값 반환", () => {
  const t1 = getExternalToken();
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.readFileSync(getExternalTokenPath(), "utf-8").trim(), t1);
  assert.strictEqual(getExternalToken(), t1);
});

test("validateExternalToken — 일치/불일치/누락", () => {
  const t = getExternalToken();
  assert.strictEqual(validateExternalToken(t), true);
  assert.strictEqual(validateExternalToken("wrong"), false);
  assert.strictEqual(validateExternalToken(undefined), false);
  assert.strictEqual(validateExternalToken([t, t]), false); // 배열 헤더는 거부
});
