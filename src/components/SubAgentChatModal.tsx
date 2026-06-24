"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { TranscriptEntry } from "@/lib/subagent-transcript";

interface SubInfo {
  name: string;
  role: string;
  provider: string;
  model?: string;
  running: boolean;
}

export interface SubAgentChatModalProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  /** Latest live transcript entry pushed over WS (Task 6 forwards subagent:message). */
  liveEntry?: { name: string; entry: TranscriptEntry } | null;
  /** Currently focused sub in the sidebar (lifted to page for unread tracking). */
  activeSubName: string | null;
  onActiveSubChange: (name: string) => void;
}

export default function SubAgentChatModal({
  sessionId, open, onClose, liveEntry, activeSubName, onActiveSubChange,
}: SubAgentChatModalProps) {
  const [subs, setSubs] = useState<SubInfo[]>([]);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeSubNameRef = useRef(activeSubName);
  activeSubNameRef.current = activeSubName;
  const onActiveSubChangeRef = useRef(onActiveSubChange);
  onActiveSubChangeRef.current = onActiveSubChange;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while an IME composition (Korean etc.) is in progress — guards Enter-to-send
  // against firing on the composition-confirming Enter keystroke.
  const composingRef = useRef(false);

  useEscapeKey(onClose, open);

  // Load sub list when opened.
  useEffect(() => {
    if (!open) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`)
      .then((r) => r.json())
      .then((d) => {
        const list: SubInfo[] = d.subs || [];
        setSubs(list);
        if (!activeSubNameRef.current && list.length > 0) onActiveSubChangeRef.current(list[0].name);
      })
      .catch(() => {});
  }, [open, sessionId]);

  // Load transcript when the focused sub changes (or modal opens).
  useEffect(() => {
    if (!open || !activeSubName) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(activeSubName)}/transcript?n=200`)
      .then((r) => r.json())
      .then((d) => setEntries(d.entries || []))
      .catch(() => setEntries([]));
  }, [open, sessionId, activeSubName]);

  // Append live entries for the focused sub.
  useEffect(() => {
    if (!liveEntry || liveEntry.name !== activeSubNameRef.current) return;
    setEntries((prev) => [...prev, liveEntry.entry]);
  }, [liveEntry]);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeSubName || sending) return;
    setSending(true);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(activeSubName)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch { /* ignore */ } finally {
      setSending(false);
    }
  }, [input, activeSubName, sending, sessionId]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[4px]" onClick={onClose} />
      <div
        className="relative z-[9999] w-full max-w-[900px] h-[80vh] flex rounded-2xl overflow-hidden border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
        style={{ backgroundColor: "var(--surface, rgb(15,15,26))" }}
      >
        {/* Sidebar */}
        <div className="w-[200px] shrink-0 border-r border-white/[0.06] flex flex-col">
          <div className="px-4 py-3 border-b border-white/[0.06] text-[12px] font-semibold uppercase tracking-wider"
               style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}>
            서브에이전트
          </div>
          <div className="flex-1 overflow-y-auto">
            {subs.length === 0 && (
              <div className="px-4 py-3 text-xs text-text-dim">등록된 서브가 없습니다.</div>
            )}
            {subs.map((s) => (
              <button
                key={s.name}
                onClick={() => onActiveSubChange(s.name)}
                className={`w-full text-left px-4 py-2.5 text-xs transition-colors ${
                  s.name === activeSubName ? "bg-white/[0.06] text-text" : "text-text-dim hover:bg-white/[0.03]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${s.running ? "bg-success" : "bg-error"}`} />
                  <span className="truncate font-medium">{s.name}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-text-dim/70 truncate">{s.provider}{s.model ? ` · ${s.model}` : ""}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Transcript + input */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <span className="text-sm font-medium truncate">{activeSubName || "—"}</span>
            <button onClick={onClose} aria-label="닫기" className="text-white/40 hover:text-white/80 p-1">✕</button>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
            {entries.map((e, i) => <TranscriptRow key={`${e.ts}-${i}`} e={e} />)}
          </div>
          <div className="flex items-end gap-2 px-4 py-3 border-t border-white/[0.06]">
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(ev) => {
                setInput(ev.target.value);
                const el = ev.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 120) + "px";
              }}
              onKeyDown={(ev) => {
                // Enter sends; Shift+Enter inserts a newline. Skip while IME composing (Korean etc.).
                if (ev.nativeEvent.isComposing || composingRef.current || ev.keyCode === 229) return;
                if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); void handleSend(); }
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={activeSubName ? `${activeSubName}에게 직접 말하기… (Shift+Enter 줄바꿈)` : "서브를 선택하세요"}
              disabled={!activeSubName || sending}
              className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-text outline-none resize-none max-h-[120px] focus:border-accent/60"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || !activeSubName || sending}
              className="px-3 py-2 rounded-lg text-sm bg-accent/20 text-accent border border-accent/40 disabled:opacity-30"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TranscriptRow({ e }: { e: TranscriptEntry }) {
  // operator dispatch → right bubble; response → left bubble;
  // auto/hook/delegate dispatch → faint system line; report → →메인 chip.
  if (e.kind === "report") {
    return (
      <div className="text-[11px] text-amber-300/80 italic">→메인: {e.text}</div>
    );
  }
  if (e.kind === "dispatch" && e.origin !== "operator") {
    return (
      <div className="text-[11px] text-text-dim/60 italic truncate" title={e.text}>
        ⟳ {e.origin}: {e.text}
      </div>
    );
  }
  const isOperator = e.kind === "dispatch" && e.origin === "operator";
  return (
    <div className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
          isOperator ? "bg-accent/20 text-text" : "bg-white/[0.05] text-text"
        }`}
      >
        {e.text}
      </div>
    </div>
  );
}
