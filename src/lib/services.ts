import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { wsBroadcastAll } from "./ws-server";
import { getDataDir, getAppRoot } from "./data-dir";

const DIALOG_OPEN = "<dialog_response>";
const DIALOG_CLOSE = "</dialog_response>";

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

  // If no tags found, return original text (backward compat / non-RP sessions)
  return parts.length > 0 ? parts.join("\n\n") : raw;
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
          tools.push({ name: block.name as string, input: block.input });
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
          else if (b.type === "tool_use") tools.push({ name: b.name as string, input: b.input });
        }
      }
    }

    if (msg.type === "result") {
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
      segments = [];
      tools = [];
      saveHistory();
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
