"use client";

import { useEffect, useRef, useCallback } from "react";

type SSEHandler = (data: unknown) => void;

export function useSSE(
  handlers: Record<string, SSEHandler>,
  enabled: boolean = true
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const connect = useCallback(() => {
    const es = new EventSource("/api/events");

    const eventTypes = [
      "claude:message",
      "claude:error",
      "claude:status",
      "panels:update",
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          handlersRef.current[type]?.(data);
        } catch {
          // ignore parse errors
        }
      });
    }

    es.onerror = () => {
      es.close();
      // Reconnect after 2 seconds
      setTimeout(connect, 2000);
    };

    return es;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const es = connect();
    return () => es.close();
  }, [connect, enabled]);
}
