import { Server as HTTPServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parse } from "url";
import type { Socket } from "net";
import { TextDecoder } from "util";
import {
  getSessionInstance,
  scheduleSessionCleanup,
  cancelSessionCleanup,
} from "./session-registry";
import { stopPipelineScheduler } from "./pipeline-scheduler";
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./auth";

interface WSClient {
  ws: WebSocket;
  sessionId: string | null;
  isBuilder: boolean;
}

type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void;
const wsTextDecoder = new TextDecoder("utf-8");

// Use globalThis to share state across module instances (server.ts vs Next.js routes)
const WS_KEY = "__claude_play_ws__";
interface WSGlobal {
  clients: Set<WSClient>;
  server: HTTPServer | null;
  wss: WebSocketServer | null;
  upgradeHandler: UpgradeHandler | null;
}

function getWSState(): WSGlobal {
  const g = globalThis as unknown as Record<string, WSGlobal>;
  if (!g[WS_KEY]) {
    g[WS_KEY] = {
      clients: new Set(),
      server: null,
      wss: null,
      upgradeHandler: null,
    };
  }
  return g[WS_KEY];
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function decodeRawMessage(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return wsTextDecoder.decode(raw);
  }
  if (Array.isArray(raw)) {
    return wsTextDecoder.decode(Buffer.concat(raw));
  }
  return wsTextDecoder.decode(Buffer.from(raw));
}

function parseIncomingMessage(raw: RawData): { type: string; [key: string]: unknown } | null {
  const text = decodeRawMessage(raw);
  try {
    const parsed = JSON.parse(text) as { type?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as { type: string; [key: string]: unknown };
  } catch {
    return null;
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload), { binary: false });
}

function detachClient(client: WSClient): void {
  const { clients } = getWSState();
  const closedSessionId = client.sessionId;
  clients.delete(client);
  client.sessionId = null;
  if (closedSessionId && countSessionClients(closedSessionId) === 0) {
    void stopPipelineScheduler(closedSessionId);
    scheduleSessionCleanup(closedSessionId);
  }
}

function cleanupWebSocketServer(): void {
  const state = getWSState();
  for (const client of state.clients) {
    try {
      client.ws.terminate();
    } catch { /* ignore */ }
  }
  state.clients.clear();
  if (state.server && state.upgradeHandler) {
    state.server.off("upgrade", state.upgradeHandler);
  }
  state.upgradeHandler = null;
  state.server = null;
  state.wss?.close();
  state.wss = null;
}

/** Broadcast to all connected clients */
export function wsBroadcast(
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean; exclude?: WSClient }
): void {
  const { clients } = getWSState();
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (filter) {
      if (filter.exclude && client === filter.exclude) continue;
      if (filter.sessionId && client.sessionId !== filter.sessionId) continue;
      if (filter.isBuilder !== undefined && client.isBuilder !== filter.isBuilder) continue;
    }
    try {
      sendJson(client.ws, { event, data });
    } catch {
      detachClient(client);
      try {
        client.ws.terminate();
      } catch { /* ignore */ }
    }
  }
}

/** Count active clients for a specific session */
export function countSessionClients(sessionId: string): number {
  const { clients } = getWSState();
  let count = 0;
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN && c.sessionId === sessionId) count++;
  }
  return count;
}

export function listSessionClientCounts(): Array<{ sessionId: string; clients: number }> {
  const { clients } = getWSState();
  const counts = new Map<string, number>();
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!client.sessionId) continue;
    counts.set(client.sessionId, (counts.get(client.sessionId) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([sessionId, clients]) => ({ sessionId, clients }))
    .sort((a, b) => b.clients - a.clients || a.sessionId.localeCompare(b.sessionId));
}

export function getWebSocketStats(): {
  totalClients: number;
  boundClients: number;
  unboundClients: number;
  builderClients: number;
} {
  const { clients } = getWSState();
  let totalClients = 0;
  let boundClients = 0;
  let builderClients = 0;
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    totalClients += 1;
    if (client.sessionId) boundClients += 1;
    if (client.isBuilder) builderClients += 1;
  }
  return {
    totalClients,
    boundClients,
    unboundClients: Math.max(0, totalClients - boundClients),
    builderClients,
  };
}

