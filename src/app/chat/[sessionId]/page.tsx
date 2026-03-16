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
import ChatOptionsModal from "@/components/ChatOptionsModal";
import PopupEffect from "@/components/PopupEffect";

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
  } = useChat(sessionId);
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
  const [autoPlay, setAutoPlay] = useState(true);
  useEffect(() => {
    const stored = localStorage.getItem("tts-autoplay");
    if (stored === "false") setAutoPlay(false);
  }, []);
  // Chunked audio: per-message arrays of chunk URLs
  const [audioMap, setAudioMap] = useState<Record<string, string[]>>({});
  const [audioStatus, setAudioStatus] = useState<Record<string, { generating: boolean; totalChunks: number; readyCount: number }>>({});
  const audioStatusRef = useRef<Record<string, { generating: boolean; totalChunks: number; readyCount: number }>>({});
  const audioQueueRef = useRef<{
    messageId: string; nextChunk: number; playing: boolean; audioPlaying: boolean; totalChunks: number; currentAudio: HTMLAudioElement | null;
    // Playback queue: list of pending messages to play after current finishes
    pendingMessages: Array<{ messageId: string; totalChunks: number }>;
  }>({ messageId: "", nextChunk: 0, playing: false, audioPlaying: false, totalChunks: 0, currentAudio: null, pendingMessages: [] });
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [voiceChat, setVoiceChat] = useState(false);
  const [pendingEvents, setPendingEvents] = useState<string[]>([]);
  const [chatOptions, setChatOptions] = useState<Record<string, unknown>>({});
  const [chatOptionsSchema, setChatOptionsSchema] = useState<Record<string, unknown>[]>([]);
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [popupQueue, setPopupQueue] = useState<Array<{ template: string; html: string; duration: number }>>([]);
  const isMobile = useIsMobile();
  const initRef = useRef(false);

  /**
   * Audio playback system.
   *
   * playQueue: ordered list of messageIds to play. First entry is "now playing".
   * playNext(): try to play the next chunk of the current message.
   *   - If chunk URL exists → play it, on end call playNext again.
   *   - If chunk URL is null and still generating → do nothing (audio:ready will call tryResume).
   *   - If chunk URL is null and done generating → skip to next non-null.
   *   - If current message has no more chunks → shift queue, start next message.
   *   - If queue empty → stop.
   * tryResume(): called from audio:ready, nudges playNext if it was waiting.
   * enqueueMessage(): adds a message to the play queue.
   */
  const playQueueRef = useRef<string[]>([]);
  const playStateRef = useRef<Record<string, { nextChunk: number; totalChunks: number }>>({});

  const tryResume = useCallback(() => {
    const queue = playQueueRef.current;
    const q = audioQueueRef.current;
    if (queue.length === 0 || q.audioPlaying) return;
    // Trigger playNext for current message
    const currentMsgId = queue[0];
    if (!currentMsgId) return;
    const state = playStateRef.current[currentMsgId];
    if (!state) return;
    playNextRef.current?.();
  }, []);

  // Use a ref to hold playNext so tryResume can call it without circular deps
  const playNextRef = useRef<(() => void) | null>(null);

  const startMessage = useCallback((messageId: string) => {
    const q = audioQueueRef.current;
    q.messageId = messageId;
    q.audioPlaying = false;
    q.currentAudio = null;
    q.playing = true;
    setTtsPlaying(true);

    function playNext() {
      const qq = audioQueueRef.current;
      const pq = playQueueRef.current;
      if (pq[0] !== messageId || qq.audioPlaying) return;

      const state = playStateRef.current[messageId];
      if (!state) { advanceQueue(); return; }

      setAudioMap((current) => {
        const urls = current[messageId];
        if (!urls || state.nextChunk >= urls.length) {
          if (state.totalChunks > 0 && state.nextChunk >= state.totalChunks) {
            setTimeout(advanceQueue, 250);
          } else if (!audioStatusRef.current[messageId]) {
            // Not generating, no more URLs — done
            setTimeout(advanceQueue, 250);
          }
          // else: still generating, urls array might grow — wait for audio:ready
          return current;
        }
        if (!urls[state.nextChunk]) {
          const isGenerating = !!audioStatusRef.current[messageId];
          if (isGenerating) {
            // Wait for audio:ready → tryResume
            return current;
          }
          // Skip null (failed) chunks
          const nextValid = urls.findIndex((u, i) => i > state.nextChunk && u != null);
          if (nextValid === -1) {
            setTimeout(advanceQueue, 250);
            return current;
          }
          state.nextChunk = nextValid;
          setTimeout(playNext, 50);
          return current;
        }
        const url = urls[state.nextChunk];
        state.nextChunk++;
        qq.audioPlaying = true;
        const audio = new Audio(url);
        qq.currentAudio = audio;
        const onDone = () => {
          qq.audioPlaying = false;
          qq.currentAudio = null;
          setTimeout(playNext, 250);
        };
        audio.onended = onDone;
        audio.onerror = onDone;
        audio.play().catch(() => { qq.audioPlaying = false; qq.currentAudio = null; });
        return current;
      });
    }

    playNextRef.current = playNext;
    playNext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advanceQueue = useCallback(() => {
    const pq = playQueueRef.current;
    const finished = pq.shift();
    if (finished) delete playStateRef.current[finished];
    if (pq.length > 0) {
      startMessage(pq[0]);
    } else {
      const q = audioQueueRef.current;
      q.playing = false;
      q.messageId = "";
      q.audioPlaying = false;
      setTtsPlaying(false);
      playNextRef.current = null;
    }
  }, [startMessage]);

  const enqueueMessage = useCallback((messageId: string, totalChunks: number) => {
    const pq = playQueueRef.current;
    if (pq.includes(messageId)) return; // already queued
    pq.push(messageId);
    playStateRef.current[messageId] = { nextChunk: 0, totalChunks };
    if (pq.length === 1) {
      // Nothing was playing — start immediately
      startMessage(messageId);
    }
  }, [startMessage]);

  /** Public API: queue or replay a message */
  const playChunkSequence = useCallback((messageId: string, startChunk: number, totalChunks?: number) => {
    const pq = playQueueRef.current;
    if (pq.includes(messageId)) {
      // Already queued or playing — update state if replay
      const state = playStateRef.current[messageId];
      if (state && pq[0] === messageId) {
        // Currently playing this message — restart from startChunk
        state.nextChunk = startChunk;
        if (totalChunks !== undefined) state.totalChunks = totalChunks;
        tryResume();
      }
      return;
    }
    playStateRef.current[messageId] = { nextChunk: startChunk, totalChunks: totalChunks || 0 };
    pq.push(messageId);
    if (pq.length === 1) {
      startMessage(messageId);
    }
  }, [startMessage, tryResume]);

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

  // Manual reconnect — kill and respawn CLI process (e.g. after prompt changes)
  const handleReinit = useCallback(async () => {
    setStatus("reconnecting");
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
    } else {
      setError("Reconnect failed");
    }
  }, [sessionId, currentModel, setStatus, setError]);

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
        const update = p as {
          panels: Panel[];
          context: Record<string, unknown>;
          sharedPlacements?: Record<string, "modal" | "dock" | "dock-left" | "dock-right" | "dock-bottom">;
          popups?: Array<{ template: string; html: string; duration: number }>;
        };
        setPanels(update.panels);
        setPanelData(update.context);
        if (update.sharedPlacements) setSharedPlacements(update.sharedPlacements);
        // Only update popup queue when explicitly present in update
        if (update.popups !== undefined) {
          setPopupQueue(update.popups.length > 0 ? update.popups : []);
        }
      },
      "layout:update": (p) => {
        const update = p as { layout: LayoutConfig };
        if (update.layout) {
          setLayout(update.layout);
          const imageBase = `/api/sessions/${sessionId}/files/images/`;
          applyLayout(update.layout, imageBase);
        }
      },
      "image:updated": (d) => {
        const { filename } = d as { filename: string };
        if (filename) {
          import("@/lib/panel-image-polling").then(({ bustImageCache }) => bustImageCache(filename));
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
          let next;
          if (readyCount >= totalChunks) {
            next = { ...prev };
            delete next[messageId];
          } else {
            next = { ...prev, [messageId]: { ...current, readyCount } };
          }
          audioStatusRef.current = next;
          return next;
        });
        // Auto-play: enqueue or resume
        if (localStorage.getItem("tts-autoplay") !== "false") {
          // Update totalChunks in play state if already queued
          const state = playStateRef.current[messageId];
          if (state && totalChunks) state.totalChunks = totalChunks;
          // Nudge playback in case it was waiting for this chunk
          tryResume();
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
            audioStatusRef.current = next;
            return next;
          });
          // Nudge playback — if waiting for this message's chunks, it can now skip/advance
          tryResume();
        } else {
          // Generation started — register in audioStatus and enqueue for auto-play
          setAudioStatus((prev) => {
            const next = {
              ...prev,
              [messageId]: { generating: true, totalChunks, readyCount: prev[messageId]?.readyCount || 0 },
            };
            audioStatusRef.current = next;
            return next;
          });
          if (localStorage.getItem("tts-autoplay") !== "false") {
            enqueueMessage(messageId, totalChunks);
          }
        }
      },
      "event:pending": (d) => {
        const { headers } = d as { headers: string[] };
        setPendingEvents(headers || []);
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
      if (!text.startsWith("OOC:")) setPopupQueue([]); // Clear popups immediately
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
      if (data.popups && data.popups.length > 0) {
        setPopupQueue(data.popups);
      }

      setProfileImage(data.profileImage ? `/api/sessions/${sessionId}/files/${data.profileImage}` : null);

      // Sync autoPlay with session voice config
      const voiceOn = data.voiceEnabled ?? false;
      setAutoPlay(voiceOn);
      localStorage.setItem("tts-autoplay", String(voiceOn));

      // Load chat options
      if (data.chatOptions) {
        setChatOptions(data.chatOptions);
      }
      // Load options schema
      try {
        const schemaRes = await fetch("/api/chat-options/schema");
        if (schemaRes.ok) setChatOptionsSchema(await schemaRes.json());
      } catch { /* ignore */ }

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

  const handleOptionsApply = useCallback(async (values: Record<string, unknown>) => {
    setOptionsModalOpen(false);
    const res = await fetch(`/api/sessions/${sessionId}/options/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (res.ok) {
      const data = await res.json();
      setChatOptions(values);
      if (data.restarted) {
        setStatus("connected");
      }
    }
  }, [sessionId, setStatus]);

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

  const showProfile = profileImage && layout?.panels?.showProfileImage !== false;
  const hasLeftSidebar = sidebarLeftPanels.length > 0 || !!showProfile;
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

  const themeColor = layout?.theme?.accent;

  // Expose streaming state to panels via global flag + custom event
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__bridgeIsStreaming = isStreaming;
    window.dispatchEvent(new CustomEvent("__bridge_streaming_change", { detail: isStreaming }));
  }, [isStreaming]);

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
        onReinit={handleReinit}
        showPanelButton={hasSidebar && isMobile}
        onPanelToggle={() => setDrawerOpen((v) => !v)}
        model={currentModel}
        provider={currentProvider}
        onModelChange={handleModelChange}
        onSync={() => setSyncModalOpen(true)}
        autoPlay={autoPlay}
        onAutoPlayToggle={handleAutoPlayToggle}
        voiceChat={voiceChat}
        onVoiceChatToggle={() => setVoiceChat((v) => !v)}
        onSettings={() => setOptionsModalOpen(true)}
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
              // Clear any partial/failed audio for this message before regenerating
              setAudioMap((prev) => {
                const next = { ...prev };
                delete next[messageId];
                return next;
              });
              fetch("/api/chat/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messageId, text, sessionId }),
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
            pendingEvents={pendingEvents}
            voiceChat={voiceChat}
            ttsPlaying={ttsPlaying}
            autoSendDelay={typeof chatOptions.autoSendDelay === "number" ? chatOptions.autoSendDelay : undefined}
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
              profileImageUrl={showProfile ? profileImage : null}
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
          profileImageUrl={showProfile ? profileImage : null}
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
      {popupQueue.length > 0 && (
        <PopupEffect
          popups={popupQueue}
          themeColor={themeColor}
        />
      )}
      <SyncModal
        open={syncModalOpen}
        sessionId={sessionId}
        onClose={() => setSyncModalOpen(false)}
        onSynced={() => {
          // Notify Claude about the sync via OOC message
          sendMessage("OOC: 대화 세션이 원본 페르소나 데이터에 동기화 되었습니다. 변경사항을 확인하세요.");
        }}
      />
      {optionsModalOpen && chatOptionsSchema.length > 0 && (
        <ChatOptionsModal
          schema={chatOptionsSchema as unknown as Parameters<typeof ChatOptionsModal>[0]["schema"]}
          values={chatOptions}
          onApply={handleOptionsApply}
          onClose={() => setOptionsModalOpen(false)}
        />
      )}
    </div>
  );
}
