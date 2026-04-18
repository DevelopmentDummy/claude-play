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
      className={`group relative inline-flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer
        transition-all duration-fast border
        ${isPrimary
          ? "border-plum-hairline bg-plum-soft text-text"
          : "border-lobby-border bg-white/[0.02] text-text-dim hover:text-text"}`}
      onClick={onEdit}
      title={isPrimary ? `${name} (primary)` : name}
    >
      {isPrimary && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--plum)" }} />
      )}
      <span className="text-[11px] font-medium">{name}</span>
      <button
        type="button"
        className="text-xs text-text-dim/40 cursor-pointer ml-0.5
          opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast
          hover:text-error"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        &times;
      </button>
    </div>
  );
}
