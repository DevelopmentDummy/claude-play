"use client";

import { useState, useCallback, useRef } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const segmentsRef = useRef<string[]>([]);
  const toolsRef = useRef<Array<{ name: string; input: unknown }>>([]);
  const msgIdRef = useRef(0);
  const totalRef = useRef(0);
  const loadedOffsetRef = useRef(0);

  const addUserMessage = useCallback((text: string) => {
    const id = `user-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, role: "user", content: text }]);
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    segmentsRef.current.push(text);
    const fullText = segmentsRef.current.join("");

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
        return [
          ...prev.slice(0, -1),
          { ...last, content: fullText, tools: [...toolsRef.current] },
        ];
      }
      const id = `stream-${++msgIdRef.current}`;
      return [
        ...prev,
        { id, role: "assistant", content: fullText, tools: [...toolsRef.current] },
      ];
    });
  }, []);

  const addToolUse = useCallback(
    (name: string, input: unknown) => {
      toolsRef.current.push({ name, input });
      // Trigger re-render with updated tools
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
          return [
            ...prev.slice(0, -1),
            { ...last, tools: [...toolsRef.current] },
          ];
        }
        const id = `stream-${++msgIdRef.current}`;
        return [
          ...prev,
          { id, role: "assistant", content: "", tools: [...toolsRef.current] },
        ];
      });
    },
    []
  );

  const finishAssistantTurn = useCallback(() => {
    segmentsRef.current = [];
    toolsRef.current = [];
    setIsStreaming(false);
  }, []);

  const handleClaudeMessage = useCallback(
    (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      const type = msg.type;

      if (type === "stream_event") {
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) return;

        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            appendAssistantText(delta.text);
          }
        }

        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            addToolUse(block.name as string, block.input);
          }
        }
      }

      if (type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) return;
        if (typeof message.content === "string") {
          appendAssistantText(message.content);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") appendAssistantText(b.text as string);
            else if (b.type === "tool_use") addToolUse(b.name as string, b.input);
          }
        }
      }

      if (type === "result") {
        if (segmentsRef.current.length === 0 && msg.result) {
          const result = msg.result as Record<string, unknown>;
          const text =
            typeof result === "string"
              ? result
              : typeof result.text === "string"
                ? result.text
                : null;
          if (text) appendAssistantText(text);
        }
        finishAssistantTurn();
        setStatus("connected");
      }
    },
    [appendAssistantText, addToolUse, finishAssistantTurn]
  );

  /** Prepare local UI state for sending (adds user message, sets streaming). Does NOT send to server. */
  const prepareSend = useCallback(
    (text: string) => {
      addUserMessage(text);
      setIsStreaming(true);
      setError(null);
    },
    [addUserMessage]
  );

  /** Send via REST (legacy fallback, used by builder) */
  const sendMessage = useCallback(
    async (text: string) => {
      prepareSend(text);
      try {
        await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send");
        setIsStreaming(false);
      }
    },
    [prepareSend]
  );

  const addOpeningMessage = useCallback((text: string) => {
    const id = `opening-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, role: "assistant", content: text }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    segmentsRef.current = [];
    toolsRef.current = [];
  }, []);

  const loadHistory = useCallback(async (): Promise<number> => {
    try {
      const res = await fetch("/api/chat/history");
      if (res.ok) {
        const data = await res.json() as { messages: ChatMessage[]; total: number; offset: number };
        totalRef.current = data.total;
        loadedOffsetRef.current = data.offset;
        if (data.messages.length > 0) {
          setMessages(data.messages);
          msgIdRef.current = data.messages.length;
        }
        setHasMore(data.offset > 0);
        return data.messages.length;
      }
    } catch { /* ignore */ }
    return 0;
  }, []);

  const loadMore = useCallback(async (): Promise<number> => {
    if (loadedOffsetRef.current <= 0) return 0;
    const batchSize = 10;
    const newOffset = Math.max(0, loadedOffsetRef.current - batchSize);
    const limit = loadedOffsetRef.current - newOffset;

    try {
      const res = await fetch(`/api/chat/history?offset=${newOffset}&limit=${limit}`);
      if (res.ok) {
        const data = await res.json() as { messages: ChatMessage[]; total: number; offset: number };
        loadedOffsetRef.current = newOffset;
        setHasMore(newOffset > 0);
        if (data.messages.length > 0) {
          setMessages((prev) => [...data.messages, ...prev]);
          return data.messages.length;
        }
      }
    } catch { /* ignore */ }
    return 0;
  }, []);

  return {
    messages,
    isStreaming,
    status,
    error,
    hasMore,
    setStatus,
    setError,
    prepareSend,
    sendMessage,
    handleClaudeMessage,
    addOpeningMessage,
    clearMessages,
    loadHistory,
    loadMore,
  };
}
