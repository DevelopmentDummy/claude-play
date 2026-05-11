"use client";

import { useEffect, useRef, useCallback } from "react";

type SSEHandler = (data: unknown) => void;

export function useSSE(
  handlers: Record<string, SSEHandler>,
  enabled: boolean = true
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const connect = useCallback(() => {
    if (cancelledRef.current) return;
    esRef.current?.close();

    const es = new EventSource("/api/events");
    esRef.current = es;

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
      if (cancelledRef.current) return;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 2000);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    connect();
    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect, enabled]);
}
