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

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function splitStreamingChunk(text: string): { stableText: string; carryText: string } {
  if (!text) {
    return { stableText: "", carryText: "" };
  }

  if (!graphemeSegmenter) {
    const codePoints = Array.from(text);
    if (codePoints.length <= 1) {
      return { stableText: "", carryText: text };
    }
    const carryText = codePoints[codePoints.length - 1] || "";
    return {
      stableText: codePoints.slice(0, -1).join(""),
      carryText,
    };
  }

  const segments = Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  if (segments.length <= 1) {
    return { stableText: "", carryText: text };
  }

  const carryText = segments[segments.length - 1] || "";
  return {
    stableText: text.slice(0, text.length - carryText.length),
    carryText,
  };
}

/**
 * Character-level merge of two versions of the same text.
 * Where one has U+FFFD and the other has a real character, prefer the real one.
 * If lengths differ, fall back to whichever version has fewer U+FFFD overall.
 */
function mergeUtf8Texts(a: string, b: string): string {
  const charsA = Array.from(a);
  const charsB = Array.from(b);

  // If lengths don't match, can't do character-level merge — pick the cleaner one
  if (charsA.length !== charsB.length) {
    const countA = charsA.filter(c => c === "\ufffd").length;
    const countB = charsB.filter(c => c === "\ufffd").length;
    return countB < countA ? b : a;
  }

  let merged = false;
  const result = charsA.map((ca, i) => {
    const cb = charsB[i];
    if (ca === "\ufffd" && cb !== "\ufffd") {
      merged = true;
      return cb;
    }
    return ca;
  });

  return merged ? result.join("") : a;
}