export function setupWebSocket(server: HTTPServer): void {
  const state = getWSState();
  if (state.server === server && state.wss && state.upgradeHandler) {
    return;
  }
  if (state.server && state.server !== server) {
    cleanupWebSocketServer();
  }

  const wss = new WebSocketServer({ noServer: true });
  const upgradeHandler: UpgradeHandler = (req, socket, head) => {
    const { pathname, query } = parse(req.url || "", true);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Auth check
    if (isAuthEnabled()) {
      const cookieToken = parseCookieToken(req.headers.cookie);
      if (!cookieToken || !verifyAuthToken(cookieToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = normalizeSessionId(query.sessionId);
      const isBuilder = query.builder === "true";

      const client: WSClient = { ws, sessionId: null, isBuilder };
      state.clients.add(client);

      ws.on("message", (raw) => {
        const msg = parseIncomingMessage(raw);
        if (msg) {
          handleMessage(client, msg);
        }
      });

      ws.on("error", () => {
        detachClient(client);
      });

      ws.on("close", () => {
        detachClient(client);
      });

      const instance = sessionId ? getSessionInstance(sessionId) : null;
      const sessionActive = instance ? instance.claude.isRunning() : false;
      try {
        sendJson(ws, {
          event: "connected",
          data: { sessionId, isBuilder, sessionActive },
        });

        if (instance) {
          const pendingHeaders = instance.getPendingEvents();
          if (pendingHeaders.length > 0) {
            sendJson(ws, {
              event: "event:pending",
              data: { headers: pendingHeaders },
            });
          }
        }
      } catch {
        detachClient(client);
      }
    });
  };

  state.server = server;
  state.wss = wss;
  state.upgradeHandler = upgradeHandler;
  server.on("upgrade", upgradeHandler);
  server.once("close", () => {
    const current = getWSState();
    if (current.server === server) {
      cleanupWebSocketServer();
    }
  });
}

function handleMessage(
  client: WSClient,
  msg: { type: string; [key: string]: unknown }
): void {
  switch (msg.type) {
    case "chat:send": {
      const text = msg.text as string;
      if (!text?.trim() || !client.sessionId) return;

      const instance = getSessionInstance(client.sessionId);
      if (!instance) return;

      const silent = !!msg.silent;

      if (silent) {
        // Silent mode: send to AI only — no history, no broadcast
        // Still flush pending event headers so they reach the AI
        instance.runMessageHooks(text);
        const eventHeaders = instance.flushEvents();
        const hintSnapshot = instance.buildHintSnapshot();
        const actionHistory = instance.flushActions();
        const jsonLint = instance.buildJsonLint();
        const parts = [eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
        instance.sendToAI(parts.join("\n"));
        break;
      }

      const isOOC = text.startsWith("OOC:");
      instance.isOOC = isOOC;
      if (!isOOC) {
        instance.clearPopups();
      }
      instance.addUserToHistory(text, isOOC);

      // Run per-persona message hooks (e.g. dynamic hint data)
      if (!isOOC) instance.runMessageHooks(text);

      // Flush pending event headers and prepend to AI message
      const eventHeaders = isOOC ? "" : instance.flushEvents();
      const hintSnapshot = isOOC ? "" : instance.buildHintSnapshot();
      const actionHistory = isOOC ? "" : instance.flushActions();
      const jsonLint = instance.buildJsonLint();
      const oocHint = isOOC ? "[OOC 메시지입니다. RP 응답(dialog_response)을 포함하지 마세요. 메타/시스템 수준으로만 응답하세요.]\n" : "";
      const parts = [oocHint, eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
      instance.sendToAI(parts.join("\n"));

      // Broadcast user message to other clients in same session (sender already has it locally)
      wsBroadcast("chat:user", { text, isOOC }, { sessionId: client.sessionId, exclude: client });
      break;
    }

    case "chat:cancel": {
      if (!client.sessionId) return;
      const inst = getSessionInstance(client.sessionId);
      if (!inst) return;
      inst.cancelStreaming();
      break;
    }

    case "event:queue": {
      const header = msg.header as string;
      if (!header?.trim() || !client.sessionId) return;

      const instance = getSessionInstance(client.sessionId);
      if (!instance) return;

      instance.queueEvent(header.trim());
      instance.broadcast("event:pending", { headers: instance.getPendingEvents() });
      break;
    }

    case "command:send": {
      const command = msg.command as string;
      if (!command?.trim() || !client.sessionId) return;

      const instance = getSessionInstance(client.sessionId);
      if (!instance) return;

      instance.sendSlashCommand(command.trim());
      break;
    }

    case "session:bind": {
      const previousSessionId = client.sessionId;
      const nextSessionId = normalizeSessionId(msg.sessionId);
      if (previousSessionId && previousSessionId !== nextSessionId) {
        client.sessionId = null;
        if (countSessionClients(previousSessionId) === 0) {
          scheduleSessionCleanup(previousSessionId);
        }
      }
      client.sessionId = nextSessionId;
      client.isBuilder = !!(msg.isBuilder);

      // Cancel cleanup for the session being bound to
      if (client.sessionId) {
        cancelSessionCleanup(client.sessionId);
      }
      break;
    }

    case "session:leave": {
      const leavingSession = client.sessionId;
      client.sessionId = null; // unbind first
      if (leavingSession) {
        const remaining = countSessionClients(leavingSession);
        console.log(`[ws] Client left session ${leavingSession} — ${remaining} client(s) remaining`);
        if (remaining === 0) {
          void stopPipelineScheduler(leavingSession);
          scheduleSessionCleanup(leavingSession);
        }
      }
      break;
    }
  }
}
