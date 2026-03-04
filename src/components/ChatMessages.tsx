"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ChatMessage } from "@/hooks/useChat";
import ToolBlock from "./ToolBlock";
import ThinkingIndicator from "./ThinkingIndicator";
import InlineImage from "./InlineImage";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  maxWidth?: number | null;
  align?: "stretch" | "center";
  hideTools?: boolean;
  sessionId?: string;
  hasMore?: boolean;
  onLoadMore?: () => Promise<number>;
}

const OPEN_TAG = "<dialog_response>";
const CLOSE_TAG = "</dialog_response>";

/**
 * Extract content inside <dialog_response> tags.
 * Handles multiple blocks and unclosed tags (mid-stream).
 */
function extractDialogResponse(raw: string): string {
  const parts: string[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = raw.indexOf(OPEN_TAG, searchFrom);
    if (openIdx === -1) break;

    const contentStart = openIdx + OPEN_TAG.length;
    const closeIdx = raw.indexOf(CLOSE_TAG, contentStart);

    if (closeIdx !== -1) {
      parts.push(raw.substring(contentStart, closeIdx).trim());
      searchFrom = closeIdx + CLOSE_TAG.length;
    } else {
      // Unclosed tag — still streaming
      parts.push(raw.substring(contentStart).trim());
      break;
    }
  }

  // No tags found — return original text (opening messages, backward compat)
  return parts.length > 0 ? parts.join("\n\n") : raw;
}

function renderInline(text: string, keyPrefix: string, sessionId?: string): React.ReactNode[] {
  const regex = /(\$IMAGE:[^$]+\$|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-${lastIndex}`}>
          {text.slice(lastIndex, match.index)}
        </span>
      );
    }

    const m = match[0];
    if (m.startsWith("$IMAGE:") && m.endsWith("$") && sessionId) {
      const imgPath = m.slice(7, -1);
      nodes.push(
        <InlineImage
          key={`${keyPrefix}-img-${match.index}`}
          sessionId={sessionId}
          path={imgPath}
        />
      );
    } else if (m.startsWith("**") && m.endsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-${match.index}`} className="font-semibold">
          {m.slice(2, -2)}
        </strong>
      );
    } else if (m.startsWith("`") && m.endsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}-${match.index}`}
          className="bg-code-bg px-1 py-0.5 rounded text-[13px] font-mono"
        >
          {m.slice(1, -1)}
        </code>
      );
    } else {
      // *action/narration*
      nodes.push(
        <em
          key={`${keyPrefix}-${match.index}`}
          className="italic text-[#e8a862]"
        >
          {m.slice(1, -1)}
        </em>
      );
    }

    lastIndex = match.index + m.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-${lastIndex}`}>
        {text.slice(lastIndex)}
      </span>
    );
  }

  return nodes;
}

function renderMarkdown(text: string, sessionId?: string): React.ReactNode[] {
  const parts = text.split(/(```[\s\S]*?```)/g);
  const nodes: React.ReactNode[] = [];

  parts.forEach((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3);
      const nl = inner.indexOf("\n");
      const code = nl >= 0 ? inner.slice(nl + 1) : inner;
      nodes.push(
        <pre
          key={i}
          className="bg-code-bg p-2.5 rounded-lg overflow-x-auto my-1.5 text-[13px]"
        >
          <code className="font-mono text-[13px]">{code}</code>
        </pre>
      );
    } else {
      nodes.push(...renderInline(part, `${i}`, sessionId));
    }
  });

  return nodes;
}

function StreamingDots() {
  return (
    <span className="inline-flex items-center gap-0.5 ml-1 align-middle">
      {[0, 0.2, 0.4].map((delay, i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-text-dim animate-[thinking-bounce_1.4s_infinite_ease-in-out_both]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

export default function ChatMessages({
  messages,
  isStreaming,
  maxWidth,
  align,
  hideTools,
  sessionId,
  hasMore,
  onLoadMore,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const isLoadingMore = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const shouldAutoScroll = useRef(true);
  const initialScrollDone = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Auto-scroll to bottom when new messages arrive (not when loading older)
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      // Mark initial scroll as done after first render with messages
      if (messages.length > 0) {
        requestAnimationFrame(() => { initialScrollDone.current = true; });
      }
    }
  }, [messages, isStreaming]);

  // Restore scroll position after prepending older messages
  useEffect(() => {
    if (isLoadingMore.current && scrollRef.current) {
      const newScrollHeight = scrollRef.current.scrollHeight;
      scrollRef.current.scrollTop = newScrollHeight - prevScrollHeightRef.current;
      isLoadingMore.current = false;
    }
  }, [messages]);

  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || !hasMore || !onLoadMore || isLoadingMore.current) return;
    // Don't trigger until initial scroll-to-bottom is done
    if (!initialScrollDone.current) return;

    // Near top — trigger load
    if (el.scrollTop < 80) {
      isLoadingMore.current = true;
      shouldAutoScroll.current = false;
      prevScrollHeightRef.current = el.scrollHeight;
      setLoadingMore(true);
      await onLoadMore();
      setLoadingMore(false);
      requestAnimationFrame(() => { shouldAutoScroll.current = true; });
    }
  }, [hasMore, onLoadMore]);

  const style: React.CSSProperties = {};
  if (maxWidth) style.maxWidth = `${maxWidth}px`;
  if (align === "center") {
    style.marginLeft = "auto";
    style.marginRight = "auto";
  }

  const lastIdx = messages.length - 1;

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
      style={style}
      onScroll={handleScroll}
    >
      {loadingMore && (
        <div className="flex justify-center py-2">
          <span className="text-xs text-text-dim animate-pulse">Loading older messages...</span>
        </div>
      )}
      {messages.map((msg, idx) => {
        const isLastAssistant =
          isStreaming && idx === lastIdx && msg.role === "assistant";

        // In RP mode (hideTools), extract only <dialog_response> content
        const displayContent =
          hideTools && msg.role === "assistant"
            ? extractDialogResponse(msg.content)
            : msg.content;

        // Skip empty assistant messages in RP mode (e.g. tool-only turns)
        if (hideTools && msg.role === "assistant" && !displayContent) {
          return null;
        }

        return (
          <div
            key={msg.id}
            className={`max-w-[85%] px-4 py-3 rounded-2xl leading-relaxed whitespace-pre-wrap break-words animate-[messageIn_0.25s_ease-out] ${
              msg.role === "user"
                ? "self-end bg-user-bubble backdrop-blur-[12px] rounded-br-[4px] shadow-sm"
                : "self-start bg-assistant-bubble backdrop-blur-[12px] rounded-bl-[4px] shadow-sm"
            }`}
          >
            {renderMarkdown(displayContent, sessionId)}
            {isLastAssistant && <StreamingDots />}
            {!hideTools &&
              msg.tools?.map((tool, i) => (
                <ToolBlock key={i} name={tool.name} input={tool.input} />
              ))}
          </div>
        );
      })}
      {isStreaming && messages[lastIdx]?.role !== "assistant" && (
        <ThinkingIndicator />
      )}
      <div ref={bottomRef} />
    </main>
  );
}
