import { ClaudeProcess } from "./claude-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { SSEManager } from "./sse-manager";
import { getDataDir, getAppRoot } from "./data-dir";

export interface Services {
  claude: ClaudeProcess;
  sessions: SessionManager;
  panels: PanelEngine;
  sse: SSEManager;
  builderPersonaName: string | null;
  currentSessionId: string | null;
  isBuilderActive: boolean;
}

const GLOBAL_KEY = "__claude_bridge__";

function initServices(): Services {
  const sse = new SSEManager();
  const claude = new ClaudeProcess();
  const sessions = new SessionManager(getDataDir(), getAppRoot());
  const panels = new PanelEngine((data) => sse.broadcast("panels:update", data));

  // Claude events → SSE (replaces ipc-handlers.ts event forwarding)
  claude.on("message", (d) => sse.broadcast("claude:message", d));
  claude.on("error", (e) => sse.broadcast("claude:error", e));
  claude.on("status", (s) => sse.broadcast("claude:status", s));
  claude.on("exit", () => sse.broadcast("claude:status", "disconnected"));

  const svc: Services = {
    claude,
    sessions,
    panels,
    sse,
    builderPersonaName: null,
    currentSessionId: null,
    isBuilderActive: false,
  };

  // Capture Claude session ID and persist it
  claude.on("sessionId", (claudeSessionId: string) => {
    if (svc.isBuilderActive && svc.builderPersonaName) {
      sessions.saveBuilderSessionId(svc.builderPersonaName, claudeSessionId);
    } else if (svc.currentSessionId) {
      sessions.saveClaudeSessionId(svc.currentSessionId, claudeSessionId);
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
