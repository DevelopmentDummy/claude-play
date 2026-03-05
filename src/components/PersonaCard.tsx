"use client";

const PERSONA_ACCENTS = [
  { from: "rgba(124,111,255,0.15)", to: "rgba(124,111,255,0.03)", line: "var(--accent)" },
  { from: "rgba(255,100,130,0.12)", to: "rgba(255,100,130,0.02)", line: "#ff6482" },
  { from: "rgba(77,255,145,0.10)", to: "rgba(77,255,145,0.02)", line: "#4dff91" },
  { from: "rgba(255,166,77,0.12)", to: "rgba(255,166,77,0.02)", line: "#ffa64d" },
  { from: "rgba(100,200,255,0.12)", to: "rgba(100,200,255,0.02)", line: "#64c8ff" },
  { from: "rgba(200,130,255,0.12)", to: "rgba(200,130,255,0.02)", line: "#c882ff" },
];

interface PersonaCardProps {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  index?: number;
  onSelect: () => void;
  onEdit: () => void;
}

export default function PersonaCard({
  name,
  displayName,
  hasIcon,
  index = 0,
  onSelect,
  onEdit,
}: PersonaCardProps) {
  const accent = PERSONA_ACCENTS[index % PERSONA_ACCENTS.length];
  const initial = displayName.charAt(0).toUpperCase();
  const iconUrl = hasIcon
    ? `/api/personas/${encodeURIComponent(name)}/images?file=icon.png`
    : null;

  return (
    <div
      className="group relative rounded-2xl cursor-pointer transition-all duration-normal overflow-hidden
        border border-border/60 hover:border-border hover:-translate-y-1"
      style={{
        background: `linear-gradient(135deg, ${accent.from} 0%, ${accent.to} 100%)`,
        boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
      }}
      onClick={onSelect}
    >
      {/* top accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-px opacity-60 group-hover:opacity-100 transition-opacity"
        style={{ background: `linear-gradient(90deg, ${accent.line}, transparent)` }}
      />

      <div className="p-6 pb-5">
        {/* icon or initial badge */}
        {iconUrl ? (
          <img
            src={iconUrl}
            alt={displayName}
            className="w-12 h-12 rounded-xl object-cover mb-4"
            style={{ border: `1px solid ${accent.line}33` }}
          />
        ) : (
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-semibold mb-4"
            style={{
              background: `linear-gradient(135deg, ${accent.from.replace(/[\d.]+\)$/, "0.4)")}, transparent)`,
              color: accent.line,
              border: `1px solid ${accent.line}33`,
            }}
          >
            {initial}
          </div>
        )}

        <div className="font-medium text-base mb-1 text-text">{displayName}</div>
        <div className="text-xs text-text-dim opacity-70">Start new session</div>
      </div>

      {/* edit button */}
      <button
        className="absolute top-3.5 right-3.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer
          text-text-dim/70 bg-transparent border border-transparent
          opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all duration-fast
          hover:bg-surface-light hover:text-text hover:border-border/40"
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
