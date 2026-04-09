"use client";

import { useState, useEffect } from "react";

interface ImportPreview {
  owner: string;
  repo: string;
  branch: string;
  displayName: string;
  description: string | null;
  tags: string[];
  version: string | null;
  author: string;
  icon: string | null;
  defaultFolderName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (name: string) => void;
  onOpenBuilder: (name: string, initialMessage: string) => void;
}

const SECURITY_REVIEW_MESSAGE =
  "이 페르소나는 외부에서 가져온 것입니다. 보안 점검을 진행해주세요. tools/*.js, hooks/on-message.js, panels/*.html의 위험 패턴과 session-instructions.md의 prompt injection 여부를 확인해주세요.";

export default function ImportPersonaModal({ open, onClose, onImported, onOpenBuilder }: Props) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [folderName, setFolderName] = useState("");
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState(false);

  // Reset all state when modal closes
  useEffect(() => {
    if (!open) {
      setUrl("");
      setPreview(null);
      setFolderName("");
      setLoading(false);
      setInstalling(false);
      setError("");
      setInstalled(false);
    }
  }, [open]);

  if (!open) return null;

  async function handlePreview() {
    setError("");
    setPreview(null);
    setLoading(true);
    try {
      const res = await fetch("/api/personas/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Failed to fetch preview (${res.status})`);
      }
      const data: ImportPreview = await res.json();
      setPreview(data);
      setFolderName(data.defaultFolderName);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall() {
    if (!preview) return;
    setError("");
    setInstalling(true);
    try {
      const res = await fetch("/api/personas/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, folderName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Install failed (${res.status})`);
      }
      setInstalled(true);
      onImported(folderName);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] z-[100] flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-6 space-y-4 animate-[slideUp_0.25s_ease-out]">
        <h2 className="text-lg font-semibold text-text">GitHub에서 페르소나 가져오기</h2>

        {/* Post-install state */}
        {installed ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-text text-sm">페르소나가 설치되었습니다!</p>
            </div>
            <p className="text-text-dim text-sm text-center">보안 점검을 진행할까요?</p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 rounded-lg bg-transparent border border-border text-text-dim hover:bg-surface-light transition-all duration-fast"
                onClick={onClose}
              >
                건너뛰기
              </button>
              <button
                className="px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
                onClick={() => onOpenBuilder(folderName, SECURITY_REVIEW_MESSAGE)}
              >
                빌더에서 점검하기
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* URL input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="flex-1 px-4 py-2.5 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
                onKeyDown={(e) => e.key === "Enter" && !loading && url && handlePreview()}
              />
              <button
                onClick={handlePreview}
                disabled={loading || !url}
                className="px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
              >
                {loading ? "불러오는 중..." : "미리보기"}
              </button>
            </div>

            {error && <p className="text-error text-sm">{error}</p>}

            {/* Preview card */}
            {preview && (
              <div className="space-y-3 border border-border rounded-xl p-4 bg-[rgba(15,15,26,0.3)]">
                <div className="flex items-start gap-3">
                  {/* Icon or initial letter */}
                  <div className="w-10 h-10 rounded-lg bg-surface-light border border-border/30 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {preview.icon ? (
                      <span className="text-xl">{preview.icon}</span>
                    ) : (
                      <span className="text-lg font-semibold text-text-dim">
                        {preview.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-text font-medium truncate">{preview.displayName}</h3>
                      {preview.version && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-light text-text-dim border border-border/30">
                          v{preview.version}
                        </span>
                      )}
                    </div>
                    <p className="text-text-dim text-xs">{preview.author}</p>
                  </div>
                </div>

                {preview.description && (
                  <p className="text-text-dim text-sm">{preview.description}</p>
                )}

                {preview.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {preview.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-0.5 rounded-full bg-surface-light text-text-dim border border-border/30"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* 폴더 이름 input */}
                <div className="space-y-1">
                  <label className="text-text-dim text-xs">폴더 이름</label>
                  <input
                    type="text"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    className="w-full px-4 py-2.5 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
                  />
                </div>

                <button
                  onClick={handleInstall}
                  disabled={installing || !folderName}
                  className="w-full px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
                >
                  {installing ? "설치 중..." : "설치"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
