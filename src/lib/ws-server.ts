import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import { getServices } from "./services";

interface WSClient {
  ws: WebSocket;
  sessionId: string | null;
  isBuilder: boolean;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WSClient>();

/** Grace period before killing Claude process after last client disconnects */
const DISCONNECT_GRACE_MS = 5000;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Broadcast to all clients bound to a specific session (or builder persona) */
export function wsBroadcast(
  event: string,
  data: unknown,
  filter?: { sessionId?: string; isBuilder?: boolean }
): void {
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

/** Broadcast to ALL connected clients (for backward compat during migration) */
export function wsBroadcastAll(event: string, data: unknown): void {
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      client.ws.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Check if any clients are still connected; if none, schedule process cleanup */
function scheduleCleanupIfEmpty(): void {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  const hasActiveClients = [...clients].some(
    (c) => c.ws.readyState === WebSocket.OPEN
  );

  if (!hasActiveClients) {
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      // Double-check no one reconnected during grace period
      const stillEmpty = ![...clients].some(
        (c) => c.ws.readyState === WebSocket.OPEN
      );
      if (stillEmpty) {
        console.log("[ws] No clients connected — killing Claude process");
        const svc = getServices();
        svc.claude.kill();
        svc.panels.stop();
      }
    }, DISCONNECT_GRACE_MS);
  }
}

/** Cancel any pending cleanup (called when a new client connects) */
function cancelCleanup(): void {
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
}

export function setupWebSocket(server: HTTPServer): void {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parse(req.url || "", true);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = (query.sessionId as string) || null;
      const isBuilder = query.builder === "true";

      const client: WSClient = { ws, sessionId, isBuilder };
      clients.add(client);
      cancelCleanup(); // New client arrived, cancel any pending kill

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          handleMessage(client, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        clients.delete(client);
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
      svc.addUserToHistory(text);
      svc.claude.send(text);
      break;
    }

    case "session:bind": {
      // Allow client to re-bind to a different session
      client.sessionId = (msg.sessionId as string) || null;
      client.isBuilder = !!(msg.isBuilder);
      break;
    }

    case "session:leave": {
      // Client explicitly leaving — kill immediately
      console.log("[ws] Client sent session:leave — killing Claude process");
      svc.claude.kill();
      svc.panels.stop();
      break;
    }
  }
}
