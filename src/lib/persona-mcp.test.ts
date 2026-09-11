import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readPersonaMcpServers } from "./persona-mcp";
import { ensureClaudeRuntimeConfig } from "./runtime-config";

test("persona MCP: approved manifest survives all writers, untrusted import fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blender-mcp-한글-"));
  const project = path.join(root, "세션 with spaces");
  fs.mkdirSync(project); fs.mkdirSync(path.join(root, "data"));
  try {
    const text = JSON.stringify({ version: 1, servers: { blender_studio: { command: "node", args: ["{{project_dir}}/mcp/server.mjs"], env: { ASSET_ROOT: "{{app_root}}/data" } } } });
    fs.writeFileSync(path.join(project, "runtime-mcp.json"), text, "utf8");
    assert.equal(Object.keys(readPersonaMcpServers(project, root, "blender_master")).length, 0);
    const approve = () => fs.writeFileSync(path.join(root, "data/mcp-trust.json"), JSON.stringify({ blender_master: createHash("sha256").update(fs.readFileSync(path.join(project, "runtime-mcp.json"))).digest("hex") }), "utf8");
    approve();
    assert.equal(readPersonaMcpServers(project, root, "blender_master").blender_studio.args[0], `${project}/mcp/server.mjs`);
    assert.equal(Object.keys(readPersonaMcpServers(project, root, "other")).length, 0);
    ensureClaudeRuntimeConfig(project, root, "blender_master");
    for (const name of [".mcp.json", ".gemini/settings.json", ".agents/mcp_config.json"]) {
      assert.ok(JSON.parse(fs.readFileSync(path.join(project, name), "utf8")).mcpServers.blender_studio);
    }
    const toml = fs.readFileSync(path.join(project, ".codex/config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers.blender_studio\]/);
    ensureClaudeRuntimeConfig(project, root, "blender_master");
    assert.equal(fs.readFileSync(path.join(project, ".codex/config.toml"), "utf8"), toml);
    fs.appendFileSync(path.join(project, "runtime-mcp.json"), " ");
    assert.equal(Object.keys(readPersonaMcpServers(project, root, "blender_master")).length, 0);
    for (const name of ["claude_play", "claude-play", "constructor", "bad.name"]) {
      fs.writeFileSync(path.join(project, "runtime-mcp.json"), JSON.stringify({ version: 1, servers: { [name]: { command: "node", args: [] } } })); approve();
      assert.equal(Object.keys(readPersonaMcpServers(project, root, "blender_master")).length, 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
