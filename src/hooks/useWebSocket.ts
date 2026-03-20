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
    if (sessionId) params.set("sessionId", sessionId);
    if (isBuilder) params.set("builder", "true");
    const url = `${protocol}//${window.location.host}/ws?${params}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const { event, data } = JSON.parse(e.data);
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

  return { send, sendChat };
}
