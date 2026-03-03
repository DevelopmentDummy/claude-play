"use client";

interface SessionCardProps {
  id: string;
  title: string;
  persona: string;
  createdAt: string;
  onOpen: () => void;
  onDelete: () => void;
}

export default function SessionCard({
  title,
  persona,
  createdAt,
  onOpen,
  onDelete,
}: SessionCardProps) {
  const date = new Date(createdAt).toLocaleString();

  return (
    <div
      className="group relative p-3.5 px-[18px] bg-surface backdrop-blur-[16px] border border-border rounded-xl cursor-pointer min-w-[180px] transition-all duration-normal shadow-sm hover:border-accent hover:-translate-y-0.5 hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]"
      onClick={onOpen}
    >
      <div className="font-medium mb-1">{title}</div>
      <div className="text-xs text-text-dim">
        {persona} &middot; {date}
      </div>
      <button
        className="absolute top-2 right-2 px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs opacity-0 group-hover:opacity-100 transition-all duration-fast hover:bg-surface-light hover:text-text hover:-translate-y-px"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        Delete
      </button>
    </div>
  );
}
