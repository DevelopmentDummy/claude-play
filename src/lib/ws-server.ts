import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import {
  getSessionInstance,
  scheduleSessionCleanup,
  cancelSessionCleanup,
} from "./session-registry";
import { isAuthEnabled, verifyAuthToken, parseCookieToken } from "./auth";

interface WSClient {
  ws: WebSocket;
  sessionId: string | null;
  isBuilder: boolean;
}

// Use globalThis to share state across module instances (server.ts vs Next.js routes)
const WS_KEY = "__claude_bridge_ws__";
interface WSGlobal {
  clients: Set<WSClient>;
}

function getWSState(): WSGlobal {
  const g = globalThis as unknown as Record<string, WSGlobal>;
  if (!g[WS_KEY]) {
    g[WS_KEY] = { clients: new Set() };
  }
  return g[WS_KEY];
}

/** Broadcast to all connected clients */
export function wsBroadcast(
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean; exclude?: WSClient }
): void {
  const { clients } = getWSState();
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (filter) {
      if (filter.exclude && client === filter.exclude) continue;
      if (filter.sessionId && client.sessionId !== filter.sessionId) continue;
      if (filter.isBuilder !== undefined && client.isBuilder !== filter.isBuilder) continue;
    }
    try {
      client.ws.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Count active clients for a specific session */
function countSessionClients(sessionId: string): number {
  const { clients } = getWSState();
  let count = 0;
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN && c.sessionId === sessionId) count++;
  }
  return count;
}


export function setupWebSocket(server: HTTPServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const state = getWSState();

  server.on("upgrade", (req, socket, head) => {
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
      const rawSessionId = (query.sessionId as string) || null;
      const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : null;
      const isBuilder = query.builder === "true";

      const client: WSClient = { ws, sessionId, isBuilder };
      state.clients.add(client);

      // Cancel any pending cleanup for this session
      if (sessionId) {
        cancelSessionCleanup(sessionId);
      }

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleMessage(client, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        const closedSessionId = client.sessionId;
        state.clients.delete(client);

        // Schedule cleanup for the session this client was in (10min grace period)
        if (closedSessionId && countSessionClients(closedSessionId) === 0) {
          scheduleSessionCleanup(closedSessionId);
        }
      });

      // Send connection ack with session active state
      const instance = sessionId ? getSessionInstance(sessionId) : null;
      const sessionActive = instance ? instance.claude.isRunning() : false;
      ws.send(JSON.stringify({
        event: "connected",
        data: { sessionId, isBuilder, sessionActive },
      }));

      // Send pending events if any
      if (instance) {
        const pendingHeaders = instance.getPendingEvents();
        if (pendingHeaders.length > 0) {
          ws.send(JSON.stringify({
            event: "event:pending",
            data: { headers: pendingHeaders },
          }));
        }
      }
    });
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
        const eventHeaders = instance.flushEvents();
        const hintSnapshot = instance.buildHintSnapshot();
        const actionHistory = instance.flushActions();
        const parts = [eventHeaders, hintSnapshot, actionHistory, text].filter(Boolean);
        instance.claude.send(parts.join("\n"));
        break;
      }

      const isOOC = text.startsWith("OOC:");
      instance.isOOC = isOOC;
      if (!isOOC) {
        instance.clearPopups();
      }
      instance.addUserToHistory(text, isOOC);

      // Flush pending event headers and prepend to AI message
      const eventHeaders = isOOC ? "" : instance.flushEvents();
      const hintSnapshot = isOOC ? "" : instance.buildHintSnapshot();
      const actionHistory = isOOC ? "" : instance.flushActions();
      const oocHint = isOOC ? "[OOC 메시지입니다. RP 응답(dialog_response)을 포함하지 마세요. 메타/시스템 수준으로만 응답하세요.]\n" : "";
      const parts = [oocHint, eventHeaders, hintSnapshot, actionHistory, text].filter(Boolean);
      instance.claude.send(parts.join("\n"));

      // Broadcast user message to other clients in same session (sender already has it locally)
      wsBroadcast("chat:user", { text, isOOC }, { sessionId: client.sessionId, exclude: client });
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
      const rawId = (msg.sessionId as string) || null;
      client.sessionId = rawId ? decodeURIComponent(rawId) : null;
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
          scheduleSessionCleanup(leavingSession);
        }
      }
      break;
    }
  }
}
