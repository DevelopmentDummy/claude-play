"use client";

import { useState, useCallback, useRef } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ name: string; input: unknown }>;
  ooc?: boolean;
}

function toolUseKey(name: string, input: unknown): string {
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:${String(input)}`;
  }
}

function sanitizeFilename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function detectImageToken(toolName: string, input: unknown): string | null {
  const imageToolNames = new Set([
    "mcp__claude_bridge__generate_image",
    "mcp__claude_bridge__generate_image_gemini",
    "mcp__claude_bridge__comfyui_generate",
    "mcp__claude_bridge__gemini_generate",
  ]);
  if (!imageToolNames.has(toolName)) return null;

  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  const fromPath = typeof body.path === "string" ? body.path.trim() : "";
  if (fromPath.startsWith("images/")) {
    return `$IMAGE:${fromPath}$`;
  }

  const filename = typeof body.filename === "string" ? sanitizeFilename(body.filename) : "";
  if (!filename) return null;
  return `$IMAGE:images/${filename}$`;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const segmentsRef = useRef<string[]>([]);
  const toolsRef = useRef<Array<{ name: string; input: unknown }>>([]);
  const autoImageTokensRef = useRef<Set<string>>(new Set());
  const seenToolKeysRef = useRef<Set<string>>(new Set());
  const sawTextDeltaRef = useRef(false);
  const currentBlockTypeRef = useRef<string>("text");
  const msgIdRef = useRef(0);
  const totalRef = useRef(0);
  const loadedOffsetRef = useRef(0);
  const oocRef = useRef(false);

  const addUserMessage = useCallback((text: string, ooc?: boolean) => {
    const id = `user-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, role: "user", content: text, ooc: ooc || undefined }]);
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    segmentsRef.current.push(text);
    const fullText = segmentsRef.current.join("");
    const isOOC = oocRef.current;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
        return [
          ...prev.slice(0, -1),
          { ...last, content: fullText, tools: [...toolsRef.current], ooc: isOOC || undefined },
        ];
      }
      const id = `stream-${++msgIdRef.current}`;
      return [
        ...prev,
        { id, role: "assistant", content: fullText, tools: [...toolsRef.current], ooc: isOOC || undefined },
      ];
    });
  }, []);

  const addToolUse = useCallback(
    (name: string, input: unknown) => {
      const key = toolUseKey(name, input);
      if (seenToolKeysRef.current.has(key)) return;
      seenToolKeysRef.current.add(key);
      toolsRef.current.push({ name, input });
      const imageToken = detectImageToken(name, input);
      if (imageToken && !autoImageTokensRef.current.has(imageToken)) {
        autoImageTokensRef.current.add(imageToken);
        if (!segmentsRef.current.join("").includes(imageToken)) {
          segmentsRef.current.push(`\n${imageToken}\n`);
        }
      }

      const fullText = segmentsRef.current.join("");
      const isOOC = oocRef.current;

      // Trigger re-render with updated tools
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: fullText, tools: [...toolsRef.current], ooc: isOOC || undefined },
          ];
        }
        const id = `stream-${++msgIdRef.current}`;
        return [
          ...prev,
          { id, role: "assistant", content: fullText, tools: [...toolsRef.current], ooc: isOOC || undefined },
        ];
      });
    },
    []
  );

  /** Replace last stream-* message ID with the backend's canonical ID */
  const assignMessageId = useCallback((backendId: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
        return [...prev.slice(0, -1), { ...last, id: backendId }];
      }
      return prev;
    });
  }, []);

  const finishAssistantTurn = useCallback(() => {
    segmentsRef.current = [];
    toolsRef.current = [];
    autoImageTokensRef.current.clear();
    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    currentBlockTypeRef.current = "text";
    oocRef.current = false;
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

        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          currentBlockTypeRef.current = (block?.type as string) || "text";
          if (block?.type === "tool_use") {
            addToolUse(block.name as string, block.input);
          }
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          // Skip thinking block deltas — only accept text deltas from text blocks
          if (delta?.type === "text_delta" && typeof delta.text === "string" && currentBlockTypeRef.current === "text") {
            sawTextDeltaRef.current = true;
            appendAssistantText(delta.text);
          }
        }

        if (event.type === "content_block_stop") {
          currentBlockTypeRef.current = "text";
        }
      }

      if (type === "assistant") {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) return;
        if (typeof message.content === "string") {
          if (!sawTextDeltaRef.current) {
            appendAssistantText(message.content);
          }
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text") {
              if (!sawTextDeltaRef.current && typeof b.text === "string") {
                appendAssistantText(b.text);
              }
            }
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
      const isOOC = text.startsWith("OOC:");
      oocRef.current = isOOC;
      sawTextDeltaRef.current = false;
      addUserMessage(text, isOOC);
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
    autoImageTokensRef.current.clear();
    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
  }, []);

  const loadHistory = useCallback(async (): Promise<number> => {
    const TARGET_VISIBLE = 10;
    try {
      const res = await fetch("/api/chat/history");
      if (!res.ok) return 0;
      const data = await res.json() as { messages: ChatMessage[]; total: number; offset: number };
      totalRef.current = data.total;
      loadedOffsetRef.current = data.offset;
      let allMessages = data.messages as ChatMessage[];

      // Keep loading older batches until we have enough non-OOC messages
      while (loadedOffsetRef.current > 0) {
        const nonOOCCount = allMessages.filter((m) => !m.ooc).length;
        if (nonOOCCount >= TARGET_VISIBLE) break;
        const batchSize = 10;
        const newOffset = Math.max(0, loadedOffsetRef.current - batchSize);
        const limit = loadedOffsetRef.current - newOffset;
        const moreRes = await fetch(`/api/chat/history?offset=${newOffset}&limit=${limit}`);
        if (!moreRes.ok) break;
        const moreData = await moreRes.json() as { messages: ChatMessage[] };
        loadedOffsetRef.current = newOffset;
        allMessages = [...moreData.messages, ...allMessages];
      }

      if (allMessages.length > 0) {
        setMessages(allMessages);
        msgIdRef.current = allMessages.length;
      }
      setHasMore(loadedOffsetRef.current > 0);
      return allMessages.length;
    } catch { /* ignore */ }
    return 0;
  }, []);

  const loadMore = useCallback(async (): Promise<number> => {
    if (loadedOffsetRef.current <= 0) return 0;
    const TARGET_VISIBLE = 10;
    let accumulated: ChatMessage[] = [];

    try {
      // Keep loading batches until we have enough non-OOC messages or exhaust history
      while (loadedOffsetRef.current > 0) {
        const batchSize = 10;
        const newOffset = Math.max(0, loadedOffsetRef.current - batchSize);
        const limit = loadedOffsetRef.current - newOffset;
        const res = await fetch(`/api/chat/history?offset=${newOffset}&limit=${limit}`);
        if (!res.ok) break;
        const data = await res.json() as { messages: ChatMessage[] };
        loadedOffsetRef.current = newOffset;
        accumulated = [...data.messages, ...accumulated];
        const nonOOCCount = accumulated.filter((m) => !m.ooc).length;
        if (nonOOCCount >= TARGET_VISIBLE) break;
      }

      setHasMore(loadedOffsetRef.current > 0);
      if (accumulated.length > 0) {
        setMessages((prev) => [...accumulated, ...prev]);
        return accumulated.length;
      }
    } catch { /* ignore */ }
    return 0;
  }, []);

  const toggleMessageOOC = useCallback(async (id: string, ooc: boolean) => {
    const res = await fetch("/api/chat/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ooc }),
    });
    if (!res.ok) return;
    const data = await res.json() as { message: ChatMessage };
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ooc: data.message.ooc, content: data.message.content } : m))
    );
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
    assignMessageId,
    addOpeningMessage,
    clearMessages,
    loadHistory,
    loadMore,
    toggleMessageOOC,
  };
}
