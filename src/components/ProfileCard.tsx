"use client";

interface ProfileCardProps {
  name: string;
  isPrimary?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function ProfileCard({ name, isPrimary, onEdit, onDelete }: ProfileCardProps) {
  return (
    <div
      className={`group relative inline-flex items-center gap-2.5 px-4 py-2 rounded-full cursor-pointer
        bg-surface/50 border transition-all duration-fast
        hover:bg-surface/70 hover:border-border/60 ${
          isPrimary ? "border-accent/40" : "border-border/40"
        }`}
      onClick={onEdit}
    >
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
        style={{
          background: isPrimary ? "rgba(var(--accent-rgb, 124,111,255),0.2)" : "rgba(136,136,160,0.15)",
          color: isPrimary ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      <span className="text-[13px] text-text font-medium">{name}</span>
      {isPrimary && (
        <span className="text-[10px] text-accent/70">{"\u2605"}</span>
      )}
      <button
        className="text-sm text-text-dim/40 cursor-pointer ml-0.5
          opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast
          hover:text-error"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        &times;
      </button>
    </div>
  );
}
