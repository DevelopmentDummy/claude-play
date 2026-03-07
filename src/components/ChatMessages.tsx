"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ChatMessage } from "@/hooks/useChat";
import ToolBlock from "./ToolBlock";
import ThinkingIndicator from "./ThinkingIndicator";
import InlineImage from "./InlineImage";
import InlinePanel from "./InlinePanel";

interface PanelInfo {
  name: string;
  html: string;
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  maxWidth?: number | null;
  align?: "stretch" | "center";
  hideTools?: boolean;
  sessionId?: string;
  panels?: PanelInfo[];
  hasMore?: boolean;
  onLoadMore?: () => Promise<number>;
}

const OPEN_TAG = "<dialog_response>";
const CLOSE_TAG = "</dialog_response>";
const CHOICE_OPEN = "<choice>";
const CHOICE_CLOSE = "</choice>";
const SPECIAL_TOKEN_REGEX = /\$(?:IMAGE|PANEL):[^$]+\$/g;

export interface Choice {
  text: string;
  score: number;
}

/** Extract choices from <choice> tags in raw content */
export function extractChoices(raw: string): Choice[] {
  const openIdx = raw.lastIndexOf(CHOICE_OPEN);
  if (openIdx === -1) return [];
  const contentStart = openIdx + CHOICE_OPEN.length;
  const closeIdx = raw.indexOf(CHOICE_CLOSE, contentStart);
  if (closeIdx === -1) return [];
  const jsonStr = raw.substring(contentStart, closeIdx).trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((c: unknown) => c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string")
        .map((c: Record<string, unknown>) => ({
          text: c.text as string,
          score: typeof c.score === "number" ? c.score : 0,
        }));
    }
  } catch { /* invalid JSON */ }
  return [];
}

/** Strip <choice> tags from content for display */
function stripChoiceTags(text: string): string {
  return text.replace(/<choice>[\s\S]*?<\/choice>/g, "").trim();
}

function extractSpecialTokens(raw: string): string[] {
  const matches = raw.match(SPECIAL_TOKEN_REGEX) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of matches) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

/**
 * Extract content inside <dialog_response> tags.
 * Handles multiple blocks, unclosed tags (mid-stream),
 * and partial opening tags still being streamed.
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
      // Unclosed tag -- still streaming; strip any partial close tag at the end
      let tail = raw.substring(contentStart);
      for (let len = Math.min(CLOSE_TAG.length - 1, tail.length); len >= 1; len--) {
        if (tail.endsWith(CLOSE_TAG.substring(0, len))) {
          tail = tail.substring(0, tail.length - len);
          break;
        }
      }
      parts.push(tail.trim());
      break;
    }
  }

  if (parts.length > 0) {
    const base = parts.join("\n\n").trim();
    const tokens = extractSpecialTokens(raw).filter((token) => !base.includes(token));
    if (tokens.length === 0) return base;
    return `${base}\n\n${tokens.join("\n")}`;
  }

  // Check for a partial opening tag at the end of the string (tag still being streamed in).
  // If the tail of the string matches a prefix of OPEN_TAG, hide it and return
  // any previously completed content, or empty string to suppress raw tag display.
  for (let len = Math.min(OPEN_TAG.length - 1, raw.length); len >= 1; len--) {
    if (raw.endsWith(OPEN_TAG.substring(0, len))) {
      // Return text before the partial tag, or empty if nothing before it
      const before = raw.substring(0, raw.length - len).trim();
      return before || "";
    }
  }

  // No tags found -- return original text (opening messages, backward compat)
  return raw;
}

/**
 * Streaming-safe extraction for the live assistant turn.
 * Falls back to showing the tail after OPEN_TAG while text is still arriving.
 */
