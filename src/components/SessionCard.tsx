"use client";

import { useState, useRef, useEffect } from "react";

const SESSION_GRADIENTS = [
  { from: "#2a1a3a", to: "#1a1028" },
  { from: "#3a2a1a", to: "#28180a" },
  { from: "#1a2a3a", to: "#0a1828" },
  { from: "#2a3a1a", to: "#182810" },
  { from: "#3a1a28", to: "#28101a" },
  { from: "#2a1a2a", to: "#1a081a" },
];

interface SessionCardProps {
  id: string;
  title: string;
  persona: string;
  createdAt: string;
  lastActivity?: number;
  hasIcon?: boolean;
  model?: string;
  personaIndex?: number;
  /** 사용자가 직접 쓴 메모 */
  memo?: string;
  /** 세션 AI가 갱신한 자동 요약 */
  autoMemo?: string;
  /** 메모가 둘 다 없을 때 쓰는 최근 발화 프리뷰 */
  memoFallback?: string;
  onMemoSave: (memo: string) => Promise<boolean>;
  onOpen: () => void;
  onDelete: () => void;
}

function providerInfo(model?: string): { label: string; cls: string; mark?: "kimi" } | null {
  if (!model) return null;
  const lower = model.split(":")[0].toLowerCase();
  if (lower === "kimi-auto" || lower.startsWith("kimi-") || lower.startsWith("moonshot-ai/kimi-"))
    return { label: "Kimi", mark: "kimi", cls: "bg-[#173735]/70 text-[#74f5dc]/90 border-[#74f5dc]/20 shadow-[0_0_14px_rgba(116,245,220,0.10)]" };
  if (/^(gpt-5|codex-mini|o3|o4)/.test(lower))
    return { label: "Codex", cls: "bg-[#2a5a3a]/60 text-[#4dff91]/80 border-[#4dff91]/15" };
  if (/^gemini/.test(lower))
    return { label: "Gemini", cls: "bg-[#1a3a5c]/60 text-[#64b5f6]/80 border-[#64b5f6]/15" };
  if (/(sonnet|opus|haiku|claude)/.test(lower))
    return { label: "Claude", cls: "bg-[#4a2a1a]/60 text-[#ff9f43]/80 border-[#ff9f43]/15" };
  return null;
}

function relativeTime(input: string | number): string {
  const t = typeof input === "number" ? input : new Date(input).getTime();
  const ms = Date.now() - t;
  if (ms < 0) return "방금";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}주 전`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function SessionCard({
  id,
  title,
  persona,
  createdAt,
  lastActivity,
  hasIcon,
  model,
  personaIndex = 0,
  memo,
  autoMemo,
  memoFallback,
  onMemoSave,
  onOpen,
  onDelete,
}: SessionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // 표시 우선순위: 수동 메모 → AI 자동 메모 → 최근 발화 프리뷰
  const shownMemo = memo || autoMemo || memoFallback || "";
  const isManual = !!memo;

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(memo || "");
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (next === (memo || "")) return;
    await onMemoSave(next);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) { onDelete(); return; }
    setConfirmDelete(true);
    timerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
  };

  const grad = SESSION_GRADIENTS[personaIndex % SESSION_GRADIENTS.length];
  const info = providerInfo(model);

  return (
    <div
      className="group relative mx-2 px-2.5 py-2.5 pr-8 rounded-lg cursor-pointer
        transition-all duration-fast flex items-center gap-2.5
        hover:bg-plum-soft"
      onClick={onOpen}
    >
      <div
        className="w-[34px] h-[34px] rounded-[9px] shrink-0 relative overflow-hidden border border-white/[0.06]"
        style={{
          background: hasIcon
            ? `url(/api/sessions/${id}/files/images/icon.png) center/cover no-repeat`
            : `linear-gradient(135deg, ${grad.from}, ${grad.to})`,
        }}
      >
        {!hasIcon && (
          <div className="absolute inset-0 flex items-center justify-center font-serif italic text-sm"
            style={{ color: "rgba(255,255,255,0.85)" }}>
            {persona.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text font-medium truncate leading-snug" style={{ letterSpacing: "-0.005em" }}>
          {title}
        </div>
        <div className="text-[10px] text-text-mute mt-0.5 flex items-center gap-1.5 truncate">
          <span className="truncate">{persona}</span>
          <span className="w-[3px] h-[3px] rounded-full bg-white/30 shrink-0" />
          <span className="shrink-0">{relativeTime(lastActivity ?? createdAt)}</span>
          {info ? (
            <span className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[8px] font-semibold tracking-wide border ${info.cls}`}>
              {info.mark === "kimi" && (
                <span className="relative inline-flex w-[7px] h-[7px] shrink-0" aria-hidden="true">
                  <span className="absolute inset-[1px] rounded-full bg-current opacity-90" />
                  <span className="absolute left-[-1px] top-[3px] w-[9px] h-[1px] rounded-full bg-current opacity-45 rotate-[-25deg]" />
                </span>
              )}
              {info.label}
            </span>
          ) : model ? (
            <span className="inline-flex items-center px-1 py-0 rounded text-[8px] font-medium tracking-wide text-text-mute">
              {model}
            </span>
          ) : null}
        </div>

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
            maxLength={200}
            placeholder="메모 입력…"
            className="mt-1 w-full bg-transparent border-b outline-none
              text-[10px] text-text placeholder:text-text-mute/60 py-0.5"
            style={{ borderColor: "var(--plum-hairline)" }}
          />
        ) : shownMemo ? (
          <div
            title={shownMemo}
            className={`text-[10px] mt-1 truncate ${
              isManual ? "text-text-dim border-l pl-1.5" : "text-text-mute italic"
            }`}
            style={isManual ? { borderColor: "var(--plum-hairline)" } : undefined}
          >
            {shownMemo}
          </div>
        ) : null}
      </div>

      {!confirmDelete && (
        <button
          onClick={startEdit}
          aria-label="메모 편집"
          title="메모 편집"
          className="absolute top-1.5 right-8 w-6 h-6 flex items-center justify-center rounded-md cursor-pointer
            text-[11px] text-text-dim/40 opacity-0 md:group-hover:opacity-100
            hover:text-text hover:bg-white/5 transition-all duration-fast"
        >
          ✎
        </button>
      )}

      <button
        onClick={handleDelete}
        aria-label="세션 삭제"
        className={`absolute top-1.5 right-1.5 flex items-center justify-center rounded-md cursor-pointer transition-all duration-fast
          ${confirmDelete
            ? "px-2 py-0.5 text-[10px] text-error bg-error/15 border border-error/30 opacity-100"
            : "w-6 h-6 text-sm text-text-dim/40 opacity-0 md:group-hover:opacity-100 hover:text-error hover:bg-error/10"
          }`}
      >
        {confirmDelete ? <span>삭제</span> : <>&times;</>}
      </button>
    </div>
  );
}
