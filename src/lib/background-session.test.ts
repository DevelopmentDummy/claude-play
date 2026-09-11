import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ClaudeProcess } from "./claude-process";
import { spawnBackgroundAI, destroyBackgroundProcessesForDir, destroyAllBackgroundProcesses } from "./background-session";

test("directory cleanup cancels pending background jobs without sending or completing", async (t) => {
  const spawned: ClaudeProcess[] = [];
  const killed: ClaudeProcess[] = [];
  const sent: ClaudeProcess[] = [];
  const ready: Array<(value: boolean) => void> = [];
  t.mock.method(ClaudeProcess.prototype, "spawn", function (this: ClaudeProcess) { spawned.push(this); });
  t.mock.method(ClaudeProcess.prototype, "kill", function (this: ClaudeProcess) {
    killed.push(this);
    this.emit("exit", 1); // Some providers emit synchronously on kill.
  });
  t.mock.method(ClaudeProcess.prototype, "waitForReady", () => new Promise<boolean>(resolve => ready.push(resolve)));
  t.mock.method(ClaudeProcess.prototype, "isRunning", () => true);
  t.mock.method(ClaudeProcess.prototype, "send", function (this: ClaudeProcess) { sent.push(this); });
  t.after(() => destroyAllBackgroundProcesses());
  const dir = path.resolve("scratch", "background-delete-test");
  for (const sessionDir of [dir, path.join(dir, "child"), `${dir}-other`]) {
    spawnBackgroundAI({ sessionDir, prompt: "test", model: "sonnet", notify: true, autoResume: true, callerSessionId: "test" });
  }
  destroyBackgroundProcessesForDir(dir);
  assert.deepEqual(killed, spawned.slice(0, 2));
  for (const resolve of ready) resolve(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [spawned[2]], "cancelled jobs must not dispatch after readiness resolves");
  destroyBackgroundProcessesForDir(dir);
  assert.equal(killed.length, 2, "cleanup is idempotent");
  destroyBackgroundProcessesForDir(`${dir}-other`);
  assert.deepEqual(killed, spawned);
});
