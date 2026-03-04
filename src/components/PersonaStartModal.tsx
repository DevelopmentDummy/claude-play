"use client";

import { useState, useEffect, useCallback } from "react";

interface ProfileOption {
  slug: string;
  name: string;
  isPrimary?: boolean;
}

interface PersonaOverviewFile {
  name: string;
  exists: boolean;
  preview: string | null;
}

interface PersonaOverview {
  files: PersonaOverviewFile[];
  panels: string[];
  skills: string[];
}

interface PersonaStartModalProps {
  open: boolean;
  personaName: string;
  personaDisplayName: string;
  accentColor: string;
  profiles: ProfileOption[];
  onClose: () => void;
  onStart: (profileSlug?: string) => void;
}

function stripPanelPrefix(name: string): string {
  return name.replace(/^\d+-/, "").replace(/\.html$/, "");
}

export default function PersonaStartModal({
  open,
  personaName,
  personaDisplayName,
  accentColor,
  profiles,
  onClose,
  onStart,
}: PersonaStartModalProps) {
  const [overview, setOverview] = useState<PersonaOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<string>("__none__");
  const [personaContent, setPersonaContent] = useState<string | null>(null);
  const [openingContent, setOpeningContent] = useState<string | null>(null);

  // Find primary profile and set as default
  useEffect(() => {
    if (open) {
      const primary = profiles.find((p) => p.isPrimary);
      setSelectedProfile(primary ? primary.slug : "__none__");
    }
  }, [open, profiles]);

  // Fetch persona overview + full file contents when modal opens
  useEffect(() => {
    if (!open || !personaName) return;
    setLoading(true);
    setPersonaContent(null);
    setOpeningContent(null);

    const enc = encodeURIComponent(personaName);
    const fetchFile = (file: string) =>
      fetch(`/api/personas/${enc}/file?file=${encodeURIComponent(file)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.content as string | null)
        .catch(() => null);

    Promise.all([
      fetch(`/api/personas/${enc}/overview`).then((r) => (r.ok ? r.json() : null)),
      fetchFile("persona.md"),
      fetchFile("opening.md"),
    ]).then(([overviewData, persona, opening]) => {
      setOverview(overviewData);
      setPersonaContent(persona);
      setOpeningContent(opening);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [open, personaName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  if (!open) return null;

  const getFile = (name: string) => overview?.files.find((f) => f.name === name);
  const personaMd = getFile("persona.md");
  const worldview = getFile("worldview.md");
  const opening = getFile("opening.md");
  const hasLayout = getFile("layout.json")?.exists;

  // Extract description from persona.md (skip first line which is the title)
  const personaDescription = personaContent
    ? personaContent
        .split("\n")
        .slice(1)
        .join("\n")
        .trim()
    : null;

  const initial = personaDisplayName.charAt(0).toUpperCase();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] flex items-center justify-center z-[100]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-surface border border-border/70 rounded-2xl w-[520px] max-h-[85vh] flex flex-col shadow-2xl animate-[slideUp_0.25s_ease-out]"
        onKeyDown={handleKeyDown}
        style={{
          boxShadow: `0 0 80px ${accentColor}15, 0 25px 50px rgba(0,0,0,0.4)`,
        }}
      >
        {/* ── Header with persona identity ── */}
        <div className="relative px-7 pt-7 pb-5 overflow-hidden">
          {/* Subtle gradient wash */}
          <div
            className="absolute inset-0 opacity-[0.07]"
            style={{
              background: `radial-gradient(ellipse at 30% 0%, ${accentColor}, transparent 70%)`,
            }}
          />
          <div className="relative flex items-start gap-4">
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-xl font-semibold shrink-0"
              style={{
                background: `linear-gradient(135deg, ${accentColor}25, ${accentColor}08)`,
                color: accentColor,
                border: `1px solid ${accentColor}30`,
              }}
            >
              {initial}
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <h3 className="text-lg font-semibold text-text tracking-tight">
                {personaDisplayName}
              </h3>
              {personaDescription && (
                <p className="text-[13px] text-text-dim/70 mt-1.5 leading-relaxed whitespace-pre-line">
                  {personaDescription}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-dim/40 cursor-pointer
                hover:bg-surface-light hover:text-text-dim transition-all duration-fast text-lg shrink-0 -mt-1 -mr-1"
            >
              &times;
            </button>
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto px-7 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div
                className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin"
                style={{ borderColor: `${accentColor}40`, borderTopColor: "transparent" }}
              />
            </div>
          ) : overview ? (
            <div className="flex flex-col gap-4">
              {/* Info chips */}
              <div className="flex flex-wrap gap-2">
                {worldview?.exists && (
                  <InfoChip label="Worldview" color={accentColor} />
                )}
                {opening?.exists && (
                  <InfoChip label="Opening" color={accentColor} />
                )}
                {hasLayout && (
                  <InfoChip label="Custom Layout" color={accentColor} />
                )}
                {overview.panels.length > 0 && (
                  <InfoChip
                    label={`${overview.panels.length} Panel${overview.panels.length > 1 ? "s" : ""}`}
                    color={accentColor}
                  />
                )}
                {overview.skills.length > 0 && (
                  <InfoChip
                    label={`${overview.skills.length} Skill${overview.skills.length > 1 ? "s" : ""}`}
                    color={accentColor}
                  />
                )}
              </div>

              {/* Panels list */}
              {overview.panels.length > 0 && (
                <DetailSection title="Panels" accentColor={accentColor}>
                  <div className="flex flex-wrap gap-1.5">
                    {overview.panels.map((p) => (
                      <span
                        key={p}
                        className="px-2.5 py-1 rounded-md text-xs text-text-dim bg-surface-light/50 border border-border/30"
                      >
                        {stripPanelPrefix(p)}
                      </span>
                    ))}
                  </div>
                </DetailSection>
              )}

              {/* Skills list */}
              {overview.skills.length > 0 && (
                <DetailSection title="Skills" accentColor={accentColor}>
                  <div className="flex flex-wrap gap-1.5">
                    {overview.skills.map((s) => (
                      <span
                        key={s}
                        className="px-2.5 py-1 rounded-md text-xs text-text-dim bg-surface-light/50 border border-border/30"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </DetailSection>
              )}

              {/* Opening message */}
              {openingContent && (
                <DetailSection title="Opening" accentColor={accentColor}>
                  <div className="max-h-[200px] overflow-y-auto rounded-lg">
                    <p className="text-xs text-text-dim/60 leading-relaxed whitespace-pre-line">
                      {openingContent}
                    </p>
                  </div>
                </DetailSection>
              )}
            </div>
          ) : null}
        </div>

        {/* ── Footer: profile select + start ── */}
        <div className="px-7 py-5 border-t border-border/40">
          <div className="flex items-center gap-3">
            {/* Profile combobox */}
            <div className="flex-1 relative">
              <label className="block text-[11px] text-text-dim/50 uppercase tracking-wider font-medium mb-1.5">
                User Profile
              </label>
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
                  border border-border/60 outline-none cursor-pointer appearance-none
                  transition-all duration-fast
                  focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-glow)]
                  hover:border-border"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 12px center",
                  paddingRight: "32px",
                }}
              >
                <option value="__none__">No profile</option>
                {profiles.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}{p.isPrimary ? " \u2605" : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Start button */}
            <div className="pt-5">
              <button
                disabled={selectedProfile === "__none__"}
                onClick={() => onStart(selectedProfile)}
                className="px-6 py-2.5 rounded-xl text-sm font-medium
                  border transition-all duration-fast
                  disabled:opacity-35 disabled:cursor-not-allowed disabled:translate-y-0
                  enabled:cursor-pointer enabled:hover:-translate-y-px enabled:active:translate-y-0"
                style={{
                  background: selectedProfile === "__none__" ? undefined : accentColor,
                  borderColor: selectedProfile === "__none__" ? "var(--border)" : accentColor,
                  color: selectedProfile === "__none__" ? "var(--text-dim)" : "#fff",
                  boxShadow: selectedProfile === "__none__" ? "none" : `0 4px 20px ${accentColor}40`,
                }}
              >
                Start
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-medium tracking-wide"
      style={{
        background: `${color}10`,
        color: `${color}cc`,
        border: `1px solid ${color}20`,
      }}
    >
      {label}
    </span>
  );
}

function DetailSection({
  title,
  accentColor,
  children,
}: {
  title: string;
  accentColor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-1 h-3 rounded-full"
          style={{ background: `${accentColor}60` }}
        />
        <span className="text-[11px] text-text-dim/50 uppercase tracking-wider font-medium">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}
