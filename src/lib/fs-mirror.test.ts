import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { refreshDirectoryWithBackups } from "./fs-mirror";
import { SessionManager } from "./session-manager";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-refresh-"));
  const src = path.join(root, "persona", "skills"), dest = path.join(root, "session", ".agents", "skills"), backup = path.join(root, "session", ".skill-backups");
  const put = (file: string, value: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  return { root, src, dest, backup, put };
}

test("refresh skills: adds nested resources, backs up edits, preserves local files and bytes", () => {
  const { src, dest, backup, put } = fixture();
  put(path.join(src, "robot", "SKILL.md"), "새 원본 스킬\n");
  put(path.join(src, "robot", "references", "evidence.png"), Buffer.from([0, 128, 255]));
  put(path.join(dest, "robot", "SKILL.md"), "세션 수정본\n");
  put(path.join(dest, "local-only", "SKILL.md"), "keep");
  refreshDirectoryWithBackups(src, dest, backup);
  assert.equal(fs.readFileSync(path.join(dest, "robot", "SKILL.md"), "utf8"), "새 원본 스킬\n");
  assert.deepEqual(fs.readFileSync(path.join(dest, "robot", "references", "evidence.png")), Buffer.from([0, 128, 255]));
  assert.equal(fs.readFileSync(path.join(dest, "local-only", "SKILL.md"), "utf8"), "keep");
  const saved = fs.readdirSync(path.join(backup, "robot"));
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(backup, "robot", saved[0]), "utf8"), "세션 수정본\n");
  const before = fs.statSync(path.join(dest, "robot", "SKILL.md")).mtimeMs;
  refreshDirectoryWithBackups(src, dest, backup);
  assert.equal(fs.statSync(path.join(dest, "robot", "SKILL.md")).mtimeMs, before);
  assert.equal(fs.readdirSync(path.join(backup, "robot")).length, 1);
});

test("missing persona skills is a no-op; source deletion does not delete local content", () => {
  const { src, dest, backup, put } = fixture();
  refreshDirectoryWithBackups(src, dest, backup);
  assert.equal(fs.existsSync(dest), false);
  put(path.join(src, "a", "SKILL.md"), "v1");
  refreshDirectoryWithBackups(src, dest, backup);
  fs.unlinkSync(path.join(src, "a", "SKILL.md"));
  refreshDirectoryWithBackups(src, dest, backup);
  assert.equal(fs.readFileSync(path.join(dest, "a", "SKILL.md"), "utf8"), "v1");
});

test("skill refresh refuses linked destination without touching the linked directory", () => {
  const { root, src, dest, backup, put } = fixture();
  put(path.join(src, "a", "SKILL.md"), "new");
  const outside = path.join(root, "outside");
  put(path.join(outside, "SKILL.md"), "private");
  fs.mkdirSync(dest, { recursive: true });
  fs.symlinkSync(outside, path.join(dest, "a"), "junction");
  assert.throws(() => refreshDirectoryWithBackups(src, dest, backup), /Unsafe skill directory/);
  assert.equal(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8"), "private");
});

test("session reopen refresh: four providers receive new and edited persona skills; global precedence and RP state survive", () => {
  const { root, put } = fixture();
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  try {
    const manager = new SessionManager(root, process.cwd());
    const session = path.join(root, "sessions", "existing");
    const source = path.join(root, "personas", "robot", "skills");
    put(path.join(source, "robot-skill", "SKILL.md"), "v1");
    put(path.join(source, "collision", "SKILL.md"), "persona");
    put(path.join(root, "skills", "collision", "SKILL.md"), "global");
    put(path.join(session, "variables.json"), '{"progress":7}');
    manager.refreshToolSkills(session, "robot");
    put(path.join(source, "robot-skill", "SKILL.md"), "v2");
    put(path.join(source, "new-skill", "references", "note.md"), "new reference");
    manager.refreshToolSkills(session, "robot");
    for (const provider of [".agents", ".claude", ".gemini", ".kimi"]) {
      assert.equal(fs.readFileSync(path.join(session, provider, "skills", "robot-skill", "SKILL.md"), "utf8"), "v2");
      assert.equal(fs.readFileSync(path.join(session, provider, "skills", "new-skill", "references", "note.md"), "utf8"), "new reference");
      assert.equal(fs.readFileSync(path.join(session, provider, "skills", "collision", "SKILL.md"), "utf8"), "global");
      assert.equal(fs.readdirSync(path.join(session, ".skill-backups", provider, "skills", "robot-skill")).length, 1);
    }
    assert.equal(fs.readFileSync(path.join(session, "variables.json"), "utf8"), '{"progress":7}');
  } finally {
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  }
});
