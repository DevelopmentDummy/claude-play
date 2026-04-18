"use client";

import KebabMenu, { KebabMenuItem } from "./KebabMenu";

const PERSONA_GRADIENTS = [
  { from: "#2a1a3a", to: "#1a1028", line: "#b87db8" },
  { from: "#3a2a1a", to: "#28180a", line: "#e6a664" },
  { from: "#1a2a3a", to: "#0a1828", line: "#6ac4e6" },
  { from: "#2a3a1a", to: "#182810", line: "#8ec46a" },
  { from: "#3a1a28", to: "#28101a", line: "#e66a8c" },
  { from: "#2a1a2a", to: "#1a081a", line: "#c888e6" },
];

interface PersonaCardProps {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  index?: number;
  sessionCount?: number;
  tagline?: string;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClone: () => void;
  importMeta?: {
    source: string;
    url: string;
    installedAt: string;
    installedCommit: string;
  };
  publishMeta?: { url: string };
  onCheckUpdate?: () => void;
  updateStatus?: string | null;
  behindCount?: number;
  onUpdate?: () => void;
}

export default function PersonaCard({
  name,
  displayName,
  hasIcon,
  index = 0,
  sessionCount = 0,
  tagline,
  onSelect,
  onEdit,
  onDelete,
  onClone,
  importMeta,
  publishMeta,
  onCheckUpdate,
  updateStatus,
  behindCount,
  onUpdate,
}: PersonaCardProps) {
  const grad = PERSONA_GRADIENTS[index % PERSONA_GRADIENTS.length];
  const initial = displayName.charAt(0).toUpperCase();
  const numLabel = `No. ${String(index + 1).padStart(2, "0")}`;
  const iconUrl = hasIcon
    ? `/api/personas/${encodeURIComponent(name)}/images?file=icon.png`
    : null;

  const items: KebabMenuItem[] = [
    { label: "편집", onClick: onEdit, icon: <span>&#9998;</span> },
    { label: "복제", onClick: onClone, icon: <span>&#10291;</span> },
    {
      label: updateStatus === "checking" ? "확인 중…" :
             updateStatus === "update-available" ? `업데이트 ${behindCount ?? 0}건` :
             updateStatus === "up-to-date" ? "최신" :
             "업데이트 확인",
      onClick: () => onCheckUpdate?.(),
      icon: <span>&#8635;</span>,
      hidden: !onCheckUpdate,
    },
    {
      label: "업데이트 적용",
      onClick: () => onUpdate?.(),
      icon: <span>&#8593;</span>,
      hidden: !(onUpdate && updateStatus === "update-available"),
    },
    {
      label: "삭제",
      confirm: sessionCount > 0 ? `삭제 (세션 ${sessionCount}개)` : "정말 삭제?",
      onClick: onDelete,
      danger: true,
      icon: <span>&times;</span>,
    },
  ];

  return (
    <div
      className="group relative rounded-xl overflow-hidden cursor-pointer
        bg-lobby-card border border-lobby-border
        transition-all duration-normal
        hover:border-lobby-border-hover hover:-translate-y-0.5"
      onClick={onSelect}
    >
      <div
        className="relative h-[140px] border-b"
        style={{
          background: iconUrl
            ? `url(${iconUrl}) center/cover no-repeat, linear-gradient(160deg, ${grad.from}, ${grad.to})`
            : `linear-gradient(160deg, ${grad.from}, ${grad.to})`,
          borderColor: "rgba(184,125,184,0.08)",
        }}
      >
        {!iconUrl && (
          <div className="absolute inset-0 flex items-center justify-center font-serif italic text-[28px]"
            style={{ color: "rgba(255,255,255,0.85)" }}>
            {initial}
          </div>
        )}
        <div className="absolute top-2.5 left-3 font-serif italic text-[10px]" style={{ color: "rgba(184,125,184,0.8)" }}>
          {numLabel}
        </div>
        {sessionCount > 0 && (
          <div className="absolute top-3 right-9 w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--plum)", boxShadow: "0 0 10px var(--plum-glow)" }} />
        )}
        <div className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast">
          <KebabMenu
            items={items}
            badge={updateStatus === "update-available" ? (
              <span className="block w-2 h-2 rounded-full bg-[var(--warning)] ring-2 ring-black" />
            ) : undefined}
          />
        </div>
        {(importMeta || publishMeta) && (
          <div className="absolute bottom-2 left-2.5 flex gap-1">
            {importMeta ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 tracking-wide">
                &#8595; 외부
              </span>
            ) : publishMeta ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 tracking-wide">
                &#8593; 업로드됨
              </span>
            ) : null}
          </div>
        )}
      </div>

      <div className="p-3.5">
        <div className="text-[15px] font-medium text-text" style={{ letterSpacing: "-0.01em" }}>
          {displayName}
        </div>
        <div className="text-[10px] text-text-mute mt-0.5">
          {sessionCount === 0 ? "No sessions yet" : `${sessionCount} session${sessionCount > 1 ? "s" : ""}`}
        </div>
        {tagline && (
          <div className="mt-2.5 text-[10px] italic text-text-dim/80 line-clamp-2 leading-[1.45]">
            &ldquo;{tagline}&rdquo;
          </div>
        )}
      </div>
    </div>
  );
}
