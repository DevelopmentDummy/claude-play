"use client";

interface SessionCardProps {
  id: string;
  title: string;
  persona: string;
  createdAt: string;
  hasIcon?: boolean;
  index?: number;
  onOpen: () => void;
  onDelete: () => void;
}

export default function SessionCard({
  id,
  title,
  persona,
  createdAt,
  hasIcon,
  onOpen,
  onDelete,
}: SessionCardProps) {
  const date = new Date(createdAt);
  const timeStr = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      className="group relative flex items-center gap-3 mx-2 px-4 py-3 rounded-xl cursor-pointer
        transition-all duration-fast
        hover:bg-surface-light/50"
      onClick={onOpen}
    >
      {hasIcon ? (
        <img
          src={`/api/sessions/${id}/files?path=images/icon.png`}
          alt=""
          className="w-8 h-8 rounded-full object-cover shrink-0 border border-white/[0.08]"
        />
      ) : (
        <div className="w-8 h-8 rounded-full shrink-0 bg-surface-light/40 flex items-center justify-center text-xs text-text-dim/60 border border-white/[0.06]">
          {persona.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text truncate leading-snug">{title}</div>
        <div className="text-xs text-text-dim/60 mt-1">
          {persona} &middot; {timeStr}
        </div>
      </div>

      <button
        className="absolute top-2.5 right-2.5 w-6 h-6 flex items-center justify-center rounded-md text-sm text-text-dim/40 cursor-pointer
          opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast
          hover:text-error hover:bg-error/10"
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
