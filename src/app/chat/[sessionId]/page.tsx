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
    loadHistory,
    loadMore,
    hasMore,
  } = useChat();
  const { applyLayout, resetLayout } = useLayout();

  const [panels, setPanels] = useState<Panel[]>([]);
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [title, setTitle] = useState("");
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [sseEnabled, setSseEnabled] = useState(false);
  const initRef = useRef(false);

  // SSE handlers — only connect after session open completes
  useSSE({
    "claude:message": handleClaudeMessage,
    "claude:error": (e) => setError(e as string),
    "claude:status": (s) => setStatus(s as string),
    "panels:update": (p) => setPanels(p as Panel[]),
  }, sseEnabled);

  // Open session on mount — ref prevents Strict Mode double-call
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const openSession = async () => {
      clearMessages();
      resetLayout();

      const res = await fetch(
        `/api/sessions/${sessionId}/open`,
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

      // Set initial panels from response (SSE may not be connected yet)
      if (data.panels?.length) {
        setPanels(data.panels);
      }

      setProfileImage(data.profileImage ? `/api/sessions/${sessionId}/files?path=${data.profileImage}` : null);

      // Load chat history from server (file-backed, survives restarts)
      const historyCount = await loadHistory();

      if (historyCount === 0 && data.opening) {
        addOpeningMessage(data.opening);
      }

      // Now enable SSE for real-time updates
      setSseEnabled(true);
    };

    openSession();
  }, [sessionId, clearMessages, resetLayout, applyLayout, setError, setStatus, addOpeningMessage]);

  const handleBack = useCallback(() => {
    resetLayout();
    router.push("/");
  }, [router, resetLayout]);

  const panelPosition = layout?.panels?.position || "right";
  const panelSize = layout?.panels?.size || 280;
  const hasPanel = panels.length > 0 || !!profileImage;

  // Chat maxWidth: use layout value if explicitly > 0, otherwise always default 720px
  const layoutMaxWidth = layout?.chat?.maxWidth;
  const chatMaxWidth = (layoutMaxWidth && layoutMaxWidth > 0) ? layoutMaxWidth : 860;
  // Center align by default when maxWidth is active
  const layoutAlign = layout?.chat?.align;
  const chatAlign = (layoutAlign && layoutAlign !== "stretch") ? layoutAlign : "center";

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={title}
        status={status}
        isBuilderMode={false}
        onBack={handleBack}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex-1 relative min-h-0">
        {/* Chat column: always centered in full width */}
        <div
          className="absolute inset-0 flex flex-col min-h-0"
          style={{
            maxWidth: `${chatMaxWidth}px`,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          <ChatMessages
            messages={messages}
            isStreaming={isStreaming}
            hideTools
            sessionId={sessionId}
            hasMore={hasMore}
            onLoadMore={loadMore}
          />
          <ChatInput disabled={isStreaming} onSend={sendMessage} />
        </div>
        {/* Panel overlay on the side */}
        {hasPanel && (
          <div
            className={`absolute top-0 bottom-0 ${
              panelPosition === "left" ? "left-0" : "right-0"
            } ${panelPosition === "bottom" ? "left-0 right-0 bottom-0 top-auto" : ""}`}
            style={panelPosition === "bottom" ? { height: `${panelSize}px` } : { width: `${panelSize}px` }}
          >
            <PanelArea
              panels={panels}
              position={panelPosition}
              size={panelSize}
              profileImageUrl={profileImage}
            />
          </div>
        )}
      </div>
    </div>
  );
}
