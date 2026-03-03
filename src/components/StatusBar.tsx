"use client";

interface StatusBarProps {
  title: string;
  status: string;
  isBuilderMode: boolean;
  onBack: () => void;
  onFinish: () => void;
}

export default function StatusBar({
  title,
  status,
  isBuilderMode,
  onBack,
  onFinish,
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
      <span
        className={`w-2.5 h-2.5 rounded-full ml-auto shrink-0 ${statusColors[status] || statusColors.disconnected}`}
      />
      <span className="text-xs text-text-dim">
        {statusLabels[status] || status}
      </span>
      {isBuilderMode && (
        <button
          onClick={onFinish}
          className="px-3 py-1 border border-accent rounded-md bg-accent text-white cursor-pointer text-xs font-medium shadow-[0_2px_12px_var(--accent-glow)] hover:bg-accent-hover hover:-translate-y-px transition-all duration-fast"
        >
          Complete
        </button>
      )}
    </header>
  );
}
