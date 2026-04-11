"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useChat } from "@/hooks/useChat";
import { useIsMobile } from "@/hooks/useIsMobile";
import StatusBar from "@/components/StatusBar";
import ErrorBanner from "@/components/ErrorBanner";
import ChatMessages from "@/components/ChatMessages";
import ChatInput from "@/components/ChatInput";
import BuilderOverview from "@/components/BuilderOverview";
import VersionHistoryModal from "@/components/VersionHistoryModal";
import ChatOptionsModal from "@/components/ChatOptionsModal";
import ToastEffect from "@/components/ToastEffect";
import UsageModal from "@/components/UsageModal";
import { providerFromModel } from "@/lib/ai-provider";

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
    addOpeningMessage,
  } = useChat(decodedName);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [wsEnabled, setWsEnabled] = useState(false);
  const [builderModel, setBuilderModel] = useState("opus[1m]:medium");
  const [displayName, setDisplayName] = useState(decodedName);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voiceChat, setVoiceChat] = useState(false);
  const [versionSaving, setVersionSaving] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [chatOptions, setChatOptions] = useState<Record<string, unknown>>({});
  const [chatOptionsSchema, setChatOptionsSchema] = useState<Record<string, unknown>[]>([]);
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [usageTrigger, setUsageTrigger] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setUsageTrigger((n) => n + 1);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);
  const isMobile = useIsMobile();
  const initRef = useRef(false);
  const initialMsgSent = useRef(false);

  // WebSocket connection — only connect after init completes
  const { sendChat, send: wsSend } = useWebSocket({
    sessionId: name,
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
      "command:result": (d) => {
        const { text } = d as { text: string };
        if (text) {
          import("@/components/ToastEffect").then(({ showToast }) => showToast(text, 6000));
        }
      },
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
      const initModel = searchParams.get("model") || undefined;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: decodedName, ...(initModel ? { model: initModel } : {}) }),
      });

      if (!res.ok) {
        setError("Failed to start builder");
        return;
      }

      const data = await res.json();
      if (data.model) setBuilderModel(data.model);
      else if (data.provider) setBuilderModel(data.provider === "codex" ? "gpt-5.4:medium" : data.provider === "gemini" ? "gemini-auto" : "opus[1m]:medium");
      if (data.displayName) setDisplayName(data.displayName);

      // Load chat options schema + persona defaults
      try {
        const schemaRes = await fetch("/api/chat-options/schema");
        if (schemaRes.ok) setChatOptionsSchema(await schemaRes.json());
      } catch { /* ignore */ }
      try {
        const optRes = await fetch(`/api/personas/${encodeURIComponent(decodedName)}/file?file=chat-options.json`);
        if (optRes.ok) {
          const { content } = await optRes.json();
          if (content) setChatOptions(JSON.parse(content));
        }
      } catch { /* ignore */ }

      const historyCount = await loadHistory();

      // Show opening message for new builder sessions
      if (historyCount === 0 && data.opening) {
        addOpeningMessage(data.opening);
      }

      setStatus("connected");
      setWsEnabled(true);
    };

    init();
  }, [mode, decodedName, setError, setStatus, addOpeningMessage]);

  // Auto-send initialMessage query param (e.g. from persona sharing flow)
  useEffect(() => {
    const msg = searchParams.get("initialMessage");
    if (msg && !initialMsgSent.current && wsEnabled && !isStreaming) {
      initialMsgSent.current = true;
      setTimeout(() => sendMessage(decodeURIComponent(msg)), 500);
    }
  }, [searchParams, wsEnabled, isStreaming, sendMessage]);

  const handleCompact = useCallback(() => {
    wsSend("command:send", { command: "compact" });
  }, [wsSend]);

  const handleContext = useCallback(() => {
    wsSend("command:send", { command: "context" });
  }, [wsSend]);

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
      body: JSON.stringify({ name: decodedName, model: builderModel }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.displayName) setDisplayName(data.displayName);
      setStatus("connected");
      setRefreshTrigger((n) => n + 1);
    } else {
      setError("Failed to reinitialize builder");
    }
  }, [mode, decodedName, builderModel, setStatus, setError]);

  // Model switch: clear history only if provider changes
  const handleBuilderModelChange = useCallback(async (newModel: string) => {
    const oldProvider = providerFromModel(builderModel);
    const newProvider = providerFromModel(newModel);
    const providerChanged = oldProvider !== newProvider;

    setBuilderModel(newModel);
    setStatus("disconnected");

    const res = await fetch("/api/builder/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: decodedName, model: newModel, ...(providerChanged ? { service: newProvider } : {}) }),
    });
    if (res.ok) {
      if (providerChanged) clearMessages();
      await loadHistory();
      setStatus("connected");
      setRefreshTrigger((n) => n + 1);
    } else {
      setError("Failed to switch model");
    }
  }, [decodedName, builderModel, setStatus, setError, clearMessages, loadHistory]);

  const handleOptionsApply = useCallback(async (values: Record<string, unknown>) => {
    setOptionsModalOpen(false);
    try {
      await fetch(`/api/personas/${encodeURIComponent(decodedName)}/file?file=chat-options.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: values }),
      });
      setChatOptions(values);
    } catch { /* ignore */ }
  }, [decodedName]);

  const handleVersionSave = useCallback(async () => {
    if (versionSaving) return;
    setVersionSaving(true);
    try {
      const res = await fetch(
        `/api/personas/${encodeURIComponent(decodedName)}/versions`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
      );
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Version save failed");
      }
    } catch {
      setError("Version save failed");
    }
    setVersionSaving(false);
  }, [decodedName, versionSaving, setError]);

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={`${mode === "new" ? "Building" : "Editing"}: ${displayName}`}
        status={status}
        isBuilderMode={true}
        onBack={handleBack}
        onReinit={handleReinit}
        onCompact={providerFromModel(builderModel) === "claude" ? handleCompact : undefined}
        onContext={providerFromModel(builderModel) === "claude" ? handleContext : undefined}
        builderModel={builderModel}
        onBuilderModelChange={handleBuilderModelChange}
        showPanelButton={isMobile}
        onPanelToggle={() => setDrawerOpen((v) => !v)}
        voiceChat={voiceChat}
        onVoiceChatToggle={() => setVoiceChat((v) => !v)}
        onVersionSave={handleVersionSave}
        onVersionHistory={() => setShowVersionHistory(true)}
        versionSaving={versionSaving}
        onSettings={() => setOptionsModalOpen(true)}
        onUsage={() => setShowUsage(true)}
        usageRefreshTrigger={usageTrigger}
        sessionId={name}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex-1 flex min-h-0">
        {!isMobile && (
          <BuilderOverview
            personaName={decodedName}
            refreshTrigger={refreshTrigger}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatMessages
            messages={messages}
            isStreaming={isStreaming}
            hasMore={hasMore}
            onLoadMore={loadMore}
            personaName={decodedName}
          />
          <ChatInput
            disabled={isStreaming}
            onSend={sendMessage}
            voiceChat={voiceChat}
            usageProvider={providerFromModel(builderModel)}
            usageSessionId={name}
            usageRefreshTrigger={usageTrigger}
            onUsageClick={() => setShowUsage(true)}
          />
        </div>
      </div>
      {/* Mobile: slide-over drawer for BuilderOverview */}
      {isMobile && (
        <BuilderDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          personaName={decodedName}
          refreshTrigger={refreshTrigger}
        />
      )}
      {showVersionHistory && (
        <VersionHistoryModal
          personaName={decodedName}
          onClose={() => setShowVersionHistory(false)}
          onRestored={() => setRefreshTrigger((n) => n + 1)}
        />
      )}
      {optionsModalOpen && chatOptionsSchema.length > 0 && (
        <ChatOptionsModal
          schema={chatOptionsSchema as unknown as Parameters<typeof ChatOptionsModal>[0]["schema"]}
          values={chatOptions}
          onApply={handleOptionsApply}
          onClose={() => setOptionsModalOpen(false)}
        />
      )}
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} provider={providerFromModel(builderModel)} sessionId={name} />}
      <ToastEffect />
    </div>
  );
}

/** Slide-over drawer wrapping BuilderOverview for mobile */
function BuilderDrawer({
  open,
  onClose,
  personaName,
  refreshTrigger,
}: {
  open: boolean;
  onClose: () => void;
  personaName: string;
  refreshTrigger: number;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          backgroundColor: "rgba(0,0,0,0.5)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
        onClick={onClose}
      />
      <div
        className="fixed top-0 left-0 bottom-0 z-50 transition-transform duration-300 ease-out"
        style={{
          width: "min(380px, 85vw)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
        }}
      >
        <div className="h-full flex flex-col bg-surface border-r border-border">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <span className="text-xs font-semibold text-accent/80 uppercase tracking-wider">
              Persona Overview
            </span>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-surface-light transition-colors duration-150 text-sm cursor-pointer"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <BuilderOverview
              personaName={personaName}
              refreshTrigger={refreshTrigger}
              embedded
            />
          </div>
        </div>
      </div>
    </>
  );
}
