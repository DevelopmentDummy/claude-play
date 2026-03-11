"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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
import DockPanel from "@/components/DockPanel";
import SyncModal from "@/components/SyncModal";

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
    assignMessageId,
    addUserMessage,
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
  const [sharedPlacements, setSharedPlacements] = useState<Record<string, "modal" | "dock" | "dock-left" | "dock-right" | "dock-bottom">>({});
  const [layout, setLayout] = useState<LayoutConfig | null>(null);
  const [title, setTitle] = useState("");
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [wsEnabled, setWsEnabled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentModel, setCurrentModel] = useState(searchParams.get("model") || "");
  const [currentProvider, setCurrentProvider] = useState<"claude" | "codex">("claude");
  const [showOOC, setShowOOC] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [autoPlay, setAutoPlay] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("tts-autoplay") !== "false";
    }
    return true;
  });
  // Chunked audio: per-message arrays of chunk URLs
  const [audioMap, setAudioMap] = useState<Record<string, string[]>>({});
  const [audioStatus, setAudioStatus] = useState<Record<string, { generating: boolean; totalChunks: number; readyCount: number }>>({});
  const audioQueueRef = useRef<{ messageId: string; nextChunk: number; playing: boolean; audioPlaying: boolean }>({ messageId: "", nextChunk: 0, playing: false, audioPlaying: false });
  const isMobile = useIsMobile();
  const initRef = useRef(false);

  /** Play chunks sequentially for a message, starting from a given index */
  const playChunkSequence = useCallback((messageId: string, startChunk: number) => {
    const queue = audioQueueRef.current;
    queue.messageId = messageId;
    queue.nextChunk = startChunk;
    queue.playing = true;

    function playNext() {
      const q = audioQueueRef.current;
      if (q.messageId !== messageId || !q.playing || q.audioPlaying) return;

      // Read latest audioMap from DOM closure workaround
      setAudioMap((current) => {
        const urls = current[messageId];
        if (!urls || q.nextChunk >= urls.length || !urls[q.nextChunk]) {
          // Chunk not ready yet — will be resumed when audio:ready arrives
          return current;
        }
        const url = urls[q.nextChunk];
        q.nextChunk++;
        q.audioPlaying = true;
        const audio = new Audio(url);
        audio.onended = () => {
          q.audioPlaying = false;
          setTimeout(playNext, 250);
        };
        audio.onerror = () => {
          q.audioPlaying = false;
          setTimeout(playNext, 250);
        };
        audio.play().catch(() => { q.audioPlaying = false; });
        return current;
      });
    }

    playNext();
  }, []);

  const handleAutoPlayToggle = useCallback(() => {
    setAutoPlay((prev) => {
      const next = !prev;
      localStorage.setItem("tts-autoplay", String(next));
      fetch(`/api/sessions/${sessionId}/voice`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      return next;
    });
  }, [sessionId]);

  // Auto re-open session when server restarts and WS reconnects
  const handleSessionLost = useCallback(async () => {
    setStatus("disconnected");
    const res = await fetch(
      `/api/sessions/${sessionId}/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: currentModel || undefined }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.model) setCurrentModel(data.model);
      if (data.provider) setCurrentProvider(data.provider);
      setStatus("connected");
    }
  }, [sessionId, currentModel, setStatus]);

  // WebSocket connection — only connect after session open completes
  const { sendChat, send: wsSend } = useWebSocket({
    sessionId,
    handlers: {
      "chat:user": (d) => {
        const { text, isOOC } = d as { text: string; isOOC?: boolean };
        addUserMessage(text, isOOC);
      },
      "claude:message": handleClaudeMessage,
      "claude:messageId": (d) => {
        const { messageId } = d as { messageId: string };
        if (messageId) assignMessageId(messageId);
      },
      "claude:error": (e) => setError(e as string),
      "claude:status": (s) => setStatus(s as string),
      "panels:update": (p) => {
        const update = p as { panels: Panel[]; context: Record<string, unknown>; sharedPlacements?: Record<string, "modal" | "dock" | "dock-left" | "dock-right" | "dock-bottom"> };
        setPanels(update.panels);
        setPanelData(update.context);
        if (update.sharedPlacements) setSharedPlacements(update.sharedPlacements);
      },
      "layout:update": (p) => {
        const update = p as { layout: LayoutConfig };
        if (update.layout) {
          setLayout(update.layout);
          const imageBase = `/api/sessions/${sessionId}/files/images/`;
          applyLayout(update.layout, imageBase);
        }
      },
      "audio:ready": (d) => {
        const { url, messageId, chunkIndex = 0, totalChunks = 1 } = d as {
          url: string; messageId: string; chunkIndex?: number; totalChunks?: number;
        };
        // Store chunk URL in the array
        setAudioMap((prev) => {
          const arr = prev[messageId] ? [...prev[messageId]] : new Array(totalChunks).fill(null);
          arr[chunkIndex] = url;
          return { ...prev, [messageId]: arr };
        });
        // Update status: increment ready count, clear generating when all done
        setAudioStatus((prev) => {
          const current = prev[messageId] || { generating: true, totalChunks, readyCount: 0 };
          const readyCount = current.readyCount + 1;
          if (readyCount >= totalChunks) {
            const next = { ...prev };
            delete next[messageId];
            return next;
          }
          return { ...prev, [messageId]: { ...current, readyCount } };
        });
        // Auto-play: start sequential playback from first chunk
        if (localStorage.getItem("tts-autoplay") !== "false") {
          const queue = audioQueueRef.current;
          if (queue.messageId !== messageId || !queue.playing) {
            // Start playback from chunk 0 on the first ready chunk
            if (chunkIndex === 0) {
              playChunkSequence(messageId, 0);
            }
          } else if (!queue.audioPlaying && queue.nextChunk === chunkIndex) {
            // Was waiting for this chunk and nothing is currently playing — resume
            playChunkSequence(messageId, chunkIndex);
          }
        }
      },
      "audio:status": (d) => {
        const { status, messageId, totalChunks = 1 } = d as {
          status: string; messageId: string; totalChunks?: number;
        };
        if (status === "error") {
          setAudioStatus((prev) => {
            const next = { ...prev };
            delete next[messageId];
            return next;
          });
        } else {
          setAudioStatus((prev) => ({
            ...prev,
            [messageId]: { generating: true, totalChunks, readyCount: prev[messageId]?.readyCount || 0 },
          }));
        }
      },
      "profile:update": (p) => {
        const update = p as { profile?: string; timestamp?: number };
        if (update.profile) {
          const t = update.timestamp || Date.now();
          setProfileImage(`/api/sessions/${sessionId}/files/${update.profile}?t=${t}`);
        }
      },
    },
    enabled: wsEnabled,
    onSessionLost: handleSessionLost,
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

  const handleOOCToggle = useCallback((on: boolean) => setShowOOC(on), []);

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
      setTitle(data.displayName || data.title || data.persona);
      setLayout(data.layout);
      if (data.model) setCurrentModel(data.model);
      if (data.provider) setCurrentProvider(data.provider);
      const imageBase = `/api/sessions/${sessionId}/files/images/`;
      applyLayout(data.layout, imageBase);
      setStatus("connected");

      // Set initial panels + context from response (WS may not be connected yet)
      if (data.panels?.length) {
        setPanels(data.panels);
      }
      if (data.panelContext) {
        setPanelData(data.panelContext);
      }
      if (data.sharedPlacements) {
        setSharedPlacements(data.sharedPlacements);
      }

      setProfileImage(data.profileImage ? `/api/sessions/${sessionId}/files/${data.profileImage}` : null);

      // Sync autoPlay with session voice config
      const voiceOn = data.voiceEnabled ?? false;
      setAutoPlay(voiceOn);
      localStorage.setItem("tts-autoplay", String(voiceOn));

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
  const dockMaxHeight = layout?.panels?.dockHeight || layout?.panels?.dockSize;
  const dockWidth = layout?.panels?.dockWidth;
  const rawPlacement = layout?.panels?.placement || {};

  const modalSize = layout?.panels?.modalSize || {};

  // Normalize placement keys: strip numeric prefix (e.g. "01-상태" → "상태") so it matches panel names
  // Merge layout placements with shared panel default placements (shared panels default to modal)
  const placement: Record<string, "left" | "right" | "modal" | "dock" | "dock-left" | "dock-right" | "dock-bottom"> = {};
  // Apply shared placements first (lower priority)
  for (const [key, val] of Object.entries(sharedPlacements)) {
    placement[key] = val;
  }
  // Layout placements override shared defaults
  for (const [key, val] of Object.entries(rawPlacement)) {
    const normalized = key.replace(/^\d+-/, "");
    placement[normalized] = val;
    if (normalized !== key) placement[key] = val; // keep original too
  }

  // Split panels by placement: left, right, modal, or inline (no placement = inline)
  const leftPanels = panels.filter((p) => placement[p.name] === "left");
  const rightPanels = panels.filter((p) => placement[p.name] === "right");
  const modalPanels = panels.filter((p) => placement[p.name] === "modal");
  const dockBottomPanels = panels.filter((p) => placement[p.name] === "dock" || placement[p.name] === "dock-bottom");
  const dockLeftPanels = panels.filter((p) => placement[p.name] === "dock-left");
  const dockRightPanels = panels.filter((p) => placement[p.name] === "dock-right");
  const inlinePanels = panels.filter((p) => !placement[p.name]);

  // Fallback: if no per-panel placement configured, use legacy position for all panels
  // But always respect shared placements (global tool panels like profile-crop)
  const hasPerPanelPlacement = Object.keys(rawPlacement).length > 0;
  const panelsWithoutSharedPlacement = panels.filter((p) => !sharedPlacements[p.name]);
  const sidebarLeftPanels = hasPerPanelPlacement ? leftPanels : (panelPosition === "left" ? panelsWithoutSharedPlacement : []);
  const sidebarRightPanels = hasPerPanelPlacement ? rightPanels : (panelPosition === "right" ? panelsWithoutSharedPlacement : []);

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
  // On mobile, dock panels are promoted to modals for better usability
  const effectiveModalPanels = isMobile
    ? [...modalPanels, ...dockBottomPanels, ...dockLeftPanels, ...dockRightPanels]
    : modalPanels;
  const activeModalPanels = effectiveModalPanels.filter((p) => !!modalsState?.[p.name]);
  const toDockEntries = (arr: Panel[]) =>
    arr
      .filter((p) => !!modalsState?.[p.name])
      .map((p) => ({
        name: p.name,
        html: p.html,
        dismissible: modalsState?.[p.name] === "dismissible",
      }));
  const activeDockBottom = isMobile ? [] : toDockEntries(dockBottomPanels);
  const activeDockLeft = isMobile ? [] : toDockEntries(dockLeftPanels);
  const activeDockRight = isMobile ? [] : toDockEntries(dockRightPanels);

  const handleDockClose = useCallback((name: string) => {
    fetch(`/api/sessions/${sessionId}/variables`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ __modals: { ...modalsState, [name]: false } }),
    });
  }, [sessionId, modalsState]);

  // Filter OOC messages unless toggle is on
  const visibleMessages = showOOC ? messages : messages.filter((m) => !m.ooc);

  // choices를 useMemo로 캐싱하여 ChatInput 불필요한 리렌더 방지
  const currentChoices = useMemo(() => {
    if (isStreaming) return undefined;
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i];
      if (m.role === "assistant" && !m.ooc) {
        const c = extractChoices(m.content);
        return c.length > 0 ? c : undefined;
      }
      if (m.role === "user") return undefined;
    }
    return undefined;
  }, [isStreaming, visibleMessages]);

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
        autoPlay={autoPlay}
        onAutoPlayToggle={handleAutoPlayToggle}
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
            panels={inlinePanels}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onToggleOOC={toggleMessageOOC}
            dockLeft={activeDockLeft.length > 0 ? activeDockLeft : undefined}
            dockRight={activeDockRight.length > 0 ? activeDockRight : undefined}
            dockMaxSize={dockMaxHeight}
            dockWidth={dockWidth}
            panelData={panelData}
            onDockClose={handleDockClose}
            audioMap={audioMap}
            audioStatus={audioStatus}
            onRequestTts={(messageId, text) => {
              fetch("/api/chat/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messageId, text }),
              }).catch(() => {});
            }}
            onPlayAudio={(messageId) => {
              playChunkSequence(messageId, 0);
            }}
          />
          {activeDockBottom.length > 0 && (
            <DockPanel
              panels={activeDockBottom}
              direction="bottom"
              maxSize={dockMaxHeight}
              sessionId={sessionId}
              panelData={panelData}
              onClose={handleDockClose}
            />
          )}
          <ChatInput
            disabled={isStreaming}
            onSend={sendMessage}
            showOOC={showOOC}
            onOOCToggle={handleOOCToggle}
            choices={currentChoices}
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
          panels={[...sidebarLeftPanels, ...sidebarRightPanels]}
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
    </div>
  );
}
