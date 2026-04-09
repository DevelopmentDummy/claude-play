"use client";

import { useState, useEffect } from "react";

interface Props {
  open: boolean;
  personaName: string;
  onClose: () => void;
  onOpenBuilder: (name: string, initialMessage: string) => void;
}

export default function PublishPersonaModal({ open, personaName, onClose, onOpenBuilder }: Props) {
  const [url, setUrl] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Reset all state when modal closes
  useEffect(() => {
    if (!open) {
      setUrl("");
      setPublishing(false);
      setError("");
      setSuccess(false);
    }
  }, [open]);

  const handlePush = async () => {
    if (!url.trim()) return;
    setPublishing(true);
    setError("");
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(personaName)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to publish (${res.status})`);
      }
      setSuccess(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setPublishing(false);
    }
  };

  const handleBuilder = () => {
    onOpenBuilder(
      personaName,
      "이 페르소나를 GitHub에 퍼블리시해줘. 리포 생성, remote 설정, persona.json 생성, .gitignore 확인, push까지 진행해줘."
    );
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] z-[100] flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md p-6 space-y-5 animate-[slideUp_0.25s_ease-out]">
        {/* Header */}
        <h3 className="text-sm font-semibold text-text">GitHub에 퍼블리시</h3>

        {/* Option A: URL direct input */}
        <div className="space-y-2">
          <label className="text-xs text-text-dim">리포지토리 URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo"
              disabled={publishing || success}
              className="flex-1 px-3 py-2 rounded-lg bg-surface-light border border-border text-sm text-text placeholder:text-text-dim/50 outline-none focus:border-accent/50 transition-colors disabled:opacity-50"
              onKeyDown={(e) => { if (e.key === "Enter") handlePush(); }}
            />
            {success ? (
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                완료
              </button>
            ) : (
              <button
                onClick={handlePush}
                disabled={!url.trim() || publishing}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 cursor-pointer hover:bg-accent/80 transition-colors"
              >
                {publishing ? "전송 중..." : "Push"}
              </button>
            )}
          </div>
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-text-dim">또는</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Option B: Builder session */}
        <button
          onClick={handleBuilder}
          className="w-full px-4 py-3 rounded-xl border border-border text-text hover:bg-surface-light transition-all duration-fast text-left cursor-pointer"
        >
          <div className="text-sm font-medium">빌더 세션으로 진행</div>
          <div className="text-xs text-text-dim mt-0.5">AI가 리포 생성, 설정, push까지 처리합니다</div>
        </button>
      </div>
    </div>
  );
}