function extractDialogResponseLive(raw: string): string {
  const strict = extractDialogResponse(raw);
  if (strict) return strict;

  const openIdx = raw.indexOf(OPEN_TAG);
  if (openIdx === -1) return strict;

  const contentStart = openIdx + OPEN_TAG.length;
  let tail = raw.substring(contentStart);

  // Strip partially streamed closing tag suffix.
  for (let len = Math.min(CLOSE_TAG.length - 1, tail.length); len >= 1; len--) {
    if (tail.endsWith(CLOSE_TAG.substring(0, len))) {
      tail = tail.substring(0, tail.length - len);
      break;
    }
  }

  const tokens = extractSpecialTokens(raw).filter((token) => !tail.includes(token));
  if (tokens.length === 0) return tail;
  return tail ? `${tail}\n\n${tokens.join("\n")}` : tokens.join("\n");
}

function renderInline(
  text: string,
  keyPrefix: string,
  sessionId?: string,
  panels?: PanelInfo[],
  onMediaReady?: () => void
): React.ReactNode[] {
  const regex = /(\$PANEL:[^$]+\$|\$IMAGE:[^$]+\$|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\u2018[^\u2019]+\u2019|'[^']+['''])/g;
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
    if (m.startsWith("$PANEL:") && m.endsWith("$") && panels) {
      const panelName = m.slice(7, -1);
      const panel = panels.find((p) => p.name === panelName);
      if (panel) {
        nodes.push(
          <InlinePanel
            key={`${keyPrefix}-panel-${match.index}`}
            html={panel.html}
            sessionId={sessionId}
          />
        );
      }
    } else if (m.startsWith("$IMAGE:") && m.endsWith("$") && sessionId) {
      const imgPath = m.slice(7, -1);
      nodes.push(
        <InlineImage
          key={`${keyPrefix}-img-${match.index}`}
          sessionId={sessionId}
          path={imgPath}
          onReady={onMediaReady}
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
    } else if (m.startsWith("\u2018") || m.startsWith("\u2019") || m.startsWith("'")) {
      // 'thought/inner monologue'
      nodes.push(
        <span
          key={`${keyPrefix}-${match.index}`}
          className="text-[#7eb8e0] italic"
        >
          {m}
        </span>
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

function renderMarkdown(
  text: string,
  sessionId?: string,
  panels?: PanelInfo[],
  onMediaReady?: () => void
): React.ReactNode[] {
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
      nodes.push(...renderInline(part, `${i}`, sessionId, panels, onMediaReady));
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
  panels,
  hasMore,
  onLoadMore,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const isLoadingMore = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const shouldAutoScroll = useRef(true);
  const initialScrollDone = useRef(false);
  const programmaticScrollUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomThreshold = 120;

  const scrollToBottom = useCallback(() => {
    programmaticScrollUntilRef.current = Date.now() + 400;
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, []);

  // Auto-scroll to bottom when new messages arrive (not when loading older)
  useEffect(() => {
    if (shouldAutoScroll.current) {
      scrollToBottom();
      // Mark initial scroll as done after first render with messages
      if (messages.length > 0) {
        requestAnimationFrame(() => {
          initialScrollDone.current = true;
          const el = scrollRef.current;
          if (el) {
            lastScrollTopRef.current = el.scrollTop;
            lastScrollHeightRef.current = el.scrollHeight;
          }
        });
      }
    }
  }, [messages, isStreaming, scrollToBottom]);

  // Keep bottom stickiness when content height changes after render
  // (e.g. image finishes loading and expands the bubble).
  useEffect(() => {
    const target = contentRef.current;
    if (!target) return;

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!shouldAutoScroll.current) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        scrollToBottom();
      });
    });

    observer.observe(target);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollToBottom]);

  // Restore scroll position after prepending older messages
  useEffect(() => {
    if (isLoadingMore.current && scrollRef.current) {
      const newScrollHeight = scrollRef.current.scrollHeight;
      scrollRef.current.scrollTop = newScrollHeight - prevScrollHeightRef.current;
      lastScrollTopRef.current = scrollRef.current.scrollTop;
      lastScrollHeightRef.current = scrollRef.current.scrollHeight;
      isLoadingMore.current = false;
    }
  }, [messages]);

  const handleScroll = useCallback(async () => {
    const el = scrollRef.current;
    if (!el) return;

    // Only treat user-driven scrolling as a reason to disable bottom stickiness.
    // Ignore programmatic scrolls and pure content-height growth.
    if (!isLoadingMore.current) {
      const now = Date.now();
      const isProgrammatic = now < programmaticScrollUntilRef.current;
      const topChanged = Math.abs(el.scrollTop - lastScrollTopRef.current) > 1;
      const heightChanged = el.scrollHeight !== lastScrollHeightRef.current;
      const looksLikeContentGrowth = !topChanged && heightChanged;

      if (!isProgrammatic && !looksLikeContentGrowth) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        shouldAutoScroll.current = distanceFromBottom < bottomThreshold;
      }

      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
    }

    if (!hasMore || !onLoadMore || isLoadingMore.current) return;
    // Don't trigger until initial scroll-to-bottom is done
    if (!initialScrollDone.current) return;

    // Near top -- trigger load
    if (el.scrollTop < 80) {
      isLoadingMore.current = true;
      shouldAutoScroll.current = false;
      prevScrollHeightRef.current = el.scrollHeight;
      setLoadingMore(true);
      await onLoadMore();
      setLoadingMore(false);
      requestAnimationFrame(() => {
        const cur = scrollRef.current;
        if (!cur) return;
        const distanceFromBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight;
        shouldAutoScroll.current = distanceFromBottom < bottomThreshold;
        lastScrollTopRef.current = cur.scrollTop;
        lastScrollHeightRef.current = cur.scrollHeight;
      });
    }
  }, [hasMore, onLoadMore, bottomThreshold]);

  const style: React.CSSProperties = {};
  if (maxWidth) style.maxWidth = `${maxWidth}px`;
  if (align === "center") {
    style.marginLeft = "auto";
    style.marginRight = "auto";
  }

  const lastIdx = messages.length - 1;
  const handleMediaReady = useCallback(() => {
    if (!shouldAutoScroll.current) return;
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
      style={style}
      onScroll={handleScroll}
    >
      <div ref={contentRef} className="flex flex-col gap-3">
        {loadingMore && (
          <div className="flex justify-center py-2">
            <span className="text-xs text-text-dim animate-pulse">Loading older messages...</span>
          </div>
        )}
        {messages.map((msg, idx) => {
        const isLastAssistant =
          isStreaming && idx === lastIdx && msg.role === "assistant";

        // OOC messages: show raw content (no dialog_response extraction)
        // Normal RP messages: extract <dialog_response> content only, strip <choice> tags
        const rawDisplay =
          msg.ooc
            ? msg.content
            : hideTools && msg.role === "assistant"
              ? (isLastAssistant ? extractDialogResponseLive(msg.content) : extractDialogResponse(msg.content))
              : msg.content;
        const displayContent = stripChoiceTags(rawDisplay);

        // Skip empty assistant messages in RP mode (e.g. tool-only turns),
        // but keep the live streaming turn visible so users can see progress.
        if (hideTools && msg.role === "assistant" && !displayContent && !msg.ooc && !isLastAssistant) {
          return null;
        }

        const oocStyle = msg.ooc
          ? "border border-dashed border-yellow-500/40"
          : "";

        return (
          <div
            key={msg.id}
            className={`max-w-[85%] px-4 py-3 rounded-2xl leading-relaxed whitespace-pre-wrap break-words animate-[messageIn_0.25s_ease-out] ${oocStyle} ${
              msg.role === "user"
                ? "self-end bg-user-bubble backdrop-blur-[12px] rounded-br-[4px] shadow-sm"
                : "self-start bg-assistant-bubble backdrop-blur-[12px] rounded-bl-[4px] shadow-sm"
            }`}
          >
            {msg.ooc && (
              <div className="text-[10px] font-semibold text-yellow-500/70 uppercase tracking-wider mb-1">OOC</div>
            )}
            {renderMarkdown(displayContent, sessionId, panels, handleMediaReady)}
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
      </div>
    </main>
  );
}

