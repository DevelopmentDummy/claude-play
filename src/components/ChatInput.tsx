"use client";

import { useRef, useCallback, useEffect } from "react";

export interface Choice {
  text: string;
  score: number;
}

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
  choices?: Choice[];
}

export default function ChatInput({ disabled, onSend, choices }: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value.trim();
    if (!text) return;
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
      <div className="flex gap-2 px-4 py-3">
      <textarea
        ref={inputRef}
        disabled={disabled}
        placeholder="Type a message..."
        rows={1}
        className="flex-1 px-3.5 py-2.5 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm resize-none outline-none max-h-[150px] transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
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
