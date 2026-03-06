"use client";

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
  provider?: "claude" | "codex";
  onModelChange?: (model: string) => void;
  /** Builder mode: service (provider) selector */
  service?: "claude" | "codex";
  onServiceChange?: (service: "claude" | "codex") => void;
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
  service,
  onServiceChange,
}: StatusBarProps) {
  const statusColors: Record<string, string> = {
    connected: "bg-success shadow-[0_0_8px_rgba(77,255,145,0.4)]",
    streaming: "bg-warning animate-pulse shadow-[0_0_8px_rgba(255,166,77,0.4)]",
    disconnected: "bg-error shadow-[0_0_8px_rgba(255,77,106,0.4)]",
  };

  const statusLabels: Record<string, string> = {
    connected: "Connected",
    streaming: "Streaming...",
    disconnected: "Disconnected",
  };

  return (
    <header className="flex items-center gap-2 px-4 py-2 bg-surface backdrop-blur-[16px] border-b border-border shrink-0">
      <button
        onClick={onBack}
        className="px-2.5 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-sm hover:bg-surface-light hover:text-text transition-all duration-fast"
      >
        &larr;
      </button>
      <span className="font-medium text-[13px]">{title}</span>
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
        {/* Builder: service (provider) selector */}
        {isBuilderMode && onServiceChange && (
          <select
            value={service || "claude"}
            onChange={(e) => onServiceChange(e.target.value as "claude" | "codex")}
            className={selectClass}
            style={selectStyle}
          >
            <option value="claude" className={optClass}>Claude</option>
            <option value="codex" className={optClass}>Codex</option>
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
            {provider === "codex" ? (
              <>
                <option value="gpt-5.4" className={optClass}>GPT-5.4</option>
                <option value="gpt-5.3-codex" className={optClass}>GPT-5.3 Codex</option>
                <option value="codex-mini-latest" className={optClass}>Codex Mini</option>
              </>
            ) : (
              <>
                <option value="" className={optClass}>Default</option>
                <option value="sonnet" className={optClass}>Sonnet</option>
                <option value="opus" className={optClass}>Opus</option>
                <option value="haiku" className={optClass}>Haiku</option>
              </>
            )}
          </select>
        )}

        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusColors[status] || statusColors.disconnected}`}
        />
        <span className="text-xs text-text-dim">
          {statusLabels[status] || status}
        </span>
      </div>
      {isBuilderMode && onReinit && (
        <button
          onClick={onReinit}
          className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text hover:-translate-y-px transition-all duration-fast"
          title="Kill and respawn process"
        >
          Reconnect
        </button>
      )}
    </header>
  );
}
