import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { wsBroadcastAll } from "./ws-server";
import { getDataDir, getAppRoot } from "./data-dir";

const DIALOG_OPEN = "<dialog_response>";
const DIALOG_CLOSE = "</dialog_response>";
const SPECIAL_TOKEN_REGEX = /\$(?:IMAGE|PANEL):[^$]+\$/g;

function extractSpecialTokens(raw: string): string[] {
  const matches = raw.match(SPECIAL_TOKEN_REGEX) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of matches) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function sanitizeFilename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function detectImageToken(toolName: string, input: unknown): string | null {
  const imageToolNames = new Set([
    "mcp__claude_bridge__generate_image",
    "mcp__claude_bridge__generate_image_gemini",
    "mcp__claude_bridge__comfyui_generate",
    "mcp__claude_bridge__gemini_generate",
  ]);
  if (!imageToolNames.has(toolName)) return null;
  if (!input || typeof input !== "object") return null;

  const body = input as Record<string, unknown>;
  const fromPath = typeof body.path === "string" ? body.path.trim() : "";
  if (fromPath.startsWith("images/")) {
    return `$IMAGE:${fromPath}$`;
  }

  const filename = typeof body.filename === "string" ? sanitizeFilename(body.filename) : "";
  if (!filename) return null;
  return `$IMAGE:images/${filename}$`;
}

