import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMemo, extractLastUserPreview, MEMO_MAX_LEN } from "./session-memo";

test("clampMemo: 앞뒤 공백을 제거한다", () => {
  assert.equal(clampMemo("  배신 루트  "), "배신 루트");
});

test("clampMemo: 문자열이 아니면 빈 문자열", () => {
  assert.equal(clampMemo(null), "");
  assert.equal(clampMemo(42), "");
  assert.equal(clampMemo(undefined), "");
});

test("clampMemo: MEMO_MAX_LEN으로 자른다", () => {
  const out = clampMemo("가".repeat(500));
  assert.equal(out.length, MEMO_MAX_LEN);
});

test("extractLastUserPreview: 배열 형식 history에서 마지막 user 발화를 뽑는다", () => {
  const raw = JSON.stringify([
    { role: "user", content: "첫 발화" },
    { role: "assistant", content: "응답" },
    { role: "user", content: "마지막 발화" },
    { role: "assistant", content: "응답2" },
  ]);
  assert.equal(extractLastUserPreview(raw), "마지막 발화");
});

test("extractLastUserPreview: {messages:[…]} 형식도 지원한다", () => {
  const raw = JSON.stringify({ messages: [{ role: "user", content: "래핑된 발화" }] });
  assert.equal(extractLastUserPreview(raw), "래핑된 발화");
});

test("extractLastUserPreview: 개행/연속 공백을 한 줄로 접는다", () => {
  const raw = JSON.stringify([{ role: "user", content: "첫 줄\n\n둘째   줄" }]);
  assert.equal(extractLastUserPreview(raw), "첫 줄 둘째 줄");
});

test("extractLastUserPreview: maxLen 초과 시 말줄임표를 붙인다", () => {
  const raw = JSON.stringify([{ role: "user", content: "가".repeat(80) }]);
  const out = extractLastUserPreview(raw, 60);
  assert.equal(out, "가".repeat(60) + "…");
});

test("extractLastUserPreview: 이벤트 헤더 줄은 건너뛴다", () => {
  const raw = JSON.stringify([
    { role: "user", content: "진짜 발화" },
    { role: "user", content: "[MEMO] 지금까지의 전개를 요약하세요" },
  ]);
  assert.equal(extractLastUserPreview(raw), "진짜 발화");
});

test("extractLastUserPreview: 파싱 실패하면 undefined", () => {
  assert.equal(extractLastUserPreview("{깨진 json"), undefined);
});

test("extractLastUserPreview: user 발화가 없으면 undefined", () => {
  const raw = JSON.stringify([{ role: "assistant", content: "혼잣말" }]);
  assert.equal(extractLastUserPreview(raw), undefined);
});
