import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { SSEManager } from "./sse-manager";
import { getDataDir, getAppRoot } from "./data-dir";

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
  sse: SSEManager;
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

function initServices(): Services {
  const sse = new SSEManager();
  const claude = new ClaudeProcess();
  const sessions = new SessionManager(getDataDir(), getAppRoot());
  const panels = new PanelEngine((data) => sse.broadcast("panels:update", data));

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
    sse,
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

  // Claude events → SSE + history accumulation
  claude.on("message", (d) => {
    sse.broadcast("claude:message", d);

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
        svc.chatHistory.push({
          id: `hist-a-${++historyId}`,
          role: "assistant",
          content: segments.join(""),
          tools: tools.length > 0 ? [...tools] : undefined,
        });
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

  claude.on("error", (e) => sse.broadcast("claude:error", e));
  claude.on("status", (s) => sse.broadcast("claude:status", s));
  claude.on("exit", () => sse.broadcast("claude:status", "disconnected"));

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
