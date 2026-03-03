"use client";

import { useState, useRef } from "react";

interface ProfileOption {
  slug: string;
  name: string;
}

interface ProfileSelectDialogProps {
  open: boolean;
  personaDisplayName: string;
  profiles: ProfileOption[];
  onClose: () => void;
  onStart: (profileSlug?: string) => void;
  onCreateProfile: (name: string, description: string) => Promise<ProfileOption>;
}

export default function ProfileSelectDialog({
  open,
  personaDisplayName,
  profiles,
  onClose,
  onStart,
  onCreateProfile,
}: ProfileSelectDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"select" | "create">("select");
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  if (!open) return null;

  const handleStart = async () => {
    if (mode === "create") {
      const name = nameRef.current?.value.trim();
      if (!name) return;
      const description = descRef.current?.value.trim() || "";
      const profile = await onCreateProfile(name, description);
      onStart(profile.slug);
    } else {
      onStart(selected ?? undefined);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[8px] flex items-center justify-center z-[100]">
      <div className="bg-surface backdrop-blur-[16px] border border-border rounded-2xl p-6 px-7 w-[440px] flex flex-col gap-4 shadow-lg animate-[slideUp_0.25s_ease-out]">
        <h3 className="text-base font-semibold">
          Start session with {personaDisplayName}
        </h3>
        <p className="text-xs text-text-dim -mt-2">
          Select a user profile or start without one.
        </p>

        {mode === "select" ? (
          <>
            <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
              {/* No profile option */}
              <label className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-surface-light transition-colors duration-fast">
                <input
                  type="radio"
                  name="profile"
                  checked={selected === null}
                  onChange={() => setSelected(null)}
                  className="accent-[var(--accent)]"
                />
                <span className="text-sm text-text-dim">No profile</span>
              </label>

              {profiles.map((p) => (
                <label
                  key={p.slug}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-surface-light transition-colors duration-fast"
                >
                  <input
                    type="radio"
                    name="profile"
                    checked={selected === p.slug}
                    onChange={() => setSelected(p.slug)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-sm">{p.name}</span>
                </label>
              ))}
            </div>

            <button
              onClick={() => setMode("create")}
              className="text-xs text-text-dim hover:text-text transition-colors duration-fast text-left"
            >
              + Create new profile
            </button>
          </>
        ) : (
          <>
            <input
              ref={nameRef}
              type="text"
              placeholder="Name (e.g. 카이엔, Kai)"
              className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
              autoFocus
            />
            <textarea
              ref={descRef}
              placeholder="Description (character background for AI)"
              rows={3}
              className="px-3.5 py-2.5 border border-border rounded-[10px] bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm outline-none resize-y transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
            />
            <button
              onClick={() => setMode("select")}
              className="text-xs text-text-dim hover:text-text transition-colors duration-fast text-left"
            >
              &larr; Back to profile list
            </button>
          </>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 border border-border rounded-md bg-transparent text-text-dim cursor-pointer text-xs hover:bg-surface-light hover:text-text transition-all duration-fast"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="px-3 py-1 border border-accent rounded-md bg-accent text-white cursor-pointer text-xs shadow-[0_2px_12px_var(--accent-glow)] hover:bg-accent-hover hover:-translate-y-px transition-all duration-fast"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
