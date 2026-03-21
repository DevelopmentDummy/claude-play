"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import VoiceSettings from "@/components/VoiceSettings";

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

interface WritingStyle {
  name: string;
  content: string;
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

  // Writing style state
  const [allStyles, setAllStyles] = useState<WritingStyle[]>([]);
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  const [editingStyleName, setEditingStyleName] = useState("");
  const [editingStyleContent, setEditingStyleContent] = useState("");
  const [editingStyleOrigName, setEditingStyleOrigName] = useState<string | null>(null);

  const loadStyles = useCallback(async () => {
    try {
      const res = await fetch("/api/styles");
      if (res.ok) setAllStyles(await res.json());
    } catch { /* ignore */ }
  }, []);

  const loadSelectedStyle = useCallback(async () => {
    if (!personaName) return;
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(personaName)}/file?file=style.json`);
      if (res.ok) {
        const { content } = await res.json();
        if (content) {
          const parsed = typeof content === "string" ? JSON.parse(content) : content;
          setSelectedStyle(parsed.style || null);
        }
      }
    } catch { setSelectedStyle(null); }
  }, [personaName]);

  const saveSelectedStyle = useCallback(async (styleName: string | null) => {
    if (!personaName) return;
    setSelectedStyle(styleName);
    await fetch(`/api/personas/${encodeURIComponent(personaName)}/file?file=style.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify({ style: styleName }) }),
    });
  }, [personaName]);

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
    loadStyles();
    loadSelectedStyle();
  }, [refresh, refreshTrigger, loadStyles, loadSelectedStyle]);

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
              className="w-full rounded-xl border border-white/[0.06] object-contain"
              style={{ maxHeight: "360px" }}
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

      {/* Writing Style */}
      <div className="mb-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider">
            Writing Style
          </h4>
          <button
            onClick={() => {
              setEditingStyleOrigName(null);
              setEditingStyleName("");
              setEditingStyleContent("");
              setStyleEditorOpen(true);
            }}
            className="text-[10px] text-accent/70 hover:text-accent transition-colors"
          >
            + 새 문체
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {/* No style option */}
          <button
            onClick={() => saveSelectedStyle(null)}
            className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-all ${
              selectedStyle === null
                ? "border-accent/50 bg-[rgba(var(--accent-rgb),0.08)] text-text"
                : "border-border/40 bg-transparent text-text-dim hover:border-border/60"
            }`}
          >
            없음
          </button>
          {allStyles.map((s) => (
            <div key={s.name} className="flex gap-1">
              <button
                onClick={() => saveSelectedStyle(s.name)}
                className={`flex-1 text-left px-3 py-2 rounded-lg border text-xs transition-all truncate ${
                  selectedStyle === s.name
                    ? "border-accent/50 bg-[rgba(var(--accent-rgb),0.08)] text-text"
                    : "border-border/40 bg-transparent text-text-dim hover:border-border/60"
                }`}
                title={s.content.slice(0, 100)}
              >
                {s.name}
              </button>
              <button
                onClick={() => {
                  setEditingStyleOrigName(s.name);
                  setEditingStyleName(s.name);
                  setEditingStyleContent(s.content);
                  setStyleEditorOpen(true);
                }}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-text-dim/40 hover:text-text hover:bg-white/5 transition-all text-xs self-center"
                title="편집"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Style Editor Modal */}
      {styleEditorOpen && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setStyleEditorOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text">
                {editingStyleOrigName ? "문체 편집" : "새 문체"}
              </h2>
              <button onClick={() => setStyleEditorOpen(false)} className="text-text-dim hover:text-text transition-colors text-lg leading-none">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <input
                type="text"
                value={editingStyleName}
                onChange={(e) => setEditingStyleName(e.target.value)}
                placeholder="문체 이름"
                className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none focus:border-accent"
                autoFocus
              />
              <textarea
                value={editingStyleContent}
                onChange={(e) => setEditingStyleContent(e.target.value)}
                placeholder="문체 지시문을 작성하세요...&#10;예: 서정적이고 감성적인 문장을 사용하며, 비유와 은유를 자주 활용합니다..."
                rows={10}
                className="w-full px-3 py-2 rounded-lg border border-border bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none resize-none focus:border-accent"
              />
            </div>
            <div className="flex justify-between items-center px-5 py-3 border-t border-border">
              {editingStyleOrigName && (
                <button
                  onClick={async () => {
                    await fetch(`/api/styles?name=${encodeURIComponent(editingStyleOrigName)}`, { method: "DELETE" });
                    if (selectedStyle === editingStyleOrigName) await saveSelectedStyle(null);
                    await loadStyles();
                    setStyleEditorOpen(false);
                  }}
                  className="px-3 py-1.5 rounded-lg text-sm text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 transition-all"
                >
                  삭제
                </button>
              )}
              <div className="flex-1" />
              <div className="flex gap-2">
                <button
                  onClick={() => setStyleEditorOpen(false)}
                  className="px-3 py-1.5 rounded-lg text-sm text-text-dim hover:text-text border border-border/50 hover:border-border transition-all"
                >
                  취소
                </button>
                <button
                  onClick={async () => {
                    if (!editingStyleName.trim()) return;
                    // If renaming, delete old
                    if (editingStyleOrigName && editingStyleOrigName !== editingStyleName.trim()) {
                      await fetch(`/api/styles?name=${encodeURIComponent(editingStyleOrigName)}`, { method: "DELETE" });
                      if (selectedStyle === editingStyleOrigName) await saveSelectedStyle(editingStyleName.trim());
                    }
                    await fetch("/api/styles", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: editingStyleName.trim(), content: editingStyleContent }),
                    });
                    await loadStyles();
                    setStyleEditorOpen(false);
                  }}
                  disabled={!editingStyleName.trim()}
                  className="px-3 py-1.5 rounded-lg text-sm text-white bg-accent hover:bg-accent-hover transition-all disabled:opacity-50"
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Voice Settings */}
      <div className="mb-2.5">
        <VoiceSettings personaName={personaName} refreshTrigger={refreshTrigger} />
      </div>

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
