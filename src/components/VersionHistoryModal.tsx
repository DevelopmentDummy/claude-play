"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface Version {
  hash: string;
  date: string;
  message: string;
}

interface VersionHistoryModalProps {
  personaName: string;
  onClose: () => void;
  onRestored: () => void;
}

export default function VersionHistoryModal({
  personaName,
  onClose,
  onRestored,
}: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/personas/${encodeURIComponent(personaName)}/versions`
      );
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions || []);
      }
    } catch {
      setError("Failed to load versions");
    }
    setLoading(false);
  }, [personaName]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleRestore = async (hash: string) => {
    if (restoring) return;
    setRestoring(hash);
    setError(null);
    try {
      const res = await fetch(
        `/api/personas/${encodeURIComponent(personaName)}/versions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash }),
        }
      );
      const data = await res.json();
      if (data.ok) {
        onRestored();
        onClose();
      } else {
        setError(data.error || "Restore failed");
      }
    } catch {
      setError("Restore failed");
    }
    setRestoring(null);
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="fixed inset-4 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-[520px] max-h-[80vh] flex flex-col bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
            <span className="text-sm font-semibold text-text">
              Version History
            </span>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim hover:text-text hover:bg-surface-light transition-colors text-sm cursor-pointer"
            >
              &times;
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="px-5 py-2 text-xs text-error bg-error/10 border-b border-error/20">
              {error}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center text-text-dim text-sm">
                Loading...
              </div>
            ) : versions.length === 0 ? (
              <div className="p-8 text-center text-text-dim text-sm">
                No versions saved yet
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {versions.map((v, i) => (
                  <div
                    key={v.hash}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-surface-light/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text truncate">
                        {v.message}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-text-dim/60 font-mono">
                          {v.hash.slice(0, 7)}
                        </span>
                        <span className="text-[11px] text-text-dim/50">
                          {formatDate(v.date)}
                        </span>
                      </div>
                    </div>
                    {i > 0 && (
                      <button
                        onClick={() => handleRestore(v.hash)}
                        disabled={restoring !== null}
                        className="shrink-0 px-3 py-1.5 text-xs rounded-md border border-border cursor-pointer
                          text-text-dim hover:text-warning hover:border-warning/50 hover:bg-warning/5
                          disabled:opacity-30 disabled:cursor-default transition-all duration-fast"
                      >
                        {restoring === v.hash ? "..." : "Restore"}
                      </button>
                    )}
                    {i === 0 && (
                      <span className="shrink-0 text-[10px] text-accent/60 uppercase tracking-wider font-semibold">
                        Current
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
