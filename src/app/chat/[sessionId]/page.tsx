"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useChat } from "@/hooks/useChat";
import { useLayout, type LayoutConfig } from "@/hooks/useLayout";
import { useIsMobile } from "@/hooks/useIsMobile";
import StatusBar from "@/components/StatusBar";
import ErrorBanner from "@/components/ErrorBanner";
import ChatMessages from "@/components/ChatMessages";
import ChatInput from "@/components/ChatInput";
import { extractChoices } from "@/components/ChatMessages";
import PanelArea from "@/components/PanelArea";
import PanelDrawer from "@/components/PanelDrawer";
import ModalPanel from "@/components/ModalPanel";
import SyncModal from "@/components/SyncModal";
import ProfileCropModal from "@/components/ProfileCropModal";

interface Panel {
  name: string;
  html: string;
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    messages,
    isStreaming,
    status,
    error,
    setStatus,
    setError,
    prepareSend,
    handleClaudeMessage,
    addOpeningMessage,
    clearMessages,
    loadHistory,
    loadMore,
    hasMore,
    toggleMessageOOC,
  } = useChat();
  const { applyLayout, resetLayout } = useLayout();

  const [panels, setPanels] = useState<Panel[]>([]);
  const [panelData, setPanelData] = useState<Record<string, unknown>>({});
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [title, setTitle] = useState("");
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [wsEnabled, setWsEnabled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentModel, setCurrentModel] = useState(searchParams.get("model") || "");
  const [currentProvider, setCurrentProvider] = useState<"claude" | "codex">("claude");
  const [showOOC, setShowOOC] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropInitialImage, setCropInitialImage] = useState<string | undefined>();
  const isMobile = useIsMobile();
  const initRef = useRef(false);

  // WebSocket connection — only connect after session open completes
  const { sendChat, send: wsSend } = useWebSocket({
    sessionId,
    handlers: {
      "claude:message": handleClaudeMessage,
      "claude:error": (e) => setError(e as string),
      "claude:status": (s) => setStatus(s as string),
      "panels:update": (p) => {
        const update = p as { panels: Panel[]; context: Record<string, unknown> };
        setPanels(update.panels);
        setPanelData(update.context);
      },
      "layout:update": (p) => {
        const update = p as { layout: LayoutConfig };
        if (update.layout) {
          setLayout(update.layout);
          const imageBase = `/api/sessions/${sessionId}/files?path=images/`;
          applyLayout(update.layout, imageBase);
        }
      },
      "profile:update": (p) => {
        const update = p as { profile?: string; timestamp?: number };
        if (update.profile) {
          const t = update.timestamp || Date.now();
          setProfileImage(`/api/sessions/${sessionId}/files?path=${update.profile}&t=${t}`);
        }
      },
      "profile:crop-request": (p) => {
        const data = p as { sourceImage?: string };
        setCropInitialImage(data.sourceImage);
        setCropModalOpen(true);
      },
    },
    enabled: wsEnabled,
  });

  // Send via WebSocket: update local UI state + send through WS
  const sendMessage = useCallback(
    (text: string) => {
      if (text.startsWith("OOC:")) setShowOOC(true);
      prepareSend(text);
      sendChat(text);
    },
    [prepareSend, sendChat]
  );

  // Open session on mount — ref prevents Strict Mode double-call
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const openSession = async () => {
      clearMessages();
      resetLayout();

      const res = await fetch(
        `/api/sessions/${sessionId}/open`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: currentModel || undefined }),
        }
      );

      if (!res.ok) {
        setError("Failed to open session");
        return;
      }

      const data = await res.json();
      setTitle(data.title || data.persona);
      setLayout(data.layout);
      if (data.model) setCurrentModel(data.model);
      if (data.provider) setCurrentProvider(data.provider);
      const imageBase = `/api/sessions/${sessionId}/files?path=images/`;
      applyLayout(data.layout, imageBase);
      setStatus("connected");

      // Set initial panels + context from response (WS may not be connected yet)
      if (data.panels?.length) {
        setPanels(data.panels);
      }
      if (data.panelContext) {
        setPanelData(data.panelContext);
      }

      setProfileImage(data.profileImage ? `/api/sessions/${sessionId}/files?path=${data.profileImage}` : null);

      // Load chat history from server (file-backed, survives restarts)
      const historyCount = await loadHistory();

      if (historyCount === 0 && data.opening) {
        addOpeningMessage(data.opening);
      }

      // Now enable WebSocket for real-time updates
      setWsEnabled(true);
    };

    openSession();
  }, [sessionId, clearMessages, resetLayout, applyLayout, setError, setStatus, addOpeningMessage]);

  const handleBack = useCallback(() => {
    wsSend("session:leave");
    resetLayout();
    router.push("/");
  }, [router, resetLayout, wsSend]);

  const handleModelChange = useCallback(async (model: string) => {
    setCurrentModel(model);
    setStatus("disconnected");
    const res = await fetch(
      `/api/sessions/${sessionId}/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || undefined }),
      }
    );
    if (res.ok) {
      setStatus("connected");
    } else {
      setError("Failed to reconnect with new model");
    }
  }, [sessionId, setStatus, setError]);

  const panelPosition = layout?.panels?.position || "right";
  const panelSize = layout?.panels?.size || 280;
  const rawPlacement = layout?.panels?.placement || {};

  const modalSize = layout?.panels?.modalSize || {};

  // Normalize placement keys: strip numeric prefix (e.g. "01-상태" → "상태") so it matches panel names
  const placement: Record<string, "left" | "right" | "modal"> = {};
  for (const [key, val] of Object.entries(rawPlacement)) {
    const normalized = key.replace(/^\d+-/, "");
    placement[normalized] = val;
    if (normalized !== key) placement[key] = val; // keep original too
  }

  // Split panels by placement: left, right, modal, or inline (no placement = inline)
  const leftPanels = panels.filter((p) => placement[p.name] === "left");
  const rightPanels = panels.filter((p) => placement[p.name] === "right");
  const modalPanels = panels.filter((p) => placement[p.name] === "modal");
  const inlinePanels = panels.filter((p) => !placement[p.name]);

  // Fallback: if no per-panel placement configured, use legacy position for all panels
  const hasPerPanelPlacement = Object.keys(rawPlacement).length > 0;
  const sidebarLeftPanels = hasPerPanelPlacement ? leftPanels : (panelPosition === "left" ? panels : []);
  const sidebarRightPanels = hasPerPanelPlacement ? rightPanels : (panelPosition === "right" ? panels : []);

  const hasLeftSidebar = sidebarLeftPanels.length > 0 || !!profileImage;
  const hasRightSidebar = sidebarRightPanels.length > 0;
  const hasSidebar = hasLeftSidebar || hasRightSidebar;

  // Chat maxWidth: use layout value if explicitly > 0, otherwise always default 720px
  const layoutMaxWidth = layout?.chat?.maxWidth;
  const chatMaxWidth = (layoutMaxWidth && layoutMaxWidth > 0) ? layoutMaxWidth : 860;
  // Center align by default when maxWidth is active
  const layoutAlign = layout?.chat?.align;
  const chatAlign = (layoutAlign && layoutAlign !== "stretch") ? layoutAlign : "center";

  const showInlinePanel = hasSidebar && !isMobile;

  // Determine which modal panels are currently active (driven by __modals in variables.json)
  // __modals values: true = required (no dismiss), "dismissible" = user can close freely
  const modalsState = (panelData as Record<string, unknown>)?.__modals as Record<string, boolean | string> | undefined;
  const activeModalPanels = modalPanels.filter((p) => !!modalsState?.[p.name]);

  // Filter OOC messages unless toggle is on
  const visibleMessages = showOOC ? messages : messages.filter((m) => !m.ooc);

  // Listen for panel bridge sendMessage events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text === "string" && text.trim()) {
        sendMessage(text);
      }
    };
    window.addEventListener("__panel_send_message", handler);
    return () => window.removeEventListener("__panel_send_message", handler);
  }, [sendMessage]);

  return (
    <div className="flex flex-col h-screen">
      <StatusBar
        title={title}
        status={status}
        isBuilderMode={false}
        onBack={handleBack}
        showPanelButton={hasSidebar && isMobile}
        onPanelToggle={() => setDrawerOpen((v) => !v)}
        model={currentModel}
        provider={currentProvider}
        onModelChange={handleModelChange}
        onSync={() => setSyncModalOpen(true)}
      />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <div className="flex-1 relative min-h-0">
        {/* Chat column */}
        <div
          className="absolute inset-0 flex flex-col min-h-0"
          style={{
            ...(showInlinePanel && hasLeftSidebar ? { left: `${panelSize}px` } : {}),
            ...(showInlinePanel && hasRightSidebar ? { right: `${panelSize}px` } : {}),
          }}
        >
          <ChatMessages
            messages={visibleMessages}
            isStreaming={isStreaming}
            hideTools
            sessionId={sessionId}
            panels={hasPerPanelPlacement ? inlinePanels : panels}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onToggleOOC={toggleMessageOOC}
          />
          <ChatInput
            disabled={isStreaming}
            onSend={sendMessage}
            showOOC={showOOC}
            onOOCToggle={(on) => setShowOOC(on)}
            choices={(() => {
              if (isStreaming) return undefined;
              // Only extract choices from the very last assistant message
              for (let i = visibleMessages.length - 1; i >= 0; i--) {
                const m = visibleMessages[i];
                if (m.role === "assistant" && !m.ooc) {
                  const c = extractChoices(m.content);
                  return c.length > 0 ? c : undefined;
                }
                // If we hit any user message first, no choices to show
                if (m.role === "user") return undefined;
              }
              return undefined;
            })()}
          />
        </div>
        {/* Desktop: left sidebar (profile + left panels) */}
        {showInlinePanel && hasLeftSidebar && (
          <div
            className="absolute top-0 bottom-0 left-0"
            style={{ width: `${panelSize}px` }}
          >
            <PanelArea
              panels={sidebarLeftPanels}
              position="left"
              size={panelSize}
              profileImageUrl={profileImage}
              sessionId={sessionId}
              panelData={panelData}
              onSendMessage={sendMessage}
            />
          </div>
        )}
        {/* Desktop: right sidebar */}
        {showInlinePanel && hasRightSidebar && (
          <div
            className="absolute top-0 bottom-0 right-0"
            style={{ width: `${panelSize}px` }}
          >
            <PanelArea
              panels={sidebarRightPanels}
              position="right"
              size={panelSize}
              sessionId={sessionId}
              panelData={panelData}
              onSendMessage={sendMessage}
            />
          </div>
        )}
      </div>
      {/* Mobile: slide-over drawer (shows all sidebar panels) */}
      {hasSidebar && isMobile && (
        <PanelDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          panels={hasPerPanelPlacement ? [...sidebarLeftPanels, ...sidebarRightPanels] : panels}
          panelPosition="right"
          panelSize={panelSize}
          profileImageUrl={profileImage}
          sessionId={sessionId}
          panelData={panelData}
          onSendMessage={sendMessage}
        />
      )}
      {/* Modal panels — centered overlay, driven by __modals in variables.json */}
      {activeModalPanels.map((p, i) => (
        <ModalPanel
          key={p.name}
          name={p.name}
          html={p.html}
          dismissible={modalsState?.[p.name] === "dismissible"}
          zIndex={i}
          isTopmost={i === activeModalPanels.length - 1}
          maxWidth={modalSize[p.name]?.maxWidth}
          maxHeight={modalSize[p.name]?.maxHeight}
          sessionId={sessionId}
          panelData={panelData}
          onClose={() => {
            // Update __modals to close this panel
            fetch(`/api/sessions/${sessionId}/variables`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ __modals: { ...modalsState, [p.name]: false } }),
            });
          }}
          onSendMessage={sendMessage}
        />
      ))}
      <SyncModal
        open={syncModalOpen}
        sessionId={sessionId}
        onClose={() => setSyncModalOpen(false)}
        onSynced={() => {
          // Notify Claude about the sync via OOC message
          sendMessage("OOC: 대화 세션이 원본 페르소나 데이터에 동기화 되었습니다. 변경사항을 확인하세요.");
        }}
      />
      {cropModalOpen && (
        <ProfileCropModal
          sessionId={sessionId}
          initialImage={cropInitialImage}
          onClose={() => setCropModalOpen(false)}
        />
      )}
    </div>
  );
}
