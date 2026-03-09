"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export interface Choice {
  text: string;
  score: number;
}

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
  choices?: Choice[];
  showOOC?: boolean;
  onOOCToggle?: (on: boolean) => void;
}

export default function ChatInput({ disabled, onSend, choices, showOOC, onOOCToggle }: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [oocMode, setOocMode] = useState(false);
  const oocModeRef = useRef(oocMode);
  oocModeRef.current = oocMode;

  const handleSend = useCallback(() => {
    const raw = inputRef.current?.value.trim();
    if (!raw) return;
    const text = oocModeRef.current && !raw.startsWith("OOC:") ? `OOC: ${raw}` : raw;
    onSend(text);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
  }, [onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Refocus textarea when streaming ends (disabled → enabled)
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  const handleInput = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, []);

  const handleChoice = useCallback((text: string) => {
    onSend(text);
  }, [onSend]);

  const insertAtCursor = useCallback((text: string) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = el.value.substring(0, start);
    const after = el.value.substring(end);
    el.value = before + text + after;
    el.selectionStart = el.selectionEnd = start + text.length;
    el.focus();
    // Trigger height adjustment
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  // Listen for panel bridge fillInput events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text === "string") {
        insertAtCursor(text);
      }
    };
    window.addEventListener("__panel_fill_input", handler);
    return () => window.removeEventListener("__panel_fill_input", handler);
  }, [insertAtCursor]);

  const btnBase = "w-9 h-9 flex items-center justify-center rounded-lg border cursor-pointer text-xs font-medium shrink-0 transition-all duration-fast";

  return (
    <footer className="flex flex-col bg-surface backdrop-blur-[16px] border-t border-border shrink-0">
      {choices && choices.length > 0 && !disabled && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
          {choices.map((c, i) => (
            <button
              key={i}
              onClick={() => handleChoice(c.text)}
              className="px-3.5 py-2 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
                border border-border/60 cursor-pointer
                transition-all duration-fast
                hover:border-accent hover:bg-[rgba(var(--accent-rgb),0.08)] hover:-translate-y-px
                hover:shadow-[0_2px_12px_var(--accent-glow)]
                active:translate-y-0"
            >
              {c.text}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 px-4 py-3">
        {/* Left toolbar: OOC toggle + * insert */}
        <div className="flex gap-1 shrink-0 pb-0.5">
          <button
            onClick={() => {
              const next = !oocMode;
              setOocMode(next);
              onOOCToggle?.(next);
            }}
            className={`${btnBase} ${
              oocMode
                ? "border-yellow-500/60 text-yellow-400 bg-yellow-500/15"
                : showOOC
                  ? "border-yellow-500/30 text-yellow-400/60 bg-transparent hover:border-yellow-500/50 hover:text-yellow-400/80"
                  : "border-border/40 text-text-dim/40 bg-transparent hover:border-border/60 hover:text-text-dim/70"
            }`}
            title={oocMode ? "OOC 모드 끄기" : "OOC 모드 켜기"}
          >
            OOC
          </button>
          <button
            onClick={() => insertAtCursor("*")}
            className={`${btnBase} border-border/40 text-text-dim/50 bg-transparent hover:border-border/60 hover:text-text-dim/80`}
            title="* 삽입 (행동 묘사)"
          >
            *
          </button>
        </div>
        <textarea
          ref={inputRef}
          disabled={disabled}
          placeholder={oocMode ? "OOC 메시지..." : "Type a message..."}
          rows={1}
          className={`flex-1 px-3.5 py-2.5 border rounded-xl bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm resize-none outline-none max-h-[150px] transition-all duration-fast focus:shadow-[0_0_0_3px_var(--accent-glow)] ${
            oocMode
              ? "border-yellow-500/40 focus:border-yellow-500/60"
              : "border-border focus:border-accent"
          }`}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          autoFocus
        />
        <button
          disabled={disabled}
          onClick={handleSend}
          className="px-5 py-2.5 border-none rounded-xl bg-accent text-white cursor-pointer text-sm font-medium shrink-0 shadow-[0_2px_12px_var(--accent-glow)] transition-all duration-fast hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_20px_var(--accent-glow)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
        >
          Send
        </button>
      </div>
    </footer>
  );
}
