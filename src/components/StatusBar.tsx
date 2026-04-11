"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MODEL_GROUPS } from "@/lib/ai-provider";

interface StatusBarProps {
  title: string;
  status: string;
  isBuilderMode: boolean;
  onBack: () => void;
  onReinit?: () => void;
  onPanelToggle?: () => void;
  showPanelButton?: boolean;
  /** Chat mode: model within the locked provider */
  model?: string;
  provider?: "claude" | "codex" | "gemini";
  onModelChange?: (model: string) => void;
  /** Builder mode: model selector (full list) */
  builderModel?: string;
  onBuilderModelChange?: (model: string) => void;
  /** Persona sync */
  onSync?: () => void;
  /** TTS auto-play */
  autoPlay?: boolean;
  onAutoPlayToggle?: () => void;
  /** Voice chat mode */
  voiceChat?: boolean;
  onVoiceChatToggle?: () => void;
  /** Settings */
  onSettings?: () => void;
  /** Slash commands (compact, context) */
  onCompact?: () => void;
  onContext?: () => void;
  /** Version snapshot (builder mode) */
  onVersionSave?: () => void;
  onVersionHistory?: () => void;
  versionSaving?: boolean;
  /** Usage modal */
  onUsage?: () => void;
  /** Usage indicator refresh trigger (increment on each turn end) */
  usageRefreshTrigger?: number;
  /** Session ID for Codex usage */
  sessionId?: string;
  /** Force chat input visible */
  forceInput?: boolean;
  onForceInputToggle?: () => void;
}

const selectClass = `px-2 py-1 rounded-md text-xs text-text-dim bg-transparent border border-border/60 outline-none cursor-pointer appearance-none
  hover:border-border hover:text-text transition-all duration-fast
  focus:border-accent focus:shadow-[0_0_0_2px_var(--accent-glow)]`;

const selectStyle = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat" as const,
  backgroundPosition: "right 6px center",
  paddingRight: "20px",
};

const optClass = "bg-[#1a1a2e] text-[#ccc]";

const menuBtnClass = `w-full text-left px-3 py-1.5 text-xs text-text-dim hover:bg-surface-light hover:text-text
  transition-colors duration-fast disabled:opacity-30 disabled:cursor-default`;

