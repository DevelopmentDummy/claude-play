"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface VoiceSettingsProps {
  personaName: string;
  accentColor?: string;
  refreshTrigger?: number;
}

const EDGE_VOICES = [
  { id: "ko-KR-SunHiNeural", label: "선히 (여성)", lang: "ko" },
  { id: "ko-KR-InJoonNeural", label: "인준 (남성)", lang: "ko" },
  { id: "ko-KR-HyunsuMultilingualNeural", label: "현수 (남성, 다국어)", lang: "ko" },
  { id: "en-US-AriaNeural", label: "Aria (F)", lang: "en" },
  { id: "en-US-GuyNeural", label: "Guy (M)", lang: "en" },
  { id: "ja-JP-NanamiNeural", label: "七海 (女性)", lang: "ja" },
  { id: "ja-JP-KeitaNeural", label: "圭太 (男性)", lang: "ja" },
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 (女)", lang: "zh" },
  { id: "zh-CN-YunjianNeural", label: "云健 (男)", lang: "zh" },
];

export default function VoiceSettings({ personaName, accentColor = "var(--accent)", refreshTrigger = 0 }: VoiceSettingsProps) {
  const [config, setConfig] = useState({
    enabled: false,
    ttsProvider: "comfyui" as "comfyui" | "edge",
    // Edge TTS fields
    edgeVoice: "ko-KR-SunHiNeural",
    edgeRate: "",
    edgePitch: "",
    // ComfyUI fields
    referenceAudio: "",
    referenceText: "",
    design: "",
    language: "ko",
    voiceFile: "",
    chunkDelay: 500,
    modelSize: "1.7B",
  });
  const [localTtsAvailable, setLocalTtsAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [testText, setTestText] = useState("");
  const [testAudioUrl, setTestAudioUrl] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "generating" | "error">("idle");
  const fileRef = useRef<HTMLInputElement>(null);
  const testAudioRef = useRef<HTMLAudioElement>(null);
  const enc = encodeURIComponent(personaName);

  // YouTube modal state
  const [ytModal, setYtModal] = useState(false);
  const [ytUrl, setYtUrl] = useState("");
  const [ytStart, setYtStart] = useState("0");
  const [ytEnd, setYtEnd] = useState("30");
  const [ytLoading, setYtLoading] = useState(false);
  const [ytError, setYtError] = useState("");

  useEffect(() => {
    fetch("/api/setup/tts-status")
      .then((r) => r.json())
      .then((data) => setLocalTtsAvailable(data.ttsAvailable === true))
      .catch(() => setLocalTtsAvailable(false));
  }, []);

  useEffect(() => {
    function loadVoice() {
      fetch(`/api/personas/${enc}/voice`)
        .then((r) => r.json())
        .then((data) => {
          setConfig((prev) => ({ ...prev, ...data }));
          if (data.youtubeSetup?.url) {
            setYtUrl(data.youtubeSetup.url);
            setYtStart(String(data.youtubeSetup.start ?? 0));
            setYtEnd(String(data.youtubeSetup.end ?? 30));
            setYtError("");
            setYtModal(true);
            fetch(`/api/personas/${enc}/voice`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...data, youtubeSetup: undefined }),
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }
    if (refreshTrigger > 0) {
      const t = setTimeout(loadVoice, 500);
      return () => clearTimeout(t);
    }
    loadVoice();
  }, [enc, refreshTrigger]);

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

  async function handleGenerateVoice() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/personas/${enc}/voice/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "create-voice",
          design: config.design,
          language: config.language,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setConfig((prev) => ({ ...prev, voiceFile: data.voiceFile }));
        if (data.testAudioUrl) {
          setTestAudioUrl(data.testAudioUrl);
        }
      } else {
        alert(data.error || "Voice generation failed");
      }
    } catch {
      alert("Voice generation failed");
    }
    setGenerating(false);
  }

  async function handleTestTts() {
    if (!testText.trim()) return;
    setTestStatus("generating");
    setTestAudioUrl("");
    try {
      const res = await fetch(`/api/personas/${enc}/voice/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "test",
          text: testText,
          design: config.design,
          language: config.language,
        }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        setTestAudioUrl(data.url);
        setTestStatus("idle");
      } else {
        setTestStatus("error");
      }
    } catch {
      setTestStatus("error");
    }
  }

  // YouTube modal handlers
  function openYtModal() {
    setYtModal(true);
    setYtUrl("");
    setYtStart("0");
    setYtEnd("30");
    setYtError("");
  }

  function getYtVideoId(url: string): string | null {
    const m = url.match(/(?:youtu\.be\/|[?&]v=)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  async function handleYtApply() {
    if (!ytUrl.trim()) return;
    setYtLoading(true);
    setYtError("");
    try {
      const res = await fetch(`/api/personas/${enc}/voice/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: ytUrl,
          start: parseFloat(ytStart) || 0,
          end: parseFloat(ytEnd) || 30,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setConfig((prev) => ({ ...prev, referenceAudio: data.filename, enabled: true }));
        setYtModal(false);
      } else {
        setYtError(data.error || "Failed");
      }
    } catch {
      setYtError("Failed to download");
    }
    setYtLoading(false);
  }

  const isEdge = config.ttsProvider === "edge";
  const hasVoiceSource = isEdge
    ? !!config.edgeVoice
    : !!(config.voiceFile || config.referenceAudio || config.design);

  // Filter edge voices by selected language
  const filteredEdgeVoices = EDGE_VOICES.filter((v) => v.lang === config.language);

  const selectStyle = {
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat" as const,
    backgroundPosition: "right 6px center",
    paddingRight: "18px",
  };

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
        {/* TTS Provider Selector */}
        <div>
          <label className="text-[10px] text-text-dim/70 block mb-1.5">Provider</label>
          <div className="flex rounded-lg overflow-hidden border border-border/40">
            <button
              onClick={() => saveConfig({ ...config, ttsProvider: "edge" })}
              className="flex-1 px-2 py-1.5 text-[10px] transition-all"
              style={{
                background: isEdge ? `${accentColor}20` : "transparent",
                color: isEdge ? accentColor : "var(--text-dim)",
                borderRight: "1px solid var(--border)",
              }}
            >
              ⚡ Edge TTS
            </button>
            <button
              onClick={() => localTtsAvailable === true && saveConfig({ ...config, ttsProvider: "comfyui" })}
              disabled={localTtsAvailable !== true}
              className="flex-1 px-2 py-1.5 text-[10px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: !isEdge ? `${accentColor}20` : "transparent",
                color: !isEdge ? accentColor : "var(--text-dim)",
              }}
              title={localTtsAvailable === false ? "Local TTS 미설치" : localTtsAvailable === null ? "확인 중..." : undefined}
            >
              🎛 {localTtsAvailable === null ? "확인 중..." : localTtsAvailable === false ? "Local TTS 미설치" : "ComfyUI"}
            </button>
          </div>
          <p className="text-[9px] text-text-dim/40 mt-0.5">
            {isEdge ? "클라우드 TTS — 빠르고 GPU 불필요" : "로컬 GPU — 보이스 클로닝 가능"}
          </p>
        </div>

        {/* Language (shared) */}
        <div>
          <label className="text-[10px] text-text-dim/70 block mb-1">Language</label>
          <select
            value={config.language}
            onChange={(e) => {
              const newLang = e.target.value;
              const updated = { ...config, language: newLang };
              // Auto-select first voice for new language if current doesn't match
              if (isEdge) {
                const voicesForLang = EDGE_VOICES.filter((v) => v.lang === newLang);
                if (voicesForLang.length > 0 && !voicesForLang.find((v) => v.id === config.edgeVoice)) {
                  updated.edgeVoice = voicesForLang[0].id;
                }
              }
              saveConfig(updated);
            }}
            className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
              outline-none cursor-pointer appearance-none"
            style={selectStyle}
          >
            <option value="ko" className="bg-[#1a1a2e] text-[#ccc]">Korean</option>
            <option value="en" className="bg-[#1a1a2e] text-[#ccc]">English</option>
            <option value="ja" className="bg-[#1a1a2e] text-[#ccc]">Japanese</option>
            <option value="zh" className="bg-[#1a1a2e] text-[#ccc]">Chinese</option>
          </select>
        </div>

        {isEdge ? (
          <>
            {/* Edge TTS Voice */}
            <div>
              <label className="text-[10px] text-text-dim/70 block mb-1">Voice</label>
              <select
                value={config.edgeVoice}
                onChange={(e) => saveConfig({ ...config, edgeVoice: e.target.value })}
                className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                  outline-none cursor-pointer appearance-none"
                style={selectStyle}
              >
                {filteredEdgeVoices.map((v) => (
                  <option key={v.id} value={v.id} className="bg-[#1a1a2e] text-[#ccc]">
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Edge Rate */}
            <div>
              <label className="text-[10px] text-text-dim/70 block mb-1">Speed</label>
              <input
                type="text"
                value={config.edgeRate}
                onChange={(e) => setConfig({ ...config, edgeRate: e.target.value })}
                onBlur={() => saveConfig(config)}
                placeholder="+0% (기본)"
                className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                  outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30"
              />
              <p className="text-[9px] text-text-dim/40 mt-0.5">예: +20%, -10%</p>
            </div>

            {/* Edge Pitch */}
            <div>
              <label className="text-[10px] text-text-dim/70 block mb-1">Pitch</label>
              <input
                type="text"
                value={config.edgePitch}
                onChange={(e) => setConfig({ ...config, edgePitch: e.target.value })}
                onBlur={() => saveConfig(config)}
                placeholder="+0Hz (기본)"
                className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                  outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30"
              />
              <p className="text-[9px] text-text-dim/40 mt-0.5">예: +5Hz, -10Hz</p>
            </div>
          </>
        ) : (
          <>
            {/* ComfyUI: Reference Audio */}
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
                <div className="flex gap-1.5">
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
                    {uploading ? "Uploading..." : "Upload file"}
                  </button>
                  <button
                    onClick={openYtModal}
                    className="px-3 py-1.5 text-[11px] rounded-lg border border-dashed transition-all
                      border-border/40 text-text-dim/60 hover:border-accent/60 hover:text-accent"
                  >
                    From YouTube
                  </button>
                </div>
              )}
            </div>

            {/* ComfyUI: Reference Text */}
            {config.referenceAudio && (
              <div>
                <label className="text-[10px] text-text-dim/70 block mb-1">Reference Text</label>
                <textarea
                  value={config.referenceText}
                  onChange={(e) => setConfig({ ...config, referenceText: e.target.value })}
                  onBlur={() => saveConfig(config)}
                  placeholder="레퍼런스 오디오에서 말하는 내용을 입력하세요"
                  rows={2}
                  className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                    outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30 resize-y"
                />
                <p className="text-[9px] text-text-dim/40 mt-0.5">입력 시 ICL 모드로 더 정확한 음성 클로닝 (비우면 x-vector only)</p>
              </div>
            )}

            {/* ComfyUI: Voice Design */}
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

            {/* ComfyUI: Model Size */}
            <div>
              <label className="text-[10px] text-text-dim/70 block mb-1">Model Size</label>
              <select
                value={config.modelSize}
                onChange={(e) => saveConfig({ ...config, modelSize: e.target.value })}
                className="w-full px-2 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                  outline-none cursor-pointer appearance-none"
                style={selectStyle}
              >
                <option value="0.6B" className="bg-[#1a1a2e] text-[#ccc]">0.6B (Fast)</option>
                <option value="1.7B" className="bg-[#1a1a2e] text-[#ccc]">1.7B (Quality)</option>
              </select>
              <p className="text-[9px] text-text-dim/40 mt-0.5">0.6B: 빠르지만 품질 낮음 / 1.7B: 느리지만 고품질</p>
            </div>

            {/* ComfyUI: Voice .pt Generation */}
            <div
              className="rounded-lg p-2.5"
              style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}10` }}
            >
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-text-dim/70">Voice Embedding (.pt)</label>
                {config.voiceFile && (
                  <span className="text-[9px] text-accent/70">{config.voiceFile}</span>
                )}
              </div>
              <button
                onClick={handleGenerateVoice}
                disabled={generating || (!config.referenceAudio && !config.design) || localTtsAvailable === false}
                className="w-full px-3 py-1.5 text-[11px] rounded-lg border transition-all disabled:opacity-40
                  border-accent/40 text-accent/80 hover:bg-accent/10 hover:text-accent"
                title={localTtsAvailable === false ? "Local TTS 미설치" : undefined}
              >
                {generating ? "Generating..." : config.voiceFile ? "Regenerate Voice" : "Generate Voice (.pt)"}
              </button>
              {localTtsAvailable === false && (
                <p className="text-[9px] text-error/60 mt-1">Local TTS 미설치</p>
              )}
              {localTtsAvailable !== false && !config.referenceAudio && !config.design && (
                <p className="text-[9px] text-text-dim/40 mt-1">Reference audio 또는 voice design 필요</p>
              )}
            </div>
          </>
        )}

        {/* Chunk Delay (shared) */}
        <div>
          <label className="text-[10px] text-text-dim/70 block mb-1">Chunk Delay (ms)</label>
          <input
            type="number"
            value={config.chunkDelay}
            onChange={(e) => setConfig({ ...config, chunkDelay: parseInt(e.target.value) || 500 })}
            onBlur={() => saveConfig(config)}
            min={0}
            step={100}
            className="w-full px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
              outline-none focus:border-accent/60 transition-colors"
          />
          <p className="text-[9px] text-text-dim/40 mt-0.5">줄바꿈 기준 분할 청크 간 딜레이</p>
        </div>

        {/* Test TTS (shared) */}
        <div
          className="rounded-lg p-2.5"
          style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}10` }}
        >
          <label className="text-[10px] text-text-dim/70 block mb-1.5">Test TTS</label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleTestTts()}
              placeholder="테스트할 대사를 입력하세요"
              className="flex-1 px-2.5 py-1.5 text-[11px] rounded-lg border border-border/40 bg-transparent text-text
                outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30"
            />
            <button
              onClick={handleTestTts}
              disabled={testStatus === "generating" || !testText.trim() || !hasVoiceSource || (!isEdge && localTtsAvailable === false)}
              className="px-3 py-1.5 text-[11px] rounded-lg border transition-all shrink-0 disabled:opacity-40
                border-accent/40 text-accent/80 hover:bg-accent/10 hover:text-accent"
              title={!isEdge && localTtsAvailable === false ? "Local TTS 미설치" : undefined}
            >
              {testStatus === "generating" ? "..." : "Play"}
            </button>
          </div>
          {testAudioUrl && (
            <audio
              ref={testAudioRef}
              src={testAudioUrl}
              controls
              autoPlay
              className="w-full h-7 mt-2"
            />
          )}
          {testStatus === "error" && (
            <p className="text-[9px] text-error/70 mt-1">Generation failed</p>
          )}
          {!hasVoiceSource && (
            <p className="text-[9px] text-text-dim/40 mt-1">
              {isEdge ? "음성을 선택하세요" : "음성 설정이 필요합니다"}
            </p>
          )}
        </div>

        {saving && <p className="text-[9px] text-accent/60">Saving...</p>}
      </div>

      {/* YouTube Modal — rendered via portal to escape sidebar containment */}
      {ytModal && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={(e) => { if (e.target === e.currentTarget && !ytLoading) setYtModal(false); }}
        >
          <div
            className="rounded-xl p-5 w-[420px] max-w-[90vw] space-y-4"
            style={{ background: "#1a1a2e", border: "1px solid #2a2a4e" }}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-text">YouTube Reference Audio</h3>
              <button
                onClick={() => !ytLoading && setYtModal(false)}
                className="text-text-dim/50 hover:text-text text-[16px] leading-none"
              >
                x
              </button>
            </div>

            {/* URL */}
            <div>
              <label className="text-[10px] text-text-dim/70 block mb-1">YouTube URL</label>
              <input
                type="text"
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full px-2.5 py-2 text-[12px] rounded-lg border border-border/40 bg-transparent text-text
                  outline-none focus:border-accent/60 transition-colors placeholder:text-text-dim/30"
              />
            </div>

            {/* Time range */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[10px] text-text-dim/70 block mb-1">Start (sec)</label>
                <input
                  type="number"
                  value={ytStart}
                  onChange={(e) => setYtStart(e.target.value)}
                  min={0}
                  step={0.5}
                  className="w-full px-2.5 py-2 text-[12px] rounded-lg border border-border/40 bg-transparent text-text
                    outline-none focus:border-accent/60 transition-colors"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-text-dim/70 block mb-1">End (sec)</label>
                <input
                  type="number"
                  value={ytEnd}
                  onChange={(e) => setYtEnd(e.target.value)}
                  min={0}
                  step={0.5}
                  className="w-full px-2.5 py-2 text-[12px] rounded-lg border border-border/40 bg-transparent text-text
                    outline-none focus:border-accent/60 transition-colors"
                />
              </div>
            </div>

            {/* YouTube embed preview */}
            {ytUrl.trim() && getYtVideoId(ytUrl) && (
              <div className="rounded-lg overflow-hidden" style={{ aspectRatio: "16/9" }}>
                <iframe
                  src={`https://www.youtube.com/embed/${getYtVideoId(ytUrl)}?start=${Math.floor(parseFloat(ytStart) || 0)}`}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
                  allowFullScreen
                />
              </div>
            )}

            {/* Apply */}
            <button
              onClick={handleYtApply}
              disabled={ytLoading || !ytUrl.trim()}
              className="w-full px-3 py-2 text-[11px] rounded-lg border transition-all disabled:opacity-40
                border-accent/40 text-accent/80 hover:bg-accent/10 hover:text-accent"
            >
              {ytLoading ? "Downloading..." : "Apply"}
            </button>

            {ytError && (
              <p className="text-[10px] text-error/80">{ytError}</p>
            )}

            <p className="text-[9px] text-text-dim/40">
              YouTube에서 오디오를 다운로드하고 지정 구간을 잘라 레퍼런스 오디오로 등록합니다. 3~30초 권장.
            </p>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
