import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import { getServices, cleanupServices } from "./services";

interface WSClient {
  ws: WebSocket;
  sessionId: string | null;
  isBuilder: boolean;
}

// Use globalThis to share state across module instances (server.ts vs Next.js routes)
const WS_KEY = "__claude_bridge_ws__";
interface WSGlobal {
  clients: Set<WSClient>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

function getWSState(): WSGlobal {
  const g = globalThis as unknown as Record<string, WSGlobal>;
  if (!g[WS_KEY]) {
    g[WS_KEY] = { clients: new Set(), disconnectTimer: null };
  }
  return g[WS_KEY];
}

/** Grace period before killing AI process after last client disconnects */
const DISCONNECT_GRACE_MS = 5000;

/** Broadcast to all connected clients */
export function wsBroadcast(
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean }
): void {
  const { clients } = getWSState();
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (filter) {
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

/** Check if there are any connected clients; if not, schedule cleanup */
function scheduleCleanupIfEmpty(): void {
  const state = getWSState();

  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }

  const hasActiveClients = [...state.clients].some(
    (c) => c.ws.readyState === WebSocket.OPEN
  );

  if (!hasActiveClients) {
    state.disconnectTimer = setTimeout(() => {
      state.disconnectTimer = null;
      const stillEmpty = ![...state.clients].some(
        (c) => c.ws.readyState === WebSocket.OPEN
      );
      if (stillEmpty) {
        console.log("[ws] No clients connected — cleaning up");
        cleanupServices();
      }
    }, DISCONNECT_GRACE_MS);
  }
}

/** Cancel cleanup timer (called when a new client connects) */
function cancelCleanup(): void {
  const state = getWSState();
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = (query.sessionId as string) || null;
      const isBuilder = query.builder === "true";

      const client: WSClient = { ws, sessionId, isBuilder };
      state.clients.add(client);
      cancelCleanup();

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleMessage(client, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        state.clients.delete(client);
        scheduleCleanupIfEmpty();
      });

      // Send connection ack
      ws.send(JSON.stringify({
        event: "connected",
        data: { sessionId, isBuilder },
      }));
    });
  });
}

function handleMessage(
  client: WSClient,
  msg: { type: string; [key: string]: unknown }
): void {
  const svc = getServices();

  switch (msg.type) {
    case "chat:send": {
      const text = msg.text as string;
      if (!text?.trim()) return;
      const isOOC = text.startsWith("OOC:");
      svc.isOOC = isOOC;
      svc.addUserToHistory(text, isOOC);
      svc.claude.send(text);
      break;
    }

    case "session:bind": {
      client.sessionId = (msg.sessionId as string) || null;
      client.isBuilder = !!(msg.isBuilder);
      break;
    }

    case "session:leave": {
      console.log("[ws] Client sent session:leave");
      svc.claude.kill();
      svc.panels.stop();
      break;
    }
  }
}
