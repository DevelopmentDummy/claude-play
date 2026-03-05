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
}

export function useWebSocket({
  sessionId,
  isBuilder,
  handlers,
  enabled = true,
}: UseWebSocketOptions) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const sendChat = useCallback((text: string) => {
    send("chat:send", { text });
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
