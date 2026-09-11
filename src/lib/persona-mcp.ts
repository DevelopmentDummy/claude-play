import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export interface PersonaMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Local, hash-pinned approval: importing a persona must not launch new executables. */
export function readPersonaMcpServers(
  projectDir: string, appRoot: string, personaName?: string,
): Record<string, PersonaMcpServer> {
  const manifestPath = path.join(projectDir, "runtime-mcp.json");
  if (!personaName || !fs.existsSync(manifestPath)) return {};
  try {
    const bytes = fs.readFileSync(manifestPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const approvals = JSON.parse(fs.readFileSync(path.join(appRoot, "data", "mcp-trust.json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (!Object.hasOwn(approvals, personaName) || approvals[personaName] !== hash) {
      console.warn(`[persona-mcp] ${personaName}: local manifest approval missing or stale`);
      return {};
    }
    const manifest = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) as { version?: unknown; servers?: unknown };
    if (manifest.version !== 1 || !manifest.servers || typeof manifest.servers !== "object" || Array.isArray(manifest.servers)) throw new Error("Invalid v1 manifest");
    const expand = (value: string) => value.replace(/\{\{(project_dir|app_root)\}\}/g, (_, key: string) => key === "project_dir" ? projectDir : appRoot);
    const result: Record<string, PersonaMcpServer> = Object.create(null);
    const entries = Object.entries(manifest.servers);
    if (entries.length > 8) throw new Error("At most 8 persona MCP servers");
    for (const [name, raw] of entries) {
      if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name) || ["claude_play", "claude-play", "constructor", "prototype"].includes(name)) throw new Error("Reserved/invalid server name");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid server");
      const server = raw as Record<string, unknown>;
      if (Object.keys(server).some(key => !["command", "args", "env"].includes(key))) throw new Error("Unsupported server field");
      if (typeof server.command !== "string" || !server.command.trim()) throw new Error("Missing command");
      if (!Array.isArray(server.args) || !server.args.every(a => typeof a === "string")) throw new Error("Invalid args");
      const env: Record<string, string> = {};
      if (server.env !== undefined) {
        if (!server.env || typeof server.env !== "object" || Array.isArray(server.env)) throw new Error("Invalid env");
        for (const [key, value] of Object.entries(server.env)) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string" || key.startsWith("CLAUDE_PLAY_")) throw new Error("Invalid/reserved env");
          env[key] = expand(value);
        }
      }
      result[name] = { command: expand(server.command), args: server.args.map(expand), env };
    }
    return result;
  } catch (error) {
    // Fail closed without breaking unrelated sessions or printing manifest secrets.
    console.warn(`[persona-mcp] ${personaName}: manifest unavailable/invalid (${error instanceof Error ? error.name : "error"})`);
    return {};
  }
}
