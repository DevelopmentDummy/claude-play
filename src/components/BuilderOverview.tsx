"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface FileInfo {
  name: string;
  exists: boolean;
  preview: string | null;
}

interface PanelPreview {
  name: string;
  html: string;
}

interface DataFileInfo {
  name: string;
  filename: string;
  preview: string;
  keys: string[];
}

interface OverviewData {
  files: FileInfo[];
  panels: string[];
  panelData: PanelPreview[];
  skills: string[];
  dataFiles: DataFileInfo[];
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
      <div ref={containerRef} className="mx-3.5 mb-3.5" />
    </div>
  );
}

/** Modal for viewing full file content */
function FileViewerModal({
  title,
  content,
  onClose,
}: {
  title: string;
  content: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const isJson = title.endsWith(".json");
  let displayContent = content;
  if (isJson) {
    try {
      displayContent = JSON.stringify(JSON.parse(content), null, 2);
    } catch { /* keep raw */ }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="fixed inset-4 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-[720px] max-h-full flex flex-col bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
            <span className="text-sm font-semibold text-text">{title}</span>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-surface-light transition-colors text-sm cursor-pointer"
            >
              &times;
            </button>
          </div>
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-text-dim">
              {displayContent}
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}

interface BuilderOverviewProps {
  personaName: string | null;
  refreshTrigger: number;
  /** When true, renders without fixed-width container (used inside mobile drawer) */
  embedded?: boolean;
}

export default function BuilderOverview({
  personaName,
  refreshTrigger,
  embedded,
}: BuilderOverviewProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [modal, setModal] = useState<{ title: string; content: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);

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

  const openFile = useCallback(async (filename: string) => {
    if (!personaName || loadingFile) return;
    setLoadingFile(filename);
    try {
      const res = await fetch(
        `/api/personas/${encodeURIComponent(personaName)}/file?file=${encodeURIComponent(filename)}`
      );
      if (res.ok) {
        const { content } = await res.json();
        if (content != null) {
          setModal({ title: filename, content });
        }
      }
    } catch { /* ignore */ }
    setLoadingFile(null);
  }, [personaName, loadingFile]);

  if (!personaName || !data) return null;

  return (
    <div className={embedded ? "p-4" : "w-[380px] shrink-0 border-r border-border bg-surface backdrop-blur-[16px] overflow-y-auto p-4"}>
      {!embedded && (
        <h3 className="text-[13px] font-semibold text-accent uppercase tracking-wider mb-3.5">
          Persona Overview
        </h3>
      )}

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

      {/* Persona files */}
      {data.files.map((file) => (
        <div
          key={file.name}
          className="mb-2.5 border border-border rounded-lg overflow-hidden"
        >
          <div
            className={`flex items-center gap-2 px-2.5 py-2 bg-surface-light text-[13px] select-none transition-colors duration-fast ${
              file.exists
                ? "cursor-pointer hover:bg-[rgba(31,47,80,0.9)]"
                : "opacity-50"
            }`}
            onClick={() => file.exists && openFile(file.name)}
          >
            <span
              className={`shrink-0 text-xs ${
                file.exists ? "text-success" : "text-error opacity-50"
              }`}
            >
              {file.exists ? "\u2713" : "\u2717"}
            </span>
            <span className="flex-1">{file.name}</span>
            {file.exists && loadingFile === file.name && (
              <span className="text-[10px] text-text-dim animate-pulse">...</span>
            )}
          </div>
        </div>
      ))}

      {/* Panels */}
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

      {/* Data files */}
      {data.dataFiles && data.dataFiles.length > 0 && (
        <div className="mb-2.5">
          <h4 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-1.5">
            Data Files ({data.dataFiles.length})
          </h4>
          <div className="flex flex-col gap-2">
            {data.dataFiles.map((df) => (
              <div
                key={df.filename}
                className="border border-border rounded-lg overflow-hidden"
              >
                <div
                  className="flex items-center gap-2 px-2.5 py-2 bg-surface-light cursor-pointer text-[13px] select-none hover:bg-[rgba(31,47,80,0.9)] transition-colors duration-fast"
                  onClick={() => openFile(df.filename)}
                >
                  <span className="text-xs text-accent/70">{ }</span>
                  <span className="flex-1 font-medium">{df.filename}</span>
                  <span className="text-[10px] text-text-dim/60 truncate max-w-[120px]">
                    {df.keys.join(", ")}
                  </span>
                  {loadingFile === df.filename && (
                    <span className="text-[10px] text-text-dim animate-pulse">...</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skills */}
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

      {/* File viewer modal — portal to body to escape backdrop-blur stacking context */}
      {modal && createPortal(
        <FileViewerModal
          title={modal.title}
          content={modal.content}
          onClose={() => setModal(null)}
        />,
        document.body
      )}
    </div>
  );
}
