"use client";

import { useEffect, useState } from "react";

interface ConversationListItem {
  conversationId: string;
  provider: "claude" | "codex" | "gemini";
  filePath: string;
  sizeBytes: number;
  mtime: number;
  lastMessage: { role: "user" | "assistant"; preview: string } | null;
  isCurrent: boolean;
}

interface ConversationsResponse {
  provider: "claude" | "codex" | "gemini";
  currentId: string | null;
  items: ConversationListItem[];
}

interface SessionListModalProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}

const PROVIDER_BADGE: Record<ConversationListItem["provider"], string> = {
  claude: "bg-[#4a2a1a]/60 text-[#ff9f43]/80 border-[#ff9f43]/15",
  codex: "bg-[#2a5a3a]/60 text-[#4dff91]/80 border-[#4dff91]/15",
  gemini: "bg-[#1a3a5c]/60 text-[#64b5f6]/80 border-[#64b5f6]/15",
};

const PROVIDER_LABEL: Record<ConversationListItem["provider"], string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "방금";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}주 전`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export default function SessionListModal({ open, onClose, sessionId }: SessionListModalProps) {
  const [data, setData] = useState<ConversationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relinking, setRelinking] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!sessionId) return;
    setData(null);
    setError(null);
    const ctrl = new AbortController();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/conversations`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => setData(j as ConversationsResponse))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handlePick = async (conversationId: string) => {
    if (relinking) return;
    setRelinking(conversationId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/relink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(`연결 실패: ${j.error || res.statusText}`);
        setRelinking(null);
        return;
      }
      // Reload — server tore down the live instance, so the chat page's
      // /open call on mount will spawn a fresh process with --resume <new id>.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRelinking(null);
    }
  };

  const items = data?.items ?? null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[8px] flex items-center justify-center z-[110]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-[min(640px,92vw)] max-h-[80vh] bg-[#14141a] border border-white/[0.08]
        rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-medium text-text">이전 세션 불러오기</h2>
            <p className="text-[10px] text-text-mute mt-0.5">
              이 채팅 폴더에서 시작된 모든 대화입니다. 항목을 누르면 해당 대화로 다시 연결됩니다.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-dim hover:text-text text-lg leading-none px-2 cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-2">
          {error && (
            <div className="px-3 py-3 mx-1 mb-2 text-xs text-error border border-error/30 bg-error/10 rounded-md">
              {error}
            </div>
          )}
          {!error && items === null && (
            <div className="px-3 py-4 text-xs text-text-dim">로딩 중…</div>
          )}
          {items && items.length === 0 && (
            <div className="px-3 py-6 text-xs text-text-dim text-center">
              대화 기록이 없습니다.
              {data?.provider === "gemini" && (
                <div className="mt-1 text-text-mute">(Gemini는 아직 미지원)</div>
              )}
            </div>
          )}
          {items && items.map((it) => {
            const isPicking = relinking === it.conversationId;
            const disabled = it.isCurrent || relinking !== null;
            return (
              <button
                key={it.conversationId}
                type="button"
                onClick={() => { if (!it.isCurrent) handlePick(it.conversationId); }}
                disabled={disabled}
                className={`w-full text-left px-3 py-2.5 rounded-lg flex flex-col gap-1
                  transition-colors duration-fast border border-transparent
                  ${it.isCurrent
                    ? "bg-accent/5 border-accent/20 cursor-default"
                    : disabled
                      ? "opacity-50 cursor-default"
                      : "hover:bg-plum-soft hover:border-white/[0.08] cursor-pointer"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-text-dim truncate flex-1">
                    {shortId(it.conversationId)}
                  </span>
                  {it.isCurrent && (
                    <span className="text-[9px] text-accent border border-accent/40 rounded px-1 py-0">
                      ✓ 현재 연결됨
                    </span>
                  )}
                  {isPicking && (
                    <span className="text-[9px] text-warning border border-warning/40 rounded px-1 py-0">
                      연결 중…
                    </span>
                  )}
                  <span className={`inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold border ${PROVIDER_BADGE[it.provider]}`}>
                    {PROVIDER_LABEL[it.provider]}
                  </span>
                </div>
                {it.lastMessage && (
                  <div className="text-[11px] text-text-mute truncate">
                    <span className="text-text-dim/80">{it.lastMessage.role === "user" ? "나" : "AI"}:</span>{" "}
                    {it.lastMessage.preview}
                  </div>
                )}
                <div className="text-[10px] text-text-mute flex items-center gap-2">
                  <span>{relativeTime(it.mtime)}</span>
                  <span className="w-[3px] h-[3px] rounded-full bg-white/30" />
                  <span>{formatSize(it.sizeBytes)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
