"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSSE } from "@/hooks/useSSE";
import { useChat } from "@/hooks/useChat";
import StatusBar from "@/components/StatusBar";
import ErrorBanner from "@/components/ErrorBanner";
import ChatMessages from "@/components/ChatMessages";
import ChatInput from "@/components/ChatInput";
import BuilderOverview from "@/components/BuilderOverview";

export default function BuilderPage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") || "edit";

  const {
    messages,
    isStreaming,
    status,
    error,
    setStatus,
    setError,
    sendMessage,
    handleClaudeMessage,
    loadHistory,
    loadMore,
    hasMore,
  } = useChat();

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [sseEnabled, setSseEnabled] = useState(false);
  const initRef = useRef(false);

  // SSE handlers — only connect after init completes
  useSSE({
    "claude:message": (data) => {
      handleClaudeMessage(data);
      const msg = data as Record<string, unknown>;
      if (msg.type === "result") {
        setRefreshTrigger((n) => n + 1);
      }
    },
    "claude:error": (e) => setError(e as string),
    "claude:status": (s) => setStatus(s as string),
    "panels:update": () => {},
  }, sseEnabled);

  // Initialize builder on mount (spawn Claude) — ref prevents Strict Mode double-call
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      const endpoint =
        mode === "new" ? "/api/builder/start" : "/api/builder/edit";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: decodedName }),
      });

      if (!res.ok) {
        setError("Failed to start builder");
        return;
      }

      // Load previous chat history from server (file-backed)
      await loadHistory();

      setStatus("connected");

      // Now enable SSE for real-time updates
      setSseEnabled(true);
    };

    init();
  }, [mode, decodedName, setError, setStatus]);

  const handleBack = useCallback(() => {
    router.push("/");
  }, [router]);

  // Re-initialize builder (kill + respawn Claude with fresh builder prompt)
  const handleReinit = useCallback(async () => {
    const endpoint =
      mode === "new" ? "/api/builder/start" : "/api/builder/edit";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: decodedName }),
    });
    if (res.ok) {
      setStatus("connected");
      setRefreshTrigger((n) => n + 1);
    } else {
      setError("Failed to reinitialize builder");
    }
  }, [mode, decodedName, setStatus, setError]);

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={`${mode === "new" ? "Building" : "Editing"}: ${decodedName}`}
        status={status}
        isBuilderMode={true}
        onBack={handleBack}
        onReinit={handleReinit}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex-1 flex min-h-0">
        <BuilderOverview
          personaName={decodedName}
          refreshTrigger={refreshTrigger}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <ChatMessages
            messages={messages}
            isStreaming={isStreaming}
            hasMore={hasMore}
            onLoadMore={loadMore}
          />
          <ChatInput disabled={isStreaming} onSend={sendMessage} />
        </div>
      </div>
    </div>
  );
}
