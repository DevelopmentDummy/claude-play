"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWebSocket } from "@/hooks/useWebSocket";
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
    prepareSend,
    handleClaudeMessage,
    clearMessages,
    loadHistory,
    loadMore,
    hasMore,
  } = useChat();

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [wsEnabled, setWsEnabled] = useState(false);
  const [builderService, setBuilderService] = useState<"claude" | "codex">("claude");
  const [displayName, setDisplayName] = useState(decodedName);
  const initRef = useRef(false);

  // WebSocket connection — only connect after init completes
  const { sendChat, send: wsSend } = useWebSocket({
    isBuilder: true,
    handlers: {
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
    },
    enabled: wsEnabled,
  });

  const sendMessage = useCallback(
    (text: string) => {
      prepareSend(text);
      sendChat(text);
    },
    [prepareSend, sendChat]
  );

  // Initialize builder on mount — ref prevents Strict Mode double-call
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

      const data = await res.json();
      if (data.provider) setBuilderService(data.provider);
      if (data.displayName) setDisplayName(data.displayName);

      await loadHistory();
      setStatus("connected");
      setWsEnabled(true);
    };

    init();
  }, [mode, decodedName, setError, setStatus]);

  const handleBack = useCallback(() => {
    wsSend("session:leave");
    router.push("/");
  }, [router, wsSend]);

  // Re-initialize builder (kill + respawn with same service)
  const handleReinit = useCallback(async () => {
    const endpoint =
      mode === "new" ? "/api/builder/start" : "/api/builder/edit";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: decodedName, model: builderService === "codex" ? "gpt-5.4" : undefined }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.displayName) setDisplayName(data.displayName);
      setStatus("connected");
      setRefreshTrigger((n) => n + 1);
    } else {
      setError("Failed to reinitialize builder");
    }
  }, [mode, decodedName, builderService, setStatus, setError]);

  // Service switch: fresh session with cleared history
  const handleServiceChange = useCallback(async (newService: "claude" | "codex") => {
    setBuilderService(newService);
    setStatus("disconnected");

    // Pick a default model for the provider
    const model = newService === "codex" ? "gpt-5.4" : undefined;

    const res = await fetch("/api/builder/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: decodedName, model, service: newService }),
    });
    if (res.ok) {
      clearMessages();
      await loadHistory();
      setStatus("connected");
      setRefreshTrigger((n) => n + 1);
    } else {
      setError("Failed to switch service");
    }
  }, [decodedName, setStatus, setError, clearMessages, loadHistory]);

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={`${mode === "new" ? "Building" : "Editing"}: ${displayName}`}
        status={status}
        isBuilderMode={true}
        onBack={handleBack}
        onReinit={handleReinit}
        service={builderService}
        onServiceChange={handleServiceChange}
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
