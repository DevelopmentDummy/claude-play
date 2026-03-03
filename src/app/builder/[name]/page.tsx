"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
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
  const {
    messages,
    isStreaming,
    status,
    error,
    setStatus,
    setError,
    sendMessage,
    handleClaudeMessage,
  } = useChat();

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // SSE handlers — refresh overview on result
  useSSE({
    "claude:message": (data) => {
      handleClaudeMessage(data);
      // Refresh overview when Claude finishes a turn
      const msg = data as Record<string, unknown>;
      if (msg.type === "result") {
        setRefreshTrigger((n) => n + 1);
      }
    },
    "claude:error": (e) => setError(e as string),
    "claude:status": (s) => setStatus(s as string),
    "panels:update": () => {},
  });

  const handleBack = useCallback(async () => {
    if (confirm("Cancel persona creation? The incomplete persona will be deleted.")) {
      await fetch("/api/builder/cancel", { method: "POST" });
      router.push("/");
    }
  }, [router]);

  const handleFinish = useCallback(async () => {
    await fetch("/api/builder/finish", { method: "POST" });
    router.push("/");
  }, [router]);

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={`Building: ${decodedName}`}
        status={status}
        isBuilderMode={true}
        onBack={handleBack}
        onFinish={handleFinish}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex-1 flex min-h-0">
        <BuilderOverview
          personaName={decodedName}
          refreshTrigger={refreshTrigger}
        />
        <ChatMessages messages={messages} isStreaming={isStreaming} />
      </div>
      <ChatInput disabled={isStreaming} onSend={sendMessage} />
    </div>
  );
}
