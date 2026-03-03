"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSSE } from "@/hooks/useSSE";
import { useChat } from "@/hooks/useChat";
import { useLayout, type LayoutConfig } from "@/hooks/useLayout";
import StatusBar from "@/components/StatusBar";
import ErrorBanner from "@/components/ErrorBanner";
import ChatMessages from "@/components/ChatMessages";
import ChatInput from "@/components/ChatInput";
import PanelArea from "@/components/PanelArea";

interface Panel {
  name: string;
  html: string;
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const {
    messages,
    isStreaming,
    status,
    error,
    setStatus,
    setError,
    sendMessage,
    handleClaudeMessage,
    addOpeningMessage,
    clearMessages,
  } = useChat();
  const { applyLayout, resetLayout } = useLayout();

  const [panels, setPanels] = useState<Panel[]>([]);
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [title, setTitle] = useState("");
  const initRef = useRef(false);

  // SSE handlers
  useSSE({
    "claude:message": handleClaudeMessage,
    "claude:error": (e) => setError(e as string),
    "claude:status": (s) => setStatus(s as string),
    "panels:update": (p) => setPanels(p as Panel[]),
  });

  // Open session on mount — ref prevents Strict Mode double-call
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const openSession = async () => {
      clearMessages();
      resetLayout();

      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/open`,
        { method: "POST" }
      );

      if (!res.ok) {
        setError("Failed to open session");
        return;
      }

      const data = await res.json();
      setTitle(data.title || data.persona);
      setLayout(data.layout);
      applyLayout(data.layout);
      setStatus("connected");

      if (!data.isResume && data.opening) {
        addOpeningMessage(data.opening);
      }
    };

    openSession();
  }, [sessionId, clearMessages, resetLayout, applyLayout, setError, setStatus, addOpeningMessage]);

  const handleBack = useCallback(() => {
    resetLayout();
    router.push("/");
  }, [router, resetLayout]);

  const panelPosition = layout?.panels?.position || "right";
  const panelSize = layout?.panels?.size || 280;

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={title}
        status={status}
        isBuilderMode={false}
        onBack={handleBack}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div
        className={`flex-1 flex min-h-0 ${
          panelPosition === "left"
            ? "flex-row-reverse"
            : panelPosition === "bottom"
              ? "flex-col"
              : "flex-row"
        }`}
      >
        <ChatMessages
          messages={messages}
          isStreaming={isStreaming}
          maxWidth={layout?.chat?.maxWidth}
          align={layout?.chat?.align}
        />
        <PanelArea
          panels={panels}
          position={panelPosition}
          size={panelSize}
        />
      </div>
      <ChatInput disabled={isStreaming} onSend={sendMessage} />
    </div>
  );
}
