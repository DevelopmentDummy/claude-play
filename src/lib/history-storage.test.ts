import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionInstance } from "./session-instance";
import type { SessionManager } from "./session-manager";
import { historyDraftPath, readHistoryJson, writeHistoryJson } from "./history-storage";

function fixture(t: TestContext, isBuilder = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-한글-"));
  const instances: SessionInstance[] = [];
  const create = () => {
    const sessions = { getPersonaDir: () => dir, getSessionDir: () => dir } as unknown as SessionManager;
    const instance = new SessionInstance("test", isBuilder, "codex", sessions, () => {});
    instance.ttsAutoPlay = false;
    t.mock.method(instance.panels, "reload", () => {});
    t.mock.method(instance.claude, "respawn", () => {});
    instances.push(instance);
    return instance;
  };
  t.after(() => { for (const i of instances) i.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, create, instance: create() };
}

function delta(i: SessionInstance, text: string) {
  i.claude.emit("message", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
}
function assistant(i: SessionInstance, text: string) {
  i.claude.emit("message", { type: "assistant", message: { content: [{ type: "text", text }] } });
}
function result(i: SessionInstance) {
  i.isOOC = true;
  i.claude.emit("message", { type: "result", stop_reason: "end_turn" });
}

test("builder checkpoints Korean commentary before result and recovers after restart", t => {
  const { dir, instance, create } = fixture(t);
  instance.addUserToHistory("재시작해", true);
  assistant(instance, "기존 재시작 API를 사용하겠습니다.");
  assert.equal(instance.chatHistory.length, 1);
  assert.ok(fs.existsSync(historyDraftPath(dir)));
  instance.destroy();
  const next = create();
  next.loadHistory();
  assert.equal(next.chatHistory[1].content, "기존 재시작 API를 사용하겠습니다.");
  assert.equal(fs.existsSync(historyDraftPath(dir)), false);
  next.loadHistory();
  assert.equal(next.chatHistory.length, 2);
});

test("stream deltas checkpoint within a bounded interval", async t => {
  const { dir, instance } = fixture(t);
  delta(instance, "블렌더 작업 중");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((readHistoryJson(historyDraftPath(dir)) as { content: string }).content, "블렌더 작업 중");
});

test("live history reload does not add a duplicate bubble; final result reuses checkpoint ID", t => {
  const { dir, instance, create } = fixture(t);
  instance.addUserToHistory("시작", true);
  assistant(instance, "작업 중");
  const draft = readHistoryJson(historyDraftPath(dir)) as { id: string };
  instance.addUserToHistory("계속해", true);
  instance.loadHistory();
  assert.equal(instance.chatHistory.length, 2);
  result(instance);
  assert.equal(instance.chatHistory[2].id, draft.id);
  assert.equal(new Set(instance.chatHistory.map(m => m.id)).size, 3);
  assert.equal(fs.existsSync(historyDraftPath(dir)), false);
  const next = create(); next.loadHistory();
  next.addUserToHistory("다음", true);
  assert.equal(new Set(next.chatHistory.map(m => m.id)).size, 4);
});

test("crash between final history save and draft removal does not duplicate the response", t => {
  const { dir, instance, create } = fixture(t);
  assistant(instance, "완료");
  const draft = readHistoryJson(historyDraftPath(dir));
  result(instance);
  writeHistoryJson(historyDraftPath(dir), draft);
  const next = create(); next.loadHistory();
  assert.equal(next.chatHistory.length, 1);
});

test("cancel saves a partial exactly once and clear prevents resurrection", t => {
  const { dir, instance, create } = fixture(t);
  assistant(instance, "중간 설명");
  instance.cancelStreaming();
  assert.equal(instance.chatHistory.length, 1);
  assert.equal(fs.existsSync(historyDraftPath(dir)), false);
  assistant(instance, "새 작업");
  instance.clearHistory();
  const next = create(); next.loadHistory();
  assert.deepEqual(next.chatHistory, []);
});

test("explicit restart flush persists a delta before the timer fires", t => {
  const { dir, instance } = fixture(t);
  delta(instance, "재시작 직전");
  assert.equal(instance.flushHistoryDraft(), true);
  assert.ok(fs.existsSync(historyDraftPath(dir)));
});

test("process exit and block completion checkpoint immediately", t => {
  const { dir, instance } = fixture(t);
  delta(instance, "첫 문장");
  instance.claude.emit("message", { type: "stream_event", event: { type: "content_block_stop" } });
  assert.equal((readHistoryJson(historyDraftPath(dir)) as { content: string }).content, "첫 문장");
  delta(instance, " 둘째 문장");
  instance.claude.emit("exit");
  assert.equal((readHistoryJson(historyDraftPath(dir)) as { content: string }).content, "첫 문장 둘째 문장");
});

test("checkpoint failure is observable and cannot approve restart", t => {
  const { dir, instance } = fixture(t);
  fs.writeFileSync(path.join(dir, ".claude"), "not a directory", "utf8");
  t.mock.method(console, "error", () => {});
  delta(instance, "저장 실패");
  assert.equal(instance.flushHistoryDraft(), false);
});

test("UTF-8 BOM and Korean history survive an atomic replacement", t => {
  const { dir, instance } = fixture(t);
  const file = path.join(dir, "chat-history.json");
  fs.writeFileSync(file, '\ufeff[{"id":"hist-u-30","role":"user","content":"한글"}]', "utf8");
  instance.loadHistory();
  instance.addUserToHistory("보존 확인", true);
  assert.equal(fs.readFileSync(file).subarray(0, 3).toString("hex"), "efbbbf");
  assert.equal(instance.chatHistory[1].id, "hist-u-31");
  assert.match(fs.readFileSync(file, "utf8"), /보존 확인/);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith(".tmp")), false);
});

test("malformed history is not silently replaced with an empty history", t => {
  const { dir, instance } = fixture(t);
  t.mock.method(console, "error", () => {});
  const file = path.join(dir, "chat-history.json");
  fs.writeFileSync(file, "{broken", "utf8");
  instance.loadHistory();
  instance.addUserToHistory("원본을 덮어쓰지 않는다", true);
  assert.equal(instance.saveHistory(), false);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("RP streaming does not create an unsanitized builder checkpoint", t => {
  const { dir, instance } = fixture(t, false);
  assistant(instance, "<hidden>RP internal</hidden>");
  assert.equal(instance.flushHistoryDraft(), true);
  assert.equal(fs.existsSync(historyDraftPath(dir)), false);
});
