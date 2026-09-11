"use client";

import { useState, useCallback, useRef } from "react";
import type { ToolAnswer } from "@/lib/session-instance";

export interface ChatMessage {
  id: string;
  /** Stable key for React rendering — survives id reassignment (stream-* → backend id) */
  renderKey: string;
  role: "user" | "assistant";
  content: string;
  tools?: Array<{ id?: string; name: string; input: unknown; answer?: ToolAnswer }>;
  ooc?: boolean;
  /** True while this message is still being streamed (set at creation, cleared on finish) */
  live?: boolean;
}

function toolUseKey(name: string, input: unknown, id?: string): string {
  if (id) return `id:${id}`;
  try {
    return `${name}:${JSON.stringify(input)}`;
  } catch {
    return `${name}:${String(input)}`;
  }
}

/** Serialized length of a tool input, for picking the more complete of two
 *  deliveries of the same tool_use id (streamed start carries empty input,
 *  the cumulative assistant message carries the full input). */
function toolInputLen(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return 0;
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
  const toolsRef = useRef<Array<{ id?: string; name: string; input: unknown; answer?: ToolAnswer }>>([]);

  const seenToolKeysRef = useRef<Set<string>>(new Set());
  const sawTextDeltaRef = useRef(false);
  /** 이번 턴이 개입으로 분할됐는가 — 스트리밍 ref가 분할 이후 나머지만 담고 있음을 뜻한다.
   *  서버 SessionInstance.turnSplit과 같은 의미(healing/result 폴백 차단). */
  const turnSplitRef = useRef(false);
  const currentBlockTypeRef = useRef<string>("text");
  const pushedTextsByMsgIdRef = useRef<Map<string, Set<string>>>(new Map());
  const msgIdRef = useRef(0);
  const totalRef = useRef(0);
  const loadedOffsetRef = useRef(0);
  const oocRef = useRef(false);

  const upsertAssistantMessage = useCallback((content: string) => {
    const isOOC = oocRef.current;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.id.startsWith("stream-")) {
        // toolsRef.current가 비어있으면 기존 tools를 보존한다.
        // finishAssistantTurn은 flushAssistantText()로 이 updater를 큐에 넣은 뒤
        // (동기적으로) toolsRef.current = [] 로 리셋한다. updater는 나중에 React
        // 렌더 단계에서 실행되므로 그대로 [...toolsRef.current]를 읽으면 빈 배열이
        // 되어 AskUserQuestion 카드/툴 블록이 turn 종료 순간 통째로 사라진다.
        return [
          ...prev.slice(0, -1),
          { ...last, content, tools: toolsRef.current.length ? [...toolsRef.current] : (last.tools ?? []), ooc: isOOC || undefined },
        ];
      }
      const id = `stream-${++msgIdRef.current}`;
      return [
        ...prev,
        { id, renderKey: id, role: "assistant", content, tools: [...toolsRef.current], ooc: isOOC || undefined, live: true },
      ];
    });
  }, []);

  /** 사용자 메시지를 추가한다. AI 턴이 진행 중(live stream 버블이 꼬리에 있음)이면
   *  **턴을 분할**한다 — 지금까지 스트리밍된 본문을 그대로 얼려(live 해제) 남기고
   *  그 뒤에 유저 메시지를 붙인다. 이후 delta는 새 stream 버블을 열어 이어진다.
   *  결과 순서는 [유저][응답 앞부분][개입][응답 뒷부분]이고, 서버도 같은 시점에
   *  `splitAssistantTurnForInterject()`로 history를 쪼개므로 재로드 후에도 유지된다.
   *  본문이 아직 없으면(툴만 돌던 중) 분할할 게 없으므로 종전대로 라이브 버블 위에
   *  끼워 넣는다 — 라이브 버블은 `prev[prev.length-1]`(upsertAssistantMessage의
   *  타깃)로 남아야 delta 파이프라인이 깨지지 않는다.
   *  로컬 개입(prepareInterject)과 다른 클라이언트의 개입 브로드캐스트(`chat:user`)가
   *  같은 규칙을 타야 두 클라이언트의 순서가 일치한다. */
  const addUserMessage = useCallback((text: string, ooc?: boolean) => {
    const id = `user-${++msgIdRef.current}`;
    const userMsg: ChatMessage = { id, renderKey: id, role: "user", content: text, ooc: ooc || undefined };
    // 라이브 버블에 표시된 본문 = displayAssistantTextRef. 비어 있으면 분할 대상이 없다.
    const splitting = displayAssistantTextRef.current.trim().length > 0;

    if (splitting) {
      // carry(포맷터가 붙들고 있던 미표시 꼬리)를 먼저 토해내야 글자가 유실되지 않는다.
      carryAssistantTextRef.current = "";
      displayAssistantTextRef.current = rawAssistantTextRef.current;
      upsertAssistantMessage(displayAssistantTextRef.current);
    }

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.live && last.id.startsWith("stream-")) {
        if (splitting) return [...prev.slice(0, -1), { ...last, live: undefined }, userMsg];
        return [...prev.slice(0, -1), userMsg, last];
      }
      return [...prev, userMsg];
    });

    if (splitting) {
      // 나머지 본문은 새 버블에서 처음부터 누적한다. assistantFullText는 턴 전체를
      // 담아 remainder와 길이가 어긋나므로 healing/result 폴백을 이번 턴 한정으로 끈다.
      rawAssistantTextRef.current = "";
      displayAssistantTextRef.current = "";
      assistantFullTextRef.current = null;
      toolsRef.current = [];
      turnSplitRef.current = true;
    }
  }, [upsertAssistantMessage]);

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
    (name: string, input: unknown, id?: string) => {
      // Same tool_use id can arrive twice: streamed content_block_start with empty
      // input, then the cumulative assistant message with the full input. Refresh to
      // the more complete input instead of skipping, so AskUserQuestion keeps its
      // `questions` and renders as a card rather than an empty tool block.
      if (id) {
        const existing = toolsRef.current.find((t) => t.id === id);
        if (existing) {
          if (toolInputLen(input) > toolInputLen(existing.input)) {
            existing.input = input;
            upsertAssistantMessage(displayAssistantTextRef.current);
          }
          return;
        }
      }
      const key = toolUseKey(name, input, id);
      if (seenToolKeysRef.current.has(key)) return;
      seenToolKeysRef.current.add(key);
      toolsRef.current.push({ id, name, input });

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

  /** 개입 분할로 얼린 버블에 서버가 확정한 history id를 부여한다(`chat:split`).
   *  타깃은 "꼬리에서 가장 가까운, live가 아닌 stream-* assistant 메시지" —
   *  분할 직후 열린 새 라이브 버블은 live라서 자연히 제외된다. */
  const assignSplitMessageId = useCallback((backendId: string) => {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === "assistant" && !m.live && m.id.startsWith("stream-")) {
          const next = [...prev];
          next[i] = { ...m, id: backendId };
          return next;
        }
      }
      return prev;
    });
  }, []);

  const finishAssistantTurn = useCallback((backendId?: string, contentOverride?: string) => {
    flushAssistantText();

    // UTF-8 healing: character-level merge of delta-accumulated vs assistant full text.
    // The CLI may corrupt different positions in each version (different 4KB boundaries),
    // so merging character-by-character recovers most U+FFFD replacements.
    const deltaText = rawAssistantTextRef.current;
    const fullText = assistantFullTextRef.current;
    let healedText: string | null = null;
    if (fullText && deltaText && sawTextDeltaRef.current && !turnSplitRef.current) {
      const deltaHasFffd = deltaText.includes("\ufffd");
      const fullHasFffd = fullText.includes("\ufffd");
      if (deltaHasFffd || fullHasFffd) {
        const healed = mergeUtf8Texts(deltaText, fullText);
        if (healed !== deltaText) {
          healedText = healed;
        }
      }
    }

    // Single setMessages call: apply healed text + clear live flag + assign backend ID
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.live) {
        const updated = { ...last, live: undefined };
        // contentOverride(누출 스트립된 본문)가 있으면 표시 텍스트를 그것으로 교체한다.
        if (typeof contentOverride === "string") updated.content = contentOverride;
        else if (healedText) updated.content = healedText;
        if (backendId) updated.id = backendId;
        return [...prev.slice(0, -1), updated];
      }
      return prev;
    });

    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];

    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    turnSplitRef.current = false;
    currentBlockTypeRef.current = "text";
    pushedTextsByMsgIdRef.current.clear();
    oocRef.current = false;
    setIsStreaming(false);
  }, [flushAssistantText]);

  /** 서버가 버린 턴(turnDiscarded: 누출된 툴콜 XML / antigravity 메타 응답)을
   *  화면에서 제거한다. finishAssistantTurn과 달리 스트리밍 버퍼를 flush하지 않고
   *  진행 중이던 live assistant 메시지를 통째로 드롭한다. 서버는 이미 silent retry를
   *  걸어 진짜 응답을 곧 새 메시지로 스트리밍한다. */
  const discardAssistantTurn = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.live) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];
    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    turnSplitRef.current = false;
    currentBlockTypeRef.current = "text";
    pushedTextsByMsgIdRef.current.clear();
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
            addToolUse(block.name as string, block.input, block.id as string | undefined);
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

        // Per-msgId content-based dedup. CLI emits one block per emission with
        // shared msgId (thinking → text → tool_use); dedup-by-content prevents
        // double-push whether emissions are per-block or cumulative.
        const assistantMsgId = message.id as string | undefined;
        const appendTextOnce = (text: string): void => {
          if (sawTextDeltaRef.current) return;
          if (!assistantMsgId) { appendAssistantText(text); return; }
          let pushed = pushedTextsByMsgIdRef.current.get(assistantMsgId);
          if (!pushed) { pushed = new Set(); pushedTextsByMsgIdRef.current.set(assistantMsgId, pushed); }
          if (pushed.has(text)) return;
          pushed.add(text);
          appendAssistantText(text);
        };

        // Always capture full text for UTF-8 healing at turn end
        const fullParts: string[] = [];
        if (typeof message.content === "string") {
          fullParts.push(message.content);
          appendTextOnce(message.content);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              fullParts.push(b.text);
              appendTextOnce(b.text);
            }
            else if (b.type === "tool_use") addToolUse(b.name as string, b.input, b.id as string | undefined);
          }
        }
        if (fullParts.length > 0) {
          assistantFullTextRef.current = fullParts.join("");
        }
      }

      if (type === "result") {
        // 서버가 버린 턴(antigravity 메타): 스트리밍된 live 메시지를 폐기.
        if (msg.turnDiscarded === true) {
          discardAssistantTurn();
          setStatus("connected");
        } else if (msg.leakStripped === true) {
          // 누출된 툴콜 XML이 제거된 케이스: 표시 텍스트를 cleanedContent로 교체.
          // 빈 문자열(순수 누출)이면 메시지를 통째로 제거. silent retry가 곧 이어진다.
          const cleaned = typeof msg.cleanedContent === "string" ? msg.cleanedContent : "";
          if (cleaned.trim() === "") {
            discardAssistantTurn();
          } else {
            const backendId = typeof msg.messageId === "string" ? msg.messageId : undefined;
            finishAssistantTurn(backendId, cleaned);
          }
          setStatus("connected");
        } else {
          if (!rawAssistantTextRef.current && !turnSplitRef.current && msg.result) {
            const result = msg.result as Record<string, unknown>;
            const text =
              typeof result === "string"
                ? result
                : typeof result.text === "string"
                  ? result.text
                  : null;
            if (text) appendAssistantText(text);
          }
          // Pass messageId (included in result payload) so finishAssistantTurn
          // can assign the backend ID in the same setMessages call (no flicker).
          const backendId = typeof msg.messageId === "string" ? msg.messageId : undefined;
          finishAssistantTurn(backendId);
          setStatus("connected");
        }
      }

    },
    [appendAssistantText, addToolUse, finishAssistantTurn, discardAssistantTurn]
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
      turnSplitRef.current = false;
      currentBlockTypeRef.current = "text";
      pushedTextsByMsgIdRef.current.clear();
      addUserMessage(text, isOOC);
      setIsStreaming(true);
      setError(null);
    },
    [addUserMessage]
  );

  /** 개입(interject): AI 턴이 진행 중일 때 사용자 메시지를 밀어넣는다.
   *  prepareSend와 달리 스트리밍 누적 ref를 건드리지 않는다 — 라이브 버블 앞
   *  삽입은 addUserMessage가 처리한다. 서버는 send 시점에 user를 history에 쓰고
   *  assistant는 턴 종료에 쓰므로 이 순서가 재로드 후 순서와도 일치한다. */
  const prepareInterject = useCallback((text: string) => {
    addUserMessage(text, text.startsWith("OOC:"));
    setError(null);
  }, [addUserMessage]);

  /** Send via REST (legacy fallback, used by builder). 개입은 WS 경로
   *  (prepareInterject + sendChat)만 쓴다 — 여기서는 새 턴 시작만 다룬다. */
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
        setError(err instanceof Error ? err.message : "Failed to send");
        rawAssistantTextRef.current = "";
        displayAssistantTextRef.current = "";
        carryAssistantTextRef.current = "";
        assistantFullTextRef.current = null;
        toolsRef.current = [];
        seenToolKeysRef.current.clear();
        sawTextDeltaRef.current = false;
        setIsStreaming(false);
      }
    },
    [prepareSend, sessionId]
  );

  /** Handle cancellation: finalize partial text and reset streaming state */
  const handleCancelled = useCallback(() => {
    flushAssistantText();
    // 서버는 cancel 뒤 result를 보내지 않으므로(finishAssistantTurn 미경유) 여기서
    // live를 지워야 한다. 남겨두면 취소된 버블이 스트리밍 표시로 고정되고, 다음
    // 전송의 addUserMessage가 그 버블을 진행 중으로 오인해 앞에 끼워 넣은 뒤
    // 새 턴의 delta가 취소된 부분 텍스트를 덮어쓴다.
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.live) {
        return [...prev.slice(0, -1), { ...last, live: undefined }];
      }
      return prev;
    });
    rawAssistantTextRef.current = "";
    displayAssistantTextRef.current = "";
    carryAssistantTextRef.current = "";
    assistantFullTextRef.current = null;
    toolsRef.current = [];
    seenToolKeysRef.current.clear();
    sawTextDeltaRef.current = false;
    turnSplitRef.current = false;
    currentBlockTypeRef.current = "text";
    pushedTextsByMsgIdRef.current.clear();
    oocRef.current = false;
    setIsStreaming(false);
    setStatus("connected");
  }, [flushAssistantText]);

  const addOpeningMessage = useCallback((text: string) => {
    const id = `opening-${++msgIdRef.current}`;
    setMessages((prev) => [...prev, { id, renderKey: id, role: "assistant", content: text }]);
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
    turnSplitRef.current = false;
    currentBlockTypeRef.current = "text";
    pushedTextsByMsgIdRef.current.clear();
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

  /** Handle tool:answered — fill tools[].answer for the matching toolUseId */
  const handleToolAnswered = useCallback(
    (data: { toolUseId: string; answer: ToolAnswer }) => {
      setMessages((prev) => {
        let mutated = false;
        const next = prev.map((m) => {
          if (m.role !== "assistant" || !m.tools) return m;
          const idx = m.tools.findIndex((t) => t.id === data.toolUseId);
          if (idx < 0) return m;
          mutated = true;
          const newTools = [...m.tools];
          newTools[idx] = { ...newTools[idx], answer: data.answer };
          return { ...m, tools: newTools };
        });
        return mutated ? next : prev;
      });
    },
    []
  );

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
    prepareInterject,
    sendMessage,
    handleClaudeMessage,
    handleToolAnswered,
    handleCancelled,
    assignMessageId,
    assignSplitMessageId,
    addUserMessage,
    addOpeningMessage,
    clearMessages,
    loadHistory,
    loadMore,
    toggleMessageOOC,
  };
}
