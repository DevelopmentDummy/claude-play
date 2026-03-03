"use client";

interface PersonaCardProps {
  name: string;
  displayName: string;
  onSelect: () => void;
  onEdit: () => void;
}

export default function PersonaCard({
  displayName,
  onSelect,
  onEdit,
}: PersonaCardProps) {
  return (
    <div
      className="group relative p-3.5 px-[18px] bg-surface backdrop-blur-[16px] border border-border rounded-xl cursor-pointer min-w-[180px] transition-all duration-normal shadow-sm hover:border-accent hover:-translate-y-0.5 hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]"
      onClick={onSelect}
    >
      <div className="font-medium mb-1">{displayName}</div>
      <div className="text-xs text-text-dim">Click to start new session</div>
      <button
        className="absolute top-2 right-2 px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs opacity-0 group-hover:opacity-100 transition-all duration-fast hover:bg-surface-light hover:text-text hover:-translate-y-px"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
      >
        Edit
      </button>
    </div>
  );
}
