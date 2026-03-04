"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface FileInfo {
  name: string;
  exists: boolean;
  preview: string | null;
}

interface PanelPreview {
  name: string;
  html: string;
}

interface OverviewData {
  files: FileInfo[];
  panels: string[];
  panelData: PanelPreview[];
  skills: string[];
  hasProfile?: boolean;
  hasIcon?: boolean;
}

/** Inline Shadow DOM renderer for panel preview */
function PanelPreviewSlot({ name, html }: PanelPreview) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  useEffect(() => {
    if (shadowRef.current) {
      shadowRef.current.innerHTML =
        `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;line-height:1.7;color:#e0e0e0;}</style>` +
        html;
    }
  }, [html]);

  return (
    <div className="bg-[rgba(15,15,26,0.25)] rounded-lg overflow-hidden border border-white/[0.06]">
      <div className="px-3.5 py-2 text-[10px] font-semibold text-accent/80 uppercase tracking-wider">
        {name}
      </div>
      <div ref={containerRef} className="max-h-[200px] overflow-hidden mx-3.5 mb-3.5" />
    </div>
  );
}

interface BuilderOverviewProps {
  personaName: string | null;
  refreshTrigger: number;
}

export default function BuilderOverview({
  personaName,
  refreshTrigger,
}: BuilderOverviewProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!personaName) return;
    try {
      const res = await fetch(
        `/api/personas/${encodeURIComponent(personaName)}/overview`
      );
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    }
  }, [personaName]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTrigger]);

  const toggleSection = (name: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (!personaName || !data) return null;

  return (
    <div className="w-[380px] shrink-0 border-r border-border bg-surface backdrop-blur-[16px] overflow-y-auto p-4">
      <h3 className="text-[13px] font-semibold text-accent uppercase tracking-wider mb-3.5">
        Persona Overview
      </h3>

      {/* Profile Image & Icon Preview */}
      <div className="mb-4 flex gap-3 items-end">
        <div className="flex-1">
          <div className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Profile
          </div>
          {data.hasProfile ? (
            <img
              src={`/api/personas/${encodeURIComponent(personaName)}/images?file=profile.png&t=${refreshTrigger}`}
              alt="Profile"
              className="w-full rounded-xl border border-white/[0.06] object-cover"
              style={{ maxHeight: "280px" }}
            />
          ) : (
            <div className="w-full aspect-[2/3] rounded-xl border border-dashed border-white/[0.1] flex items-center justify-center text-text-dim/30 text-xs">
              Not generated
            </div>
          )}
        </div>
        <div className="shrink-0">
          <div className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Icon
          </div>
          {data.hasIcon ? (
            <img
              src={`/api/personas/${encodeURIComponent(personaName)}/images?file=icon.png&t=${refreshTrigger}`}
              alt="Icon"
              className="w-16 h-16 rounded-full border border-white/[0.06] object-cover"
            />
          ) : (
            <div className="w-16 h-16 rounded-full border border-dashed border-white/[0.1] flex items-center justify-center text-text-dim/30 text-[10px]">
              N/A
            </div>
          )}
        </div>
      </div>

      {data.files.map((file) => (
        <div
          key={file.name}
          className="mb-2.5 border border-border rounded-lg overflow-hidden"
        >
          <div
            className={`flex items-center gap-2 px-2.5 py-2 bg-surface-light cursor-pointer text-[13px] select-none hover:bg-[rgba(31,47,80,0.9)] transition-colors duration-fast ${
              !file.exists ? "opacity-50" : ""
            }`}
            onClick={() => file.exists && file.preview && toggleSection(file.name)}
          >
            <span
              className={`shrink-0 text-xs ${
                file.exists ? "text-success" : "text-error opacity-50"
              }`}
            >
              {file.exists ? "\u2713" : "\u2717"}
            </span>
            <span className="flex-1">{file.name}</span>
            {file.exists && file.preview && (
              <span
                className="text-[10px] text-text-dim transition-transform duration-200"
                style={{
                  transform: openSections.has(file.name)
                    ? "rotate(90deg)"
                    : "none",
                }}
              >
                &#9654;
              </span>
            )}
          </div>
          {openSections.has(file.name) && file.preview && (
            <div className="p-2.5 bg-code-bg font-mono text-xs leading-relaxed whitespace-pre-wrap break-words max-h-[160px] overflow-hidden text-text-dim">
              {file.preview}
            </div>
          )}
        </div>
      ))}

      {data.panelData && data.panelData.length > 0 && (
        <div className="mb-2.5">
          <h4 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Panels ({data.panelData.length})
          </h4>
          <div className="flex flex-col gap-2">
            {data.panelData.map((p) => (
              <PanelPreviewSlot key={p.name} name={p.name} html={p.html} />
            ))}
          </div>
        </div>
      )}

      {data.skills.length > 0 && (
        <div className="mb-2.5">
          <h4 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Skills ({data.skills.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {data.skills.map((s) => (
              <span
                key={s}
                className="inline-block px-2.5 py-0.5 bg-surface-light border border-border rounded-xl text-xs text-text"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