/** Extract content inside <dialog_response> tags; returns raw text if no tags found */
function extractDialog(raw: string): string {
  const parts: string[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = raw.indexOf(DIALOG_OPEN, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + DIALOG_OPEN.length;
    const closeIdx = raw.indexOf(DIALOG_CLOSE, contentStart);
    if (closeIdx !== -1) {
      parts.push(raw.substring(contentStart, closeIdx).trim());
      searchFrom = closeIdx + DIALOG_CLOSE.length;
    } else {
      parts.push(raw.substring(contentStart).trim());
      break;
    }
  }

  if (parts.length > 0) {
    const base = parts.join("\n\n").trim();
    const tokens = extractSpecialTokens(raw).filter((token) => !base.includes(token));
    if (tokens.length === 0) return base;
    return `${base}\n\n${tokens.join("\n")}`;
  }

  // If no tags found, return original text (backward compat / non-RP sessions)
  return raw;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
}

export interface Services {
  claude: ClaudeProcess;
  sessions: SessionManager;
  panels: PanelEngine;
  builderPersonaName: string | null;
  currentSessionId: string | null;
  isBuilderActive: boolean;
  isOOC: boolean;
  chatHistory: HistoryMessage[];
  addUserToHistory: (text: string) => void;
  addOpeningToHistory: (text: string) => void;
  clearHistory: () => void;
  loadHistory: () => void;
}

const HISTORY_FILE = "chat-history.json";
const GLOBAL_KEY = "__claude_bridge__";

function broadcast(event: string, data: unknown): void {
  wsBroadcastAll(event, data);
}

function initServices(): Services {
  const claude = new ClaudeProcess();
  const sessions = new SessionManager(getDataDir(), getAppRoot());
  const panels = new PanelEngine((update) => broadcast("panels:update", update));

  // Accumulator for assistant turn
  let segments: string[] = [];
  let tools: Array<{ name: string; input: unknown }> = [];
  let autoImageTokens: Set<string> = new Set();
  let historyId = 0;

  /** Resolve the directory where chat-history.json should live */
  function historyDir(): string | null {
    if (svc.isBuilderActive && svc.builderPersonaName) {
      return sessions.getPersonaDir(svc.builderPersonaName);
    }
    if (svc.currentSessionId) {
      return sessions.getSessionDir(svc.currentSessionId);
    }
    return null;
  }

  /** Persist current chatHistory to disk */
  function saveHistory(): void {
    const dir = historyDir();
    if (!dir) return;
    try {
      fs.writeFileSync(
        path.join(dir, HISTORY_FILE),
        JSON.stringify(svc.chatHistory),
        "utf-8"
      );
    } catch { /* ignore */ }
  }

  const svc: Services = {
    claude,
    sessions,
    panels,
    builderPersonaName: null,
    currentSessionId: null,
    isBuilderActive: false,
    isOOC: false,
    chatHistory: [],
    addUserToHistory(text: string) {
      svc.chatHistory.push({
        id: `hist-u-${++historyId}`,
        role: "user",
        content: text,
      });
      saveHistory();
    },
    addOpeningToHistory(text: string) {
      svc.chatHistory.push({
        id: `hist-a-${++historyId}`,
        role: "assistant",
        content: text,
      });
      saveHistory();
    },
    clearHistory() {
      svc.chatHistory = [];
      segments = [];
      tools = [];
      autoImageTokens.clear();
      // Delete history file if exists
      const dir = historyDir();
      if (dir) {
        const fp = path.join(dir, HISTORY_FILE);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
    },
    loadHistory() {
      const dir = historyDir();
      if (!dir) { svc.chatHistory = []; return; }
      const fp = path.join(dir, HISTORY_FILE);
      try {
        if (fs.existsSync(fp)) {
          svc.chatHistory = JSON.parse(fs.readFileSync(fp, "utf-8"));
          historyId = svc.chatHistory.length;
        } else {
          svc.chatHistory = [];
        }
      } catch {
        svc.chatHistory = [];
      }
    },
  };

  // Claude events → WS broadcast + history accumulation
  claude.on("message", (d) => {
    broadcast("claude:message", d);

    const msg = d as Record<string, unknown>;

    if (msg.type === "stream_event") {
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          segments.push(delta.text);
        }
      }
      if (event.type === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const toolName = block.name as string;
          tools.push({ name: toolName, input: block.input });
          const imageToken = detectImageToken(toolName, block.input);
          if (imageToken && !autoImageTokens.has(imageToken)) {
            autoImageTokens.add(imageToken);
            const joined = segments.join("");
            if (!joined.includes(imageToken)) {
              segments.push(`\n${imageToken}\n`);
            }
          }
        }
      }
    }

    if (msg.type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      if (!message) return;
      if (typeof message.content === "string") {
        segments.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text") segments.push(b.text as string);
          else if (b.type === "tool_use") {
            const toolName = b.name as string;
            tools.push({ name: toolName, input: b.input });
            const imageToken = detectImageToken(toolName, b.input);
            if (imageToken && !autoImageTokens.has(imageToken)) {
              autoImageTokens.add(imageToken);
              const joined = segments.join("");
              if (!joined.includes(imageToken)) {
                segments.push(`\n${imageToken}\n`);
              }
            }
          }
        }
      }
    }

    if (msg.type === "result") {
      if (!svc.isOOC) {
        if (segments.length > 0 || tools.length > 0) {
          const rawContent = segments.join("");
          const dialogContent = extractDialog(rawContent);
          if (dialogContent) {
            svc.chatHistory.push({
              id: `hist-a-${++historyId}`,
              role: "assistant",
              content: dialogContent,
              tools: tools.length > 0 ? [...tools] : undefined,
            });
          }
        } else if (msg.result) {
          const result = msg.result as Record<string, unknown>;
          const text =
            typeof result === "string" ? result
            : typeof result.text === "string" ? result.text
            : null;
          if (text) {
            svc.chatHistory.push({
              id: `hist-a-${++historyId}`,
              role: "assistant",
              content: text,
            });
          }
        }
        saveHistory();
      }
      svc.isOOC = false;
      segments = [];
      tools = [];
      autoImageTokens.clear();

      // Force panel refresh at end of turn — picks up any file changes Claude made
      svc.panels.reload();
    }
  });

  claude.on("error", (e) => broadcast("claude:error", e));
  claude.on("status", (s) => broadcast("claude:status", s));
  claude.on("exit", () => broadcast("claude:status", "disconnected"));

  // Capture Claude session ID and persist it
  claude.on("sessionId", (claudeSessionId: string) => {
    try {
      if (svc.isBuilderActive && svc.builderPersonaName) {
        sessions.saveBuilderSessionId(svc.builderPersonaName, claudeSessionId);
      } else if (svc.currentSessionId) {
        sessions.saveClaudeSessionId(svc.currentSessionId, claudeSessionId);
      }
    } catch (err) {
      console.error("[services] ERROR saving sessionId:", err);
    }
  });

  return svc;
}

export function getServices(): Services {
  const g = globalThis as unknown as Record<string, Services>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = initServices();
  }
  return g[GLOBAL_KEY];
}
