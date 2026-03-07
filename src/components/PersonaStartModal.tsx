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
  onStart: (profileSlug?: string, model?: string) => void;
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
  const [hasProfileImage, setHasProfileImage] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("opus:high");

  useEffect(() => {
    if (open) {
      const primary = profiles.find((p) => p.isPrimary);
      setSelectedProfile(primary ? primary.slug : "__none__");
    }
  }, [open, profiles]);

  useEffect(() => {
    if (!open || !personaName) return;
    setLoading(true);
    setPersonaContent(null);
    setOpeningContent(null);
    setHasProfileImage(false);

    const enc = encodeURIComponent(personaName);
    const fetchFile = (file: string) =>
      fetch(`/api/personas/${enc}/file?file=${encodeURIComponent(file)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.content as string | null)
        .catch(() => null);

    const checkImage = fetch(`/api/personas/${enc}/images?file=profile.png`, { method: "HEAD" })
      .then((r) => r.ok)
      .catch(() => false);

    Promise.all([
      fetch(`/api/personas/${enc}/overview`).then((r) => (r.ok ? r.json() : null)),
      fetchFile("persona.md"),
      fetchFile("opening.md"),
      checkImage,
    ]).then(([overviewData, persona, opening, hasImage]) => {
      setOverview(overviewData);
      setPersonaContent(persona);
      setOpeningContent(opening);
      setHasProfileImage(hasImage as boolean);
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
  const worldview = getFile("worldview.md");
  const opening = getFile("opening.md");
  const hasLayout = getFile("layout.json")?.exists;

  const personaDescription = personaContent
    ? personaContent.split("\n").slice(1).join("\n").trim()
    : null;

  const initial = personaDisplayName.charAt(0).toUpperCase();
  const profileImageUrl = hasProfileImage
    ? `/api/personas/${encodeURIComponent(personaName)}/images?file=profile.png`
    : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] flex items-center justify-center z-[100]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative bg-surface border border-border/70 rounded-2xl w-[520px] max-h-[85vh] flex flex-col shadow-2xl animate-[slideUp_0.25s_ease-out] overflow-hidden"
        onKeyDown={handleKeyDown}
        style={{
          boxShadow: `0 0 80px ${accentColor}15, 0 25px 50px rgba(0,0,0,0.4)`,
        }}
      >
        {/* ── Background profile image ── */}
        {profileImageUrl && (
          <div className="absolute inset-0 pointer-events-none">
            <img
              src={profileImageUrl}
              alt=""
              className="w-full h-full object-cover opacity-[0.12]"
              style={{ filter: "blur(2px) saturate(0.6)" }}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[var(--surface)]/30 via-transparent to-[var(--surface)]" />
          </div>
        )}

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg cursor-pointer
            text-text-dim/50 hover:text-text hover:bg-surface-light/80 transition-all duration-fast text-lg"
        >
          &times;
        </button>

        {/* ── Scrollable content ── */}
        <div className="relative flex-1 overflow-y-auto">
          <div className="px-7 pt-7 pb-4 flex flex-col gap-5">
            {/* Identity: avatar + name */}
            <div className="flex items-start gap-4">
              {profileImageUrl ? (
                <img
                  src={profileImageUrl}
                  alt={personaDisplayName}
                  className="w-16 h-16 rounded-xl object-cover shrink-0 shadow-lg"
                  style={{ border: `1px solid ${accentColor}30` }}
                />
              ) : (
                <div
                  className="w-16 h-16 rounded-xl flex items-center justify-center text-2xl font-semibold shrink-0"
                  style={{
                    background: `linear-gradient(135deg, ${accentColor}25, ${accentColor}08)`,
                    color: accentColor,
                    border: `1px solid ${accentColor}30`,
                  }}
                >
                  {initial}
                </div>
              )}
              <div className="flex-1 min-w-0 pt-1">
                <h3 className="text-xl font-semibold text-text tracking-tight">
                  {personaDisplayName}
                </h3>
                {/* Info chips inline with name */}
                {overview && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {worldview?.exists && <InfoChip label="Worldview" color={accentColor} />}
                    {opening?.exists && <InfoChip label="Opening" color={accentColor} />}
                    {hasLayout && <InfoChip label="Custom Layout" color={accentColor} />}
                    {overview.panels.length > 0 && (
                      <InfoChip
                        label={`${overview.panels.length} Panel${overview.panels.length > 1 ? "s" : ""}`}
                        color={accentColor}
                        detail={overview.panels.map(stripPanelPrefix).join(", ")}
                      />
                    )}
                    {overview.skills.length > 0 && (
                      <InfoChip
                        label={`${overview.skills.length} Skill${overview.skills.length > 1 ? "s" : ""}`}
                        color={accentColor}
                        detail={overview.skills.join(", ")}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div
                  className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin"
                  style={{ borderColor: `${accentColor}40`, borderTopColor: "transparent" }}
                />
              </div>
            ) : (
              <>
                {/* Persona description — full, no truncation */}
                {personaDescription && (
                  <div className="text-[13px] text-text-dim/80 leading-relaxed whitespace-pre-line">
                    {personaDescription}
                  </div>
                )}

                {/* Opening preview */}
                {openingContent && (
                  <div
                    className="rounded-xl overflow-hidden"
                    style={{ background: `${accentColor}06`, border: `1px solid ${accentColor}15` }}
                  >
                    <div className="px-3.5 py-2 border-b" style={{ borderColor: `${accentColor}12` }}>
                      <span className="text-[10px] font-medium uppercase tracking-widest" style={{ color: `${accentColor}90` }}>
                        Opening
                      </span>
                    </div>
                    <div className="px-3.5 py-3">
                      <p className="text-xs text-text-dim/60 leading-relaxed whitespace-pre-line italic">
                        {openingContent}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Footer: profile + model select + start (sticky) ── */}
        <div className="relative px-7 py-5 border-t border-border/40 shrink-0 bg-surface/80 backdrop-blur-sm">
          <div className="flex items-center gap-3">
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

            <div className="flex-1 relative">
              <label className="block text-[11px] text-text-dim/50 uppercase tracking-wider font-medium mb-1.5">
                Model
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
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
                <optgroup label="Claude" className="bg-[#1a1a2e] text-[#ccc]">
                  <option value="opus:medium" className="bg-[#1a1a2e] text-[#ccc]">Opus Medium</option>
                  <option value="opus:high" className="bg-[#1a1a2e] text-[#ccc]">Opus High</option>
                </optgroup>
                <optgroup label="Codex" className="bg-[#1a1a2e] text-[#ccc]">
                  <option value="gpt-5.4:medium" className="bg-[#1a1a2e] text-[#ccc]">GPT-5.4 Medium</option>
                  <option value="gpt-5.4:high" className="bg-[#1a1a2e] text-[#ccc]">GPT-5.4 High</option>
                  <option value="gpt-5.4:xhigh" className="bg-[#1a1a2e] text-[#ccc]">GPT-5.4 XHigh</option>
                </optgroup>
              </select>
            </div>

            <div className="pt-5">
              <button
                disabled={selectedProfile === "__none__"}
                onClick={() => onStart(selectedProfile, selectedModel || undefined)}
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

function InfoChip({ label, color, detail }: { label: string; color: string; detail?: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium tracking-wide"
      style={{
        background: `${color}10`,
        color: `${color}cc`,
        border: `1px solid ${color}20`,
      }}
      title={detail}
    >
      {label}
    </span>
  );
}
