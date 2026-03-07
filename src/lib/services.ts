import * as fs from "fs";
import * as path from "path";
import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { SessionManager } from "./session-manager";
import { PanelEngine } from "./panel-engine";
import { wsBroadcastToUser } from "./ws-server";
import { getUserDataDir, getAppRoot } from "./data-dir";
import { AIProvider, providerFromModel } from "./ai-provider";

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

function toolUseKey(name: string, input: unknown): string {
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:${String(input)}`;
  }
}

const CHOICE_OPEN = "<choice>";
const CHOICE_CLOSE = "</choice>";

/** Extract <choice>...</choice> block from raw text */
function extractChoiceBlock(raw: string): string | null {
  const openIdx = raw.lastIndexOf(CHOICE_OPEN);
  if (openIdx === -1) return null;
  const closeIdx = raw.indexOf(CHOICE_CLOSE, openIdx);
  if (closeIdx === -1) return null;
  return raw.substring(openIdx, closeIdx + CHOICE_CLOSE.length);
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
    const extras: string[] = [];
    // Preserve special tokens outside dialog tags
    const tokens = extractSpecialTokens(raw).filter((token) => !base.includes(token));
    extras.push(...tokens);
    // Preserve <choice> block if it's not already in extracted content
    const choiceBlock = extractChoiceBlock(raw);
    if (choiceBlock && !base.includes(CHOICE_OPEN)) {
      extras.push(choiceBlock);
    }
    if (extras.length === 0) return base;
    return `${base}\n\n${extras.join("\n")}`;
  }

  // If no tags found, return original text (backward compat / non-RP sessions)
  return raw;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
  ooc?: boolean;
}

/** Union type for process instances — both share the same EventEmitter interface */
export type AIProcess = ClaudeProcess | CodexProcess;

export interface Services {
  userId: string;
  claude: AIProcess;
  provider: AIProvider;
  sessions: SessionManager;
  panels: PanelEngine;
  builderPersonaName: string | null;
  currentSessionId: string | null;
  isBuilderActive: boolean;
  isOOC: boolean;
  chatHistory: HistoryMessage[];
  addUserToHistory: (text: string, ooc?: boolean) => void;
  addOpeningToHistory: (text: string) => void;
  clearHistory: () => void;
  loadHistory: () => void;
  saveHistory: () => void;
  /** Switch the AI provider — kills current process, creates new one, rebinds events */
  switchProvider: (provider: AIProvider) => void;
}

const HISTORY_FILE = "chat-history.json";
const GLOBAL_KEY = "__claude_bridge_services__";

function createProcess(provider: AIProvider): AIProcess {
  return provider === "codex" ? new CodexProcess() : new ClaudeProcess();
}

function initServices(userId: string): Services {
  const userDataDir = getUserDataDir(userId);
  let currentProvider: AIProvider = "claude";
  let proc: AIProcess = createProcess(currentProvider);
  const sessions = new SessionManager(userDataDir, getAppRoot());

  function broadcast(event: string, data: unknown): void {
    wsBroadcastToUser(userId, event, data);
  }

  const panels = new PanelEngine(
    (update) => broadcast("panels:update", update),
    () => {
      const dir = svc.isBuilderActive && svc.builderPersonaName
        ? sessions.getPersonaDir(svc.builderPersonaName)
        : svc.currentSessionId ? sessions.getSessionDir(svc.currentSessionId) : null;
      if (dir) {
        broadcast("layout:update", { layout: sessions.readLayout(dir) });
      }
    },
  );

  // Accumulator for assistant turn
  let segments: string[] = [];
  let tools: Array<{ name: string; input: unknown }> = [];
  let autoImageTokens: Set<string> = new Set();
  let seenToolKeys: Set<string> = new Set();
  let sawTextDelta = false;
  let historyId = 0;

  function addToolUse(toolName: string, input: unknown): void {
    const key = toolUseKey(toolName, input);
    if (seenToolKeys.has(key)) return;
    seenToolKeys.add(key);

    tools.push({ name: toolName, input });
    const imageToken = detectImageToken(toolName, input);
    if (imageToken && !autoImageTokens.has(imageToken)) {
      autoImageTokens.add(imageToken);
      const joined = segments.join("");
      if (!joined.includes(imageToken)) {
        segments.push(`\n${imageToken}\n`);
      }
    }
  }

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

  /** Bind event listeners to the current AI process */
  function bindProcessEvents(p: AIProcess): void {
    p.on("message", (d) => {
      broadcast("claude:message", d);

      const msg = d as Record<string, unknown>;

      // Handle system status events (compacting only — informational)
      if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
        broadcast("claude:status", "compacting");
      }

      if (msg.type === "stream_event") {
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) return;
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            sawTextDelta = true;
            segments.push(delta.text);
          }
        }
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            addToolUse(block.name as string, block.input);
          }
        }
      }

      if (msg.type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) return;
        if (typeof message.content === "string") {
          if (!sawTextDelta) {
            segments.push(message.content);
          }
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              if (!sawTextDelta && typeof b.text === "string") {
                segments.push(b.text);
              }
            }
            else if (b.type === "tool_use") {
              addToolUse(b.name as string, b.input);
            }
          }
        }
      }

      if (msg.type === "result") {
        const isOOC = svc.isOOC;
        if (segments.length > 0 || tools.length > 0) {
          const rawContent = segments.join("");
          const dialogContent = isOOC ? rawContent : extractDialog(rawContent);
          if (dialogContent) {
            svc.chatHistory.push({
              id: `hist-a-${++historyId}`,
              role: "assistant",
              content: dialogContent,
              tools: tools.length > 0 ? [...tools] : undefined,
              ooc: isOOC || undefined,
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
              ooc: isOOC || undefined,
            });
          }
        }
        saveHistory();
        svc.isOOC = false;
        segments = [];
        tools = [];
        autoImageTokens.clear();
        seenToolKeys.clear();
        sawTextDelta = false;

        // Force panel refresh at end of turn
        svc.panels.reload();
      }
    });

    p.on("error", (e) => broadcast("claude:error", e));
    p.on("status", (s) => broadcast("claude:status", s));
    p.on("exit", () => broadcast("claude:status", "disconnected"));

    // Capture session ID and persist it
    p.on("sessionId", (sessionId: string) => {
      try {
        if (svc.isBuilderActive && svc.builderPersonaName) {
          sessions.saveBuilderSession(svc.builderPersonaName, currentProvider, sessionId);
        } else if (svc.currentSessionId) {
          if (currentProvider === "codex") {
            sessions.saveCodexThreadId(svc.currentSessionId, sessionId);
          } else {
            sessions.saveClaudeSessionId(svc.currentSessionId, sessionId);
          }
        }
      } catch (err) {
        console.error("[services] ERROR saving sessionId:", err);
      }
    });
  }

  const svc: Services = {
    userId,
    get claude() { return proc; },
    get provider() { return currentProvider; },
    set provider(p: AIProvider) { currentProvider = p; },
    sessions,
    panels,
    builderPersonaName: null,
    currentSessionId: null,
    isBuilderActive: false,
    isOOC: false,
    chatHistory: [],
    addUserToHistory(text: string, ooc?: boolean) {
      svc.chatHistory.push({
        id: `hist-u-${++historyId}`,
        role: "user",
        content: text,
        ooc: ooc || undefined,
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
      seenToolKeys.clear();
      sawTextDelta = false;
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
    saveHistory,
    switchProvider(newProvider: AIProvider) {
      if (newProvider === currentProvider) return;
      proc.kill();
      proc.removeAllListeners();
      currentProvider = newProvider;
      proc = createProcess(newProvider);
      bindProcessEvents(proc);
    },
  };

  // Bind events on initial process
  bindProcessEvents(proc);

  return svc;
}

/** Get or create per-user Services instance */
export function getServices(userId: string): Services {
  const g = globalThis as unknown as Record<string, Map<string, Services>>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  const map = g[GLOBAL_KEY];
  let svc = map.get(userId);
  if (!svc) {
    svc = initServices(userId);
    map.set(userId, svc);
  }
  return svc;
}

/** Clean up a user's services (kill process, stop watchers) */
export function cleanupServices(userId: string): void {
  const g = globalThis as unknown as Record<string, Map<string, Services>>;
  const map = g[GLOBAL_KEY];
  if (!map) return;
  const svc = map.get(userId);
  if (svc) {
    svc.claude.kill();
    svc.panels.stop();
    map.delete(userId);
  }
}
