"use client";

import { useState, useEffect, useCallback } from "react";

interface FileInfo {
  name: string;
  exists: boolean;
  preview: string | null;
}

interface OverviewData {
  files: FileInfo[];
  panels: string[];
  skills: string[];
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

      {data.panels.length > 0 && (
        <div className="mb-2.5">
          <h4 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Panels ({data.panels.length})
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {data.panels.map((p) => (
              <span
                key={p}
                className="inline-block px-2.5 py-0.5 bg-surface-light border border-border rounded-xl text-xs text-text"
              >
                {p}
              </span>
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
