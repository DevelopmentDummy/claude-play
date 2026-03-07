import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import { getServices, cleanupServices } from "./services";
import { getUserIdFromCookie } from "./auth";

interface WSClient {
  ws: WebSocket;
  userId: string;
  sessionId: string | null;
  isBuilder: boolean;
}

// Use globalThis to share state across module instances (server.ts vs Next.js routes)
const WS_KEY = "__claude_bridge_ws__";
interface WSGlobal {
  clients: Set<WSClient>;
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // per-user timers
}

function getWSState(): WSGlobal {
  const g = globalThis as unknown as Record<string, WSGlobal>;
  if (!g[WS_KEY]) {
    g[WS_KEY] = { clients: new Set(), disconnectTimers: new Map() };
  }
  return g[WS_KEY];
}

/** Grace period before killing Claude process after last client disconnects */
const DISCONNECT_GRACE_MS = 5000;

/** Broadcast to all clients of a specific user */
export function wsBroadcastToUser(userId: string, event: string, data: unknown): void {
  const { clients } = getWSState();
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.userId !== userId) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      client.ws.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Broadcast to clients matching a filter within a user */
export function wsBroadcast(
  event: string,
  data: unknown,
  filter?: { userId?: string; sessionId?: string; isBuilder?: boolean }
): void {
  const { clients } = getWSState();
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (filter) {
      if (filter.userId && client.userId !== filter.userId) continue;
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

/** Check if a user has any connected clients; if not, schedule cleanup */
function scheduleCleanupIfEmpty(userId: string): void {
  const state = getWSState();

  // Clear existing timer for this user
  const existing = state.disconnectTimers.get(userId);
  if (existing) {
    clearTimeout(existing);
    state.disconnectTimers.delete(userId);
  }

  const hasActiveClients = [...state.clients].some(
    (c) => c.userId === userId && c.ws.readyState === WebSocket.OPEN
  );

  if (!hasActiveClients) {
    const timer = setTimeout(() => {
      state.disconnectTimers.delete(userId);
      const stillEmpty = ![...state.clients].some(
        (c) => c.userId === userId && c.ws.readyState === WebSocket.OPEN
      );
      if (stillEmpty) {
        console.log(`[ws] No clients for user ${userId} — cleaning up`);
        cleanupServices(userId);
      }
    }, DISCONNECT_GRACE_MS);
    state.disconnectTimers.set(userId, timer);
  }
}

/** Cancel cleanup for a user (called when a new client connects) */
function cancelCleanup(userId: string): void {
  const state = getWSState();
  const timer = state.disconnectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    state.disconnectTimers.delete(userId);
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

    // Authenticate via cookie
    const cookieHeader = req.headers.cookie || "";
    const userId = getUserIdFromCookie(cookieHeader);
    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = (query.sessionId as string) || null;
      const isBuilder = query.builder === "true";

      const client: WSClient = { ws, userId, sessionId, isBuilder };
      state.clients.add(client);
      cancelCleanup(userId);

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
        scheduleCleanupIfEmpty(userId);
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
  const svc = getServices(client.userId);

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
      console.log(`[ws] Client sent session:leave for user ${client.userId}`);
      svc.claude.kill();
      svc.panels.stop();
      break;
    }
  }
}
