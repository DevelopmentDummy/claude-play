"use client";

import { useState, useEffect, useRef } from "react";

interface VoiceSettingsProps {
  personaName: string;
  accentColor?: string;
}

export default function VoiceSettings({ personaName, accentColor = "var(--accent)" }: VoiceSettingsProps) {
  const [config, setConfig] = useState({
    enabled: false,
    referenceAudio: "",
    design: "",
    language: "ko",
    speed: 1.0,
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const enc = encodeURIComponent(personaName);

  useEffect(() => {
    fetch(`/api/personas/${enc}/voice`)
      .then((r) => r.json())
      .then((data) => setConfig((prev) => ({ ...prev, ...data })))
      .catch(() => {});
  }, [enc]);

  async function saveConfig(updated: typeof config) {
    setConfig(updated);
    setSaving(true);
    await fetch(`/api/personas/${enc}/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    }).catch(() => {});
    setSaving(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append("audio", file);
    const res = await fetch(`/api/personas/${enc}/voice/upload`, {
      method: "POST",
      body: form,
    }).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      setConfig((prev) => ({ ...prev, referenceAudio: data.filename, enabled: true }));
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleDeleteRef() {
    await fetch(`/api/personas/${enc}/voice/upload`, { method: "DELETE" }).catch(() => {});
    setConfig((prev) => ({ ...prev, referenceAudio: "" }));
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: `${accentColor}06`, border: `1px solid ${accentColor}15` }}
    >
      <div
        className="px-3.5 py-2 border-b flex items-center justify-between"
        style={{ borderColor: `${accentColor}12` }}
      >
        <span
          className="text-[10px] font-medium uppercase tracking-widest"
          style={{ color: `${accentColor}90` }}
        >
          Voice
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => saveConfig({ ...config, enabled: e.target.checked })}
            className="w-3 h-3 accent-[var(--accent)]"
          />
          <span className="text-[10px] text-text-dim">Enable</span>
        </label>
      </div>

      <div className="px-3.5 py-3 space-y-3">
        {/* Reference Audio */}
        <div>
          <label className="text-[10px] text-text-dim/70 block mb-1">Reference Audio (3-30s)</label>
          {config.referenceAudio ? (
            <div className="flex items-center gap-2">
              <audio
                src={`/api/personas/${enc}/voice/upload`}
                controls
                className="h-7 flex-1"
                style={{ maxWidth: "220px" }}
              />
              <span className="text-[10px] text-text-dim truncate max-w-[100px]">
                {config.referenceAudio}
              </span>
              <button
                onClick={handleDeleteRef}
                className="text-[10px] text-error/70 hover:text-error transition-colors shrink-0"
              >
                Remove
              </button>
            </div>
          ) : (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".wav,.mp3,.ogg,.flac"
                onChange={handleUpload}
                className="hidden"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="px-3 py-1.5 text-[11px] rounded-lg border border-dashed transition-all
                  border-border/40 text-text-dim/60 hover:border-accent/60 hover:text-accent disabled:opacity-50"
              >
                {uploading ? "Uploading..." : "Upload audio file"}
              </button>
            </div>
          )}
        </div>

        {/* Voice Design Prompt */}
        <div>
          <label className="text-[10px] text-text-dim/70 block mb-1">Voice Design</label>
          <input
            type="text"
            value={config.design}
            onChange={(e) => setConfig({ ...config, design: e.target.value })}
            onBlur={() => saveConfig(config)}
            placeholder="e.g. 차갑고 낮은 톤의 성인 여성"
            className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
              outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30"
          />
          <p className="text-[9px] text-text-dim/40 mt-0.5">Reference audio가 없을 때 사용</p>
        </div>

        {/* Language & Speed */}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-[10px] text-text-dim/70 block mb-1">Language</label>
            <select
              value={config.language}
              onChange={(e) => saveConfig({ ...config, language: e.target.value })}
              className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                outline-none cursor-pointer appearance-none"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 6px center",
                paddingRight: "18px",
              }}
            >
              <option value="ko" className="bg-[#1a1a2e] text-[#ccc]">Korean</option>
              <option value="en" className="bg-[#1a1a2e] text-[#ccc]">English</option>
              <option value="ja" className="bg-[#1a1a2e] text-[#ccc]">Japanese</option>
              <option value="zh" className="bg-[#1a1a2e] text-[#ccc]">Chinese</option>
            </select>
          </div>
          <div className="w-20">
            <label className="text-[10px] text-text-dim/70 block mb-1">Speed</label>
            <input
              type="number"
              min={0.5}
              max={2.0}
              step={0.1}
              value={config.speed}
              onChange={(e) => saveConfig({ ...config, speed: parseFloat(e.target.value) || 1.0 })}
              className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                outline-none focus:border-accent/60 transition-colors"
            />
          </div>
        </div>

        {saving && <p className="text-[9px] text-accent/60">Saving...</p>}
      </div>
    </div>
  );
}
