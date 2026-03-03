"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/hooks/useChat";
import ToolBlock from "./ToolBlock";
import ThinkingIndicator from "./ThinkingIndicator";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  maxWidth?: number | null;
  align?: "stretch" | "center";
  hideTools?: boolean;
}

function renderMarkdown(text: string): React.ReactNode[] {
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
      const inlineParts = part.split(/(`[^`]+`)/g);
      inlineParts.forEach((ip, j) => {
        if (ip.startsWith("`") && ip.endsWith("`")) {
          nodes.push(
            <code
              key={`${i}-${j}`}
              className="bg-code-bg px-1 py-0.5 rounded text-[13px] font-mono"
            >
              {ip.slice(1, -1)}
            </code>
          );
        } else {
          nodes.push(<span key={`${i}-${j}`}>{ip}</span>);
        }
      });
    }
  });

  return nodes;
}

export default function ChatMessages({
  messages,
  isStreaming,
  maxWidth,
  align,
  hideTools,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  const style: React.CSSProperties = {};
  if (maxWidth) style.maxWidth = `${maxWidth}px`;
  if (align === "center") {
    style.marginLeft = "auto";
    style.marginRight = "auto";
  }

  return (
    <main
      className="flex-1 overflow-y-auto p-4 flex flex-col gap-3"
      style={style}
    >
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`max-w-[85%] px-4 py-3 rounded-2xl leading-relaxed whitespace-pre-wrap break-words animate-[messageIn_0.25s_ease-out] ${
            msg.role === "user"
              ? "self-end bg-user-bubble backdrop-blur-[12px] rounded-br-[4px] shadow-sm"
              : "self-start bg-assistant-bubble backdrop-blur-[12px] rounded-bl-[4px] shadow-sm"
          }`}
        >
          {renderMarkdown(msg.content)}
          {!hideTools && msg.tools?.map((tool, i) => (
            <ToolBlock key={i} name={tool.name} input={tool.input} />
          ))}
        </div>
      ))}
      {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
        <ThinkingIndicator />
      )}
      <div ref={bottomRef} />
    </main>
  );
}
