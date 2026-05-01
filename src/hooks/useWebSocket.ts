"use client";

import { useEffect, useRef, useCallback } from "react";

type WSHandler = (data: unknown) => void;

interface UseWebSocketOptions {
  /** Session ID to bind this connection to */
  sessionId?: string;
  /** Whether this is a builder session */
  isBuilder?: boolean;
  /** Event handlers keyed by event name */
  handlers: Record<string, WSHandler>;
  /** Whether the connection is enabled */
  enabled?: boolean;
  /** Called when reconnecting to a session that is no longer active on the server */
  onSessionLost?: () => void;
}

const wsTextDecoder = new TextDecoder("utf-8");

function decodeWsMessage(data: string | ArrayBuffer | Blob): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return wsTextDecoder.decode(new Uint8Array(data));
  }
  return null;
}

export function useWebSocket({
  sessionId,
  isBuilder,
  handlers,
  enabled = true,
  onSessionLost,
}: UseWebSocketOptions) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const onSessionLostRef = useRef(onSessionLost);
  onSessionLostRef.current = onSessionLost;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialConnectRef = useRef(true);

  const connect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (sessionId) {
      // Next.js useParams() returns URL-encoded route segments (e.g. Korean → %EC%8B%9C...).
      // URLSearchParams.set() will encode again, producing %25EC%258B%259C... (double-encoded).
      // Decode once first so the wire format ends up single-encoded.
      let sid = sessionId;
      try { sid = decodeURIComponent(sid); } catch { /* leave as-is if not encoded */ }
      params.set("sessionId", sid);
    }
    if (isBuilder) params.set("builder", "true");
    const url = `${protocol}//${window.location.host}/ws?${params}`;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (sessionId || isBuilder) {
        // Decode once (same reason as URL above) so server-side normalizeSessionId yields the raw id.
        let sid: string | undefined = sessionId;
        if (sid) { try { sid = decodeURIComponent(sid); } catch { /* keep raw */ } }
        ws.send(JSON.stringify({
          type: "session:bind",
          sessionId: sid,
          isBuilder: !!isBuilder,
        }));
      }
    };

    ws.onmessage = (e) => {
      try {
        const rawText = decodeWsMessage(e.data);
        if (!rawText) return;
        const { event, data } = JSON.parse(rawText);
        // On reconnect, detect if session process is no longer running
        if (event === "connected" && !initialConnectRef.current) {
          const d = data as { sessionActive?: boolean };
          if (sessionId && d.sessionActive === false) {
            onSessionLostRef.current?.();
          }
        }
        if (event === "connected") {
          initialConnectRef.current = false;
        }
        handlersRef.current[event]?.(data);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Reconnect after 2 seconds
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [sessionId, isBuilder]);

  /** Send a message through the WebSocket */
  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  /** Send a chat message */
  const sendChat = useCallback((text: string, silent?: boolean) => {
    send("chat:send", silent ? { text, silent: true } : { text });
  }, [send]);

  /** Cancel the current streaming response */
  const sendCancel = useCallback(() => {
    send("chat:cancel");
  }, [send]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, enabled]);

  return { send, sendChat, sendCancel };
}
