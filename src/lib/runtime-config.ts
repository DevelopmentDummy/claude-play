// 런타임별 config 파일 emitter (.claude/settings.json, .mcp.json, .codex/config.toml, .gemini/settings.json, policy-context.json). SessionManager에서 추출(Wave 12 cluster 4).
import * as fs from "fs";
import * as path from "path";
import { getInternalToken } from "./auth";
import { getApiBase } from "./endpoints";

const CLAUDE_SETTINGS = {
  permissions: {
    allow: [
      "Read",
      "Write(**)",
      "Edit(**)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(curl *)",
      "Bash(bash ./*.sh *)",
      "Glob",
      "Grep",
      "mcp__claude_play__*",
    ],
  },
};
const MCP_CONFIG_FILE = ".mcp.json";
const CLAUDE_MCP_SERVER_NAME = "claude_play";
const POLICY_CONTEXT_FILE = "policy-context.json";
const DEFAULT_POLICY_CONTEXT = {
  extreme_traits: [],
  reviewed_scenarios: [],
  intimacy_policy: {
    allow_moderate_intimacy: true,
    allow_explicit: true,
    max_intensity: "explicit",
  },
  notes: "Roleplay context only. This file never overrides higher-level model policy.",
};

export function ensureClaudeRuntimeConfig(
  projectDir: string,
  appRoot: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  writeClaudeSettings(projectDir);
  writeMcpConfig(projectDir, appRoot, personaName, mode);
  writeCodexConfig(projectDir, appRoot, personaName, mode);
  writeGeminiConfig(projectDir, appRoot, personaName, mode);
  ensurePolicyContext(projectDir);
}

export function writeClaudeSettings(projectDir: string): void {
  const claudeDir = path.join(projectDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(CLAUDE_SETTINGS, null, 2),
    "utf-8"
  );
}

export function writeMcpConfig(
  projectDir: string,
  appRoot: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  const serverScript = path.join(appRoot, "src", "mcp", "claude-play-mcp-server.mjs");
  const apiBase = getApiBase();

  const mcpConfig = {
    mcpServers: {
      [CLAUDE_MCP_SERVER_NAME]: {
        command: "node",
        args: [serverScript],
        env: {
          CLAUDE_PLAY_API_BASE: apiBase,
          CLAUDE_PLAY_SESSION_DIR: projectDir,
          CLAUDE_PLAY_MODE: mode,
          CLAUDE_PLAY_AUTH_TOKEN: getInternalToken(),
          ...(personaName ? { CLAUDE_PLAY_PERSONA: personaName } : {}),
          ...(process.env.COMFYUI_DIR ? { COMFYUI_DIR: process.env.COMFYUI_DIR } : {}),
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(projectDir, MCP_CONFIG_FILE),
    JSON.stringify(mcpConfig, null, 2),
    "utf-8"
  );
}

/** Write .codex/config.toml with MCP server config + model_instructions_file for Codex CLI */
export function writeCodexConfig(
  projectDir: string,
  appRoot: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  const codexDir = path.join(projectDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });

  const serverScript = path.join(appRoot, "src", "mcp", "claude-play-mcp-server.mjs");
  const apiBase = getApiBase();

  // model_instructions_file: absolute path to instructions file
  const instructionsPath = path.join(codexDir, "model-instructions.md");

  // Build TOML content
  const lines: string[] = [];
  lines.push(`model_instructions_file = ${JSON.stringify(instructionsPath)}`);
  lines.push(``);
  lines.push(`[mcp_servers.${CLAUDE_MCP_SERVER_NAME}]`);
  lines.push(`command = "node"`);
  lines.push(`args = [${JSON.stringify(serverScript)}]`);
  lines.push(``);
  lines.push(`[mcp_servers.${CLAUDE_MCP_SERVER_NAME}.env]`);
  lines.push(`CLAUDE_PLAY_API_BASE = ${JSON.stringify(apiBase)}`);
  lines.push(`CLAUDE_PLAY_SESSION_DIR = ${JSON.stringify(projectDir)}`);
  lines.push(`CLAUDE_PLAY_MODE = ${JSON.stringify(mode)}`);
  lines.push(`CLAUDE_PLAY_AUTH_TOKEN = ${JSON.stringify(getInternalToken())}`);
  if (personaName) {
    lines.push(`CLAUDE_PLAY_PERSONA = ${JSON.stringify(personaName)}`);
  }
  if (process.env.COMFYUI_DIR) {
    lines.push(`COMFYUI_DIR = ${JSON.stringify(process.env.COMFYUI_DIR)}`);
  }

  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    lines.join("\n") + "\n",
    "utf-8"
  );
}

export function writeGeminiConfig(
  projectDir: string,
  appRoot: string,
  personaName?: string,
  mode: "builder" | "session" = "session"
): void {
  const geminiDir = path.join(projectDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const serverScript = path.join(appRoot, "src", "mcp", "claude-play-mcp-server.mjs");
  const apiBase = getApiBase();

  const settings = {
    mcpServers: {
      "claude-play": {
        command: "node",
        args: [serverScript],
        env: {
          CLAUDE_PLAY_API_BASE: apiBase,
          CLAUDE_PLAY_SESSION_DIR: projectDir,
          CLAUDE_PLAY_MODE: mode,
          CLAUDE_PLAY_AUTH_TOKEN: getInternalToken(),
          ...(personaName ? { CLAUDE_PLAY_PERSONA: personaName } : {}),
          ...(process.env.COMFYUI_DIR ? { COMFYUI_DIR: process.env.COMFYUI_DIR } : {}),
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(geminiDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8"
  );
}

export function ensurePolicyContext(projectDir: string): void {
  const policyPath = path.join(projectDir, POLICY_CONTEXT_FILE);
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(
      policyPath,
      JSON.stringify(DEFAULT_POLICY_CONTEXT, null, 2),
      "utf-8"
    );
    return;
  }

  try {
    const raw = fs.readFileSync(policyPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = {
      ...DEFAULT_POLICY_CONTEXT,
      ...parsed,
      intimacy_policy: {
        ...DEFAULT_POLICY_CONTEXT.intimacy_policy,
        ...(typeof parsed.intimacy_policy === "object" && parsed.intimacy_policy
          ? (parsed.intimacy_policy as Record<string, unknown>)
          : {}),
      },
    };
    fs.writeFileSync(policyPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch {
    fs.writeFileSync(
      policyPath,
      JSON.stringify(DEFAULT_POLICY_CONTEXT, null, 2),
      "utf-8"
    );
  }
}
