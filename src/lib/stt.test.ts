import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSttContext, looksLikeContextEcho } from "./stt";
import type { HistoryMessage } from "./services";

const H = "다음은 한국어 롤플레이 대화의 최근 내용이다. 등장인물 이름과 고유명사 표기를 참고하라.";
const ctx = `${H}\n유저: 어 지금 잘 되고 문제가 뭐냐면은\nAI: 증상이 구체적으로 나왔으니 기록과 맞춰보겠습니다.`;

test("문맥 누출 판별 — 머리말·대화 따라 읽기는 누출, 일반 발화는 아님", () => {
  assert.equal(looksLikeContextEcho(H, ctx), true);
  assert.equal(looksLikeContextEcho(`${H} 유저: 어 지금 잘 되고 문제가 뭐냐면은`, ctx), true);
  assert.equal(looksLikeContextEcho("증상이 구체적으로 나왔으니 기록과 맞춰보겠습니다", ctx), true);
  assert.equal(looksLikeContextEcho("둘 다 고쳐줘 아이폰 확인은 내가 할게", ctx), false);
  assert.equal(looksLikeContextEcho("잘 되고", ctx), false); // 짧은 겹침은 정상 발화일 수 있다
  assert.equal(looksLikeContextEcho("", ctx), false);
});

test("예전에 누출돼 기록에 남은 메시지는 문맥에서 뺀다 (악순환 차단)", () => {
  const history = [
    { id: "1", role: "user", content: `[STT] ${H} 유저: blah` },
    { id: "2", role: "assistant", content: "정상 응답입니다" },
  ] as HistoryMessage[];
  const built = buildSttContext(history);
  assert.ok(!built.includes("blah"));
  assert.ok(built.endsWith("AI: 정상 응답입니다"));
});