export function useChat(rawSessionId?: string) {
  const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<string>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const rawAssistantTextRef = useRef("");
  const displayAssistantTextRef = useRef("");
  const carryAssistantTextRef = useRef("");
  const assistantFullTextRef = useRef<string | null>(null);
  const toolsRef = useRef<Array<{ name: string; input: unknown }>>([]);

  const seenToolKeysRef = useRef<Set<string>>(new Set());
  const sawTextDeltaRef = useRef(false);
  const currentBlockTypeRef = useRef<string>("text");
  const lastAssistantMsgIdRef = useRef<string | null>(null);
  const msgIdRef = useRef(0);
  const totalRef = useRef(0);
  const loadedOffsetRef = useRef(0);
  const oocRef = useRef(false);

  const addUserMessage = useCallback((text: string, ooc?: boolean) => {
    const id = `user-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, role: "user", content: text, ooc: ooc || undefined }]);
  }, []);

  const upsertAssistantMessage = useCallback((content: string) => {
    const isOOC = oocRef.current;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
        return [
          ...prev.slice(0, -1),
          { ...last, content, tools: [...toolsRef.current], ooc: isOOC || undefined },
        ];
      }
      const id = `stream-${++msgIdRef.current}`;
      return [
        ...prev,
        { id, role: "assistant", content, tools: [...toolsRef.current], ooc: isOOC || undefined },
      ];
    });
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    rawAssistantTextRef.current += text;

    const { stableText, carryText } = splitStreamingChunk(carryAssistantTextRef.current + text);
    carryAssistantTextRef.current = carryText;

    if (!stableText) return;

    displayAssistantTextRef.current += stableText;
    upsertAssistantMessage(displayAssistantTextRef.current);
  }, [upsertAssistantMessage]);

  const flushAssistantText = useCallback(() => {
    if (!rawAssistantTextRef.current) return;
    carryAssistantTextRef.current = "";
    displayAssistantTextRef.current = rawAssistantTextRef.current;
    upsertAssistantMessage(displayAssistantTextRef.current);
  }, [upsertAssistantMessage]);

  const addToolUse = useCallback(
    (name: string, input: unknown) => {
      const key = toolUseKey(name, input);
      if (seenToolKeysRef.current.has(key)) return;
      seenToolKeysRef.current.add(key);
      toolsRef.current.push({ name, input });

      // Trigger re-render with updated tools
      upsertAssistantMessage(displayAssistantTextRef.current);
    },
    [upsertAssistantMessage]
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
    flushAssistantText();

    // UTF-8 healing: character-level merge of delta-accumulated vs assistant full text.
    // The CLI may corrupt different positions in each version (different 4KB boundaries),
    // so merging character-by-character recovers most U+FFFD replacements.
    const deltaText = rawAssistantTextRef.current;
    const fullText = assistantFullTextRef.current;
    if (fullText && deltaText && sawTextDeltaRef.current) {
      const deltaHasFffd = deltaText.includes("\ufffd");
      const fullHasFffd = fullText.includes("\ufffd");
      if (deltaHasFffd || fullHasFffd) {
        const healed = mergeUtf8Texts(deltaText, fullText);
        if (healed !== deltaText) {
          upsertAssistantMessage(healed);
        }
      }
    }

    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];

    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    currentBlockTypeRef.current = "text";
    lastAssistantMsgIdRef.current = null;
    oocRef.current = false;
    setIsStreaming(false);
  }, [flushAssistantText, upsertAssistantMessage]);

  const handleClaudeMessage = useCallback(
    (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const msg = data as Record<string, unknown>;
      const type = msg.type;

      // Gemini: tool_use after text causes full re-stream; reset accumulated text
      if (type === "content_reset") {
        rawAssistantTextRef.current = "";
        displayAssistantTextRef.current = "";
        carryAssistantTextRef.current = "";
        assistantFullTextRef.current = null;
        toolsRef.current = [];
        seenToolKeysRef.current.clear();
        upsertAssistantMessage("");
        return;
      }

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

        // Guard: same msg ID emitted multiple times (one per content block completion).
        // Skip text from repeat emissions to prevent duplication; still process tool_use.
        const assistantMsgId = message.id as string | undefined;
        const isRepeatMsg = !!(assistantMsgId && assistantMsgId === lastAssistantMsgIdRef.current);
        if (assistantMsgId) lastAssistantMsgIdRef.current = assistantMsgId;

        // Always capture full text for UTF-8 healing at turn end
        const fullParts: string[] = [];
        if (typeof message.content === "string") {
          fullParts.push(message.content);
          if (!sawTextDeltaRef.current && !isRepeatMsg) {
            appendAssistantText(message.content);
          }
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              fullParts.push(b.text);
              if (!sawTextDeltaRef.current && !isRepeatMsg) {
                appendAssistantText(b.text);
              }
            }
            else if (b.type === "tool_use") addToolUse(b.name as string, b.input);
          }
        }
        if (fullParts.length > 0) {
          assistantFullTextRef.current = fullParts.join("");
        }
      }

      if (type === "result") {
        if (!rawAssistantTextRef.current && msg.result) {
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
      rawAssistantTextRef.current = "";
      displayAssistantTextRef.current = "";
      carryAssistantTextRef.current = "";
      assistantFullTextRef.current = null;
      toolsRef.current = [];
      seenToolKeysRef.current.clear();
      sawTextDeltaRef.current = false;
      currentBlockTypeRef.current = "text";
      lastAssistantMsgIdRef.current = null;
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
          body: JSON.stringify({ text, sessionId }),
        });
      } catch (err) {
        rawAssistantTextRef.current = "";
        displayAssistantTextRef.current = "";
        carryAssistantTextRef.current = "";
        assistantFullTextRef.current = null;
        toolsRef.current = [];
        seenToolKeysRef.current.clear();
        sawTextDeltaRef.current = false;
        setError(err instanceof Error ? err.message : "Failed to send");
        setIsStreaming(false);
      }
    },
    [prepareSend, sessionId]
  );

  /** Handle cancellation: finalize partial text and reset streaming state */
  const handleCancelled = useCallback(() => {
    flushAssistantText();
    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];
    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    currentBlockTypeRef.current = "text";
    lastAssistantMsgIdRef.current = null;
    oocRef.current = false;
    setIsStreaming(false);
    setStatus("connected");
  }, [flushAssistantText]);

  const addOpeningMessage = useCallback((text: string) => {
    const id = `opening-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, role: "assistant", content: text }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];

    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    currentBlockTypeRef.current = "text";
    lastAssistantMsgIdRef.current = null;
    oocRef.current = false;
  }, []);

  const loadHistory = useCallback(async (): Promise<number> => {
    const TARGET_VISIBLE = 10;
    try {
      const historyBase = sessionId ? `/api/chat/history?sessionId=${sessionId}` : "/api/chat/history";
      const res = await fetch(historyBase);
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
        const moreRes = await fetch(`/api/chat/history?offset=${newOffset}&limit=${limit}${sessionId ? `&sessionId=${sessionId}` : ""}`);
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
  }, [sessionId]);

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
        const res = await fetch(`/api/chat/history?offset=${newOffset}&limit=${limit}${sessionId ? `&sessionId=${sessionId}` : ""}`);
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
  }, [sessionId]);

  const toggleMessageOOC = useCallback(async (id: string, ooc: boolean) => {
    const res = await fetch("/api/chat/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ooc, sessionId }),
    });
    if (!res.ok) return;
    const data = await res.json() as { message: ChatMessage };
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ooc: data.message.ooc, content: data.message.content } : m))
    );
  }, [sessionId]);

  return {
    messages,
    isStreaming,
    setStreamingManually: setIsStreaming,
    status,
    error,
    hasMore,
    setStatus,
    setError,
    prepareSend,
    sendMessage,
    handleClaudeMessage,
    handleCancelled,
    assignMessageId,
    addUserMessage,
    addOpeningMessage,
    clearMessages,
    loadHistory,
    loadMore,
    toggleMessageOOC,
  };
}