export default function StatusBar({
  title,
  status,
  isBuilderMode,
  onBack,
  onReinit,
  onPanelToggle,
  showPanelButton,
  model,
  provider,
  onModelChange,
  builderModel,
  onBuilderModelChange,
  onSync,
  autoPlay,
  onAutoPlayToggle,
  voiceChat,
  onVoiceChatToggle,
  onSettings,
  onCompact,
  onContext,
  onVersionSave,
  onVersionHistory,
  versionSaving,
  onUsage,
  usageRefreshTrigger,
  sessionId,
  forceInput,
  onForceInputToggle,
}: StatusBarProps) {
  const [debugOpen, setDebugOpen] = useState(false);
  const debugBtnRef = useRef<HTMLButtonElement>(null);
  const debugMenuRef = useRef<HTMLDivElement>(null);
  const [debugPos, setDebugPos] = useState<{ x: number; y: number } | null>(null);

  // Position menu below button and close on outside click
  useEffect(() => {
    if (!debugOpen) return;
    if (debugBtnRef.current) {
      const rect = debugBtnRef.current.getBoundingClientRect();
      setDebugPos({ x: rect.right, y: rect.bottom + 4 });
    }
    const handler = (e: MouseEvent) => {
      if (
        debugBtnRef.current?.contains(e.target as Node) ||
        debugMenuRef.current?.contains(e.target as Node)
      ) return;
      setDebugOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [debugOpen]);

  const statusColors: Record<string, string> = {
    connected: "bg-success shadow-[0_0_8px_rgba(77,255,145,0.4)]",
    streaming: "bg-warning animate-pulse shadow-[0_0_8px_rgba(255,166,77,0.4)]",
    compacting: "bg-blue-400 animate-pulse shadow-[0_0_8px_rgba(96,165,250,0.4)]",
    disconnected: "bg-error shadow-[0_0_8px_rgba(255,77,106,0.4)]",
  };

  const statusLabels: Record<string, string> = {
    connected: "Connected",
    streaming: "Streaming...",
    compacting: "Compacting...",
    disconnected: "Disconnected",
  };

  const hasDebugItems = onUsage || onCompact || onContext || onReinit || (!isBuilderMode && onSync) || onForceInputToggle;

  return (
    <header className="flex flex-wrap items-center gap-2 px-4 py-2 bg-surface backdrop-blur-[16px] border-b border-border shrink-0">
      <button
        onClick={onBack}
        className="px-2.5 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-sm hover:bg-surface-light hover:text-text transition-all duration-fast shrink-0"
      >
        &larr;
      </button>
      <span className="font-medium text-[13px] min-w-0 truncate">{title}</span>
      {showPanelButton && onPanelToggle && (
        <button
          onClick={onPanelToggle}
          className="ml-auto px-2.5 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-sm hover:bg-surface-light hover:text-text transition-all duration-150"
          title="Toggle panel"
        >
          ☰
        </button>
      )}
      <div className={`flex items-center gap-2 ${showPanelButton ? "" : "ml-auto"}`}>
        {/* TTS auto-play toggle */}
        {onAutoPlayToggle !== undefined && (
          <button
            onClick={onAutoPlayToggle}
            className={`px-2 py-1 rounded-md text-xs border cursor-pointer transition-all duration-fast ${
              autoPlay
                ? "text-accent border-accent/60 bg-accent/10"
                : "text-text-dim border-border/60 hover:border-border hover:text-text"
            }`}
            title={autoPlay ? "Auto-play voice ON" : "Auto-play voice OFF"}
          >
            {autoPlay ? "\u{1F50A}" : "\u{1F507}"}
          </button>
        )}
        {/* Voice chat toggle */}
        {onVoiceChatToggle !== undefined && (
          <button
            onClick={onVoiceChatToggle}
            className={`px-2 py-1 rounded-md text-xs border cursor-pointer transition-all duration-fast ${
              voiceChat
                ? "text-green-400 border-green-500/60 bg-green-500/10"
                : "text-text-dim border-border/60 hover:border-border hover:text-text"
            }`}
            title={voiceChat ? "음성 대화 모드 ON" : "음성 대화 모드 OFF"}
          >
            {voiceChat ? "\u{1F3A4}" : "\u{1F3A4}"}
          </button>
        )}

        {/* Settings button */}
        {onSettings && (
          <button
            onClick={onSettings}
            className="px-2 py-1 rounded-md text-xs border cursor-pointer transition-all duration-fast
              border-border/40 text-text-dim/50 bg-transparent hover:border-border/60 hover:text-text-dim/80"
            title="채팅 옵션"
          >
            &#9881;
          </button>
        )}

        {/* Debug / Tools dropdown */}
        {hasDebugItems && (
          <>
            <button
              ref={debugBtnRef}
              onClick={() => setDebugOpen(!debugOpen)}
              className={`px-2 py-1 rounded-md text-xs border cursor-pointer transition-all duration-fast
                ${debugOpen
                  ? "border-accent/40 text-accent/70 bg-accent/5"
                  : "border-border/40 text-text-dim/50 bg-transparent hover:border-border/60 hover:text-text-dim/80"
                }`}
              title="도구"
            >
              &#9776;
            </button>
            {debugOpen && debugPos && createPortal(
              <div
                ref={debugMenuRef}
                style={{ position: "fixed", top: debugPos.y, right: window.innerWidth - debugPos.x }}
                className="min-w-[160px] py-1
                  rounded-lg border border-border/60 bg-[rgba(20,16,32,0.97)]
                  shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[9999]"
              >
                {onUsage && (
                  <button
                    onClick={() => { onUsage(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    Usage
                  </button>
                )}
                {onForceInputToggle && (
                  <button
                    onClick={() => { onForceInputToggle(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    {forceInput ? "✅ " : ""}채팅 입력 강제 표시
                  </button>
                )}
                {onCompact && (
                  <button
                    onClick={() => { onCompact(); setDebugOpen(false); }}
                    disabled={status === "compacting" || status === "streaming" || status === "disconnected"}
                    className={menuBtnClass}
                  >
                    Compact
                  </button>
                )}
                {onContext && (
                  <button
                    onClick={() => { onContext(); setDebugOpen(false); }}
                    disabled={status === "compacting" || status === "streaming" || status === "disconnected"}
                    className={menuBtnClass}
                  >
                    Context
                  </button>
                )}
                {!isBuilderMode && onSync && (
                  <button
                    onClick={() => { onSync(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    Sync
                  </button>
                )}
                {onReinit && (
                  <button
                    onClick={() => { onReinit(); setDebugOpen(false); }}
                    className={menuBtnClass}
                  >
                    Reconnect
                  </button>
                )}
              </div>,
              document.body
            )}
          </>
        )}

        {/* Builder: full model selector */}
        {isBuilderMode && onBuilderModelChange && (
          <select
            value={builderModel || ""}
            onChange={(e) => onBuilderModelChange(e.target.value)}
            className={selectClass}
            style={selectStyle}
          >
            {MODEL_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value} className={optClass}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        {/* Chat: model selector within locked provider */}
        {!isBuilderMode && onModelChange && (
          <select
            value={model || ""}
            onChange={(e) => onModelChange(e.target.value)}
            className={selectClass}
            style={selectStyle}
          >
            {MODEL_GROUPS
              .filter((g) => g.provider === provider)
              .flatMap((g) => g.options)
              .map((o) => (
                <option key={o.value} value={o.value} className={optClass}>{o.label}</option>
              ))}
          </select>
        )}

        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusColors[status] || statusColors.disconnected}`}
        />
        <span className="text-xs text-text-dim">
          {statusLabels[status] || status}
        </span>
      </div>
      {isBuilderMode && (
        <div className="flex items-center gap-1.5">
          {onVersionSave && (
            <button
              onClick={onVersionSave}
              disabled={versionSaving}
              className="px-2.5 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text hover:-translate-y-px transition-all duration-fast disabled:opacity-40 disabled:cursor-default"
              title="현재 상태를 버전으로 보관"
            >
              {versionSaving ? "Saving..." : "Save Ver."}
            </button>
          )}
          {onVersionHistory && (
            <button
              onClick={onVersionHistory}
              className="px-2.5 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text hover:-translate-y-px transition-all duration-fast"
              title="버전 히스토리"
            >
              History
            </button>
          )}
        </div>
      )}
    </header>
  );
}
