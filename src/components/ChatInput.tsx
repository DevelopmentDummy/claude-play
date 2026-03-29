"use client";

import { useState, useRef, useCallback, useEffect, memo } from "react";
import { showToast } from "./ToastEffect";
import { getPanelActionRegistry } from "@/lib/panel-action-registry";

// Web Speech API type shim (not in default DOM lib)
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onspeechstart: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
declare global {
  interface Window {
    SpeechRecognition?: { new(): ISpeechRecognition };
    webkitSpeechRecognition?: { new(): ISpeechRecognition };
  }
}

export interface ChoiceAction {
  tool?: string;       // legacy: tool name (e.g. "engine")
  panel?: string;      // new: panel name (e.g. "advance", "schedule")
  action: string;
  args?: Record<string, unknown>;
  params?: Record<string, unknown>; // panel action params (alias for args)
}

export interface Choice {
  text: string;
  score: number;
  actions?: ChoiceAction[];
}

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
  sessionId?: string;
  choices?: Choice[];
  pendingEvents?: string[];
  showOOC?: boolean;
  onOOCToggle?: (on: boolean) => void;
  /** Voice chat mode: auto-start STT after AI response, auto-send after silence */
  voiceChat?: boolean;
  /** TTS is currently playing audio */
  ttsPlaying?: boolean;
  /** Auto-send delay in ms (default 3000) */
  autoSendDelay?: number;
  /** Autoplay mode active */
  autoplayActive?: boolean;
  /** Toggle autoplay on/off */
  onAutoplayToggle?: () => void;
  /** Currently selected steering preset name */
  steeringPresetName?: string | null;
  /** Open steering preset editor */
  onSteeringEdit?: () => void;
}

function ChatInput({ disabled, onSend, sessionId, choices, pendingEvents, showOOC, onOOCToggle, voiceChat, ttsPlaying, autoSendDelay = 3000, autoplayActive, onAutoplayToggle, steeringPresetName, onSteeringEdit }: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [oocMode, setOocMode] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const oocModeRef = useRef(oocMode);
  oocModeRef.current = oocMode;
  const composingRef = useRef(false);
  const sttSuppressRef = useRef(false); // suppress STT onresult after send

  // Sync oocMode when showOOC changes externally (e.g. sync OOC message)
  useEffect(() => {
    if (showOOC !== undefined && showOOC !== oocMode) {
      setOocMode(showOOC);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOOC]);

  const handleSend = useCallback(() => {
    // Suppress any pending STT results before clearing input
    clearAutoSendTimer();
    const wasSTT = !!(recognitionRef.current || mediaRecorderRef.current);
    sttSuppressRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setSttActive(false);
    const raw = inputRef.current?.value.trim();
    if (!raw) return;
    const tagged = wasSTT ? `[STT] ${raw}` : raw;
    const text = oocModeRef.current && !tagged.startsWith("OOC:") ? `OOC: ${tagged}` : tagged;
    onSend(text);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
  }, [onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME 조합 중에는 Enter 무시 (한글 등 조합형 입력기)
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Refocus textarea when streaming ends (disabled → enabled)
  // 윈도우가 비활성일 때 focus()를 호출하면 macOS IME 상태가 깨질 수 있으므로
  // document.hasFocus() 체크 후, 비활성이면 visibilitychange로 지연
  useEffect(() => {
    if (!disabled) {
      if (document.hasFocus() && !composingRef.current) {
        requestAnimationFrame(() => inputRef.current?.focus());
      } else {
        // 윈도우가 비활성일 때는 다시 활성화될 때 포커스
        const onVisible = () => {
          if (document.visibilityState === "visible" && !composingRef.current) {
            requestAnimationFrame(() => inputRef.current?.focus());
            document.removeEventListener("visibilitychange", onVisible);
          }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
      }
    }
  }, [disabled]);

  const handleInput = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, []);

  const handleChoice = useCallback(async (choice: Choice) => {
    if (!choice.actions?.length || !sessionId) {
      onSend(choice.text);
      return;
    }
    setChoiceBusy(true);
    try {
      const registry = getPanelActionRegistry();
      const win = window as unknown as Record<string, unknown>;
      let lastAvailable: Array<{ action: string; label: string; args_hint: string | null }> | null = null;

      const panelActions = choice.actions.filter(a => a.panel);
      let panelActionIndex = 0;

      for (const act of choice.actions) {
        if (act.panel) {
          // ═══ Panel Action ═══
          panelActionIndex++;

          // Suppress handler's sendMessage — choice text will be sent via onSend instead
          win.__panelActionSuppressSend = true;

          // 1. Open the panel modal
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/modals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "open", name: act.panel, mode: true }),
          });

          // 2. Wait for handler to be registered
          await registry.waitForHandler(act.panel, act.action, 8000);

          // 3. Execute via registry (records to history + runs handler)
          //    sendMessage inside handler is suppressed; queueEvent still works
          const params = act.params || act.args;
          await registry.execute(act.panel, act.action, params);

        } else if (act.tool) {
          // ═══ Legacy Tool Action ═══
          const toolRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(act.tool)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ args: { action: act.action, ...(act.args || {}) } }),
          });
          if (!toolRes.ok) {
            const err = await toolRes.json().catch(() => ({ error: "Action failed" }));
            throw new Error(err.error || `Action ${act.action} failed`);
          }
          const toolData = await toolRes.json();
          const hint = toolData.result?.hints?.narrative || toolData.result?.hints?.summary || "completed";
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ header: `[${act.action}] ${hint}` }),
          });
          if (toolData._available_actions?.length) {
            lastAvailable = toolData._available_actions;
          }
        }
      }

      // [AVAILABLE] header: prefer registry, fallback to legacy
      const availableHeader = registry.buildAvailableHeader();
      if (availableHeader) {
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header: availableHeader }),
        });
      } else if (lastAvailable && lastAvailable.length > 0) {
        const parts = lastAvailable.map((a: { action: string; label: string; args_hint: string | null }) =>
          a.args_hint ? `${a.action}(${a.label} ${a.args_hint})` : `${a.action}(${a.label})`
        );
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header: `[AVAILABLE] ${parts.join(", ")}` }),
        });
      }

      // Clear suppress flag and send choice text as user message.
      // Panel handler's sendMessage was suppressed; queued events (slot results etc.)
      // will be picked up by onSend along with the choice text.
      win.__panelActionSuppressSend = false;
      onSend(choice.text);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      console.error("[choice action]", msg);
      showToast(msg, 4000);
    } finally {
      setChoiceBusy(false);
    }
  }, [onSend, sessionId]);

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

  // --- Speech-to-Text ---
  // Mode A: Web Speech API (Chrome desktop, etc.) — real-time streaming
  // Mode B: MediaRecorder → server Whisper (iPad Safari, Firefox, etc.) — record then transcribe
  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [sttActive, setSttActive] = useState(false);
  const [sttTranscribing, setSttTranscribing] = useState(false);
  const [sttMode, setSttMode] = useState<"none" | "web" | "recorder">("none");
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoSendCountdown, setAutoSendCountdown] = useState(false); // true = 3s countdown active
  const prevDisabledRef = useRef(disabled);
  const AUTO_SEND_DELAY = autoSendDelay;

  useEffect(() => {
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      setSttMode("web");
    } else if (typeof MediaRecorder !== "undefined") {
      setSttMode("recorder");
    }
  }, []);

  // -- Mode A: Web Speech API --
  const stopWebSTT = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setSttActive(false);
  }, []);

  const clearAutoSendTimer = useCallback(() => {
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current);
      autoSendTimerRef.current = null;
    }
    setAutoSendCountdown(false);
  }, []);

  // Ref to allow onend to call a fresh startWebSTT without circular deps
  const startWebSTTRef = useRef<(() => void) | null>(null);

  const startWebSTT = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    // Stop any existing recognition first
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    sttSuppressRef.current = false;
    clearAutoSendTimer();
    const recognition = new SR();
    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;

    const el = inputRef.current;
    const before = el?.value || "";
    let prevFinalCount = 0;
    let hasEverSpoken = false;

    // Cancel auto-send as soon as the engine detects new speech (before onresult fires)
    recognition.onspeechstart = () => {
      clearAutoSendTimer();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (!el || sttSuppressRef.current) return;
      let final = "";
      let interim = "";
      let finalCount = 0;
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
          finalCount++;
        } else {
          interim += r[0].transcript;
        }
      }
      const sep = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
      el.value = before + sep + final + interim;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";

      // Mark that user has actually spoken
      if (final.trim() || interim.trim()) hasEverSpoken = true;

      // Auto-send: cancel timer when user starts speaking again
      if (interim) {
        clearAutoSendTimer();
      }
      // Start countdown only after user has spoken at least once, then paused
      if (hasEverSpoken && finalCount > prevFinalCount && !interim) {
        clearAutoSendTimer();
        setAutoSendCountdown(true);
        autoSendTimerRef.current = setTimeout(() => {
          autoSendTimerRef.current = null;
          setAutoSendCountdown(false);
          const text = el.value.trim();
          if (text) {
            sttSuppressRef.current = true;
            recognition.stop();
            recognitionRef.current = null;
            setSttActive(false);
            const tagged = `[STT] ${text}`;
            const sendText = oocModeRef.current && !tagged.startsWith("OOC:") ? `OOC: ${tagged}` : tagged;
            el.value = "";
            el.style.height = "auto";
            onSend(sendText);
          }
        }, AUTO_SEND_DELAY);
      }
      prevFinalCount = finalCount;
    };

    recognition.onerror = () => { clearAutoSendTimer(); stopWebSTT(); };
    // If recognition ends before user spoke (silence timeout), create fresh instance to keep listening
    recognition.onend = () => {
      clearAutoSendTimer();
      if (!hasEverSpoken && !sttSuppressRef.current) {
        // User hasn't spoken yet — create new recognition to keep red icon alive
        recognitionRef.current = null;
        setTimeout(() => startWebSTTRef.current?.(), 50);
      } else {
        setSttActive(false);
      }
    };
    recognition.start();
    recognitionRef.current = recognition;
    setSttActive(true);
  }, [stopWebSTT, clearAutoSendTimer, voiceChat, onSend]);

  // Keep ref in sync
  startWebSTTRef.current = startWebSTT;

  // -- Mode B: MediaRecorder → server Whisper --
  const stopRecorderSTT = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    // Wrap stop in a promise to wait for final data
    const blob = await new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        resolve(new Blob(audioChunksRef.current, { type: recorder.mimeType }));
      };
      recorder.stop();
    });

    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setSttActive(false);

    if (blob.size < 1000) return; // too short, ignore

    setSttTranscribing(true);
    try {
      const form = new FormData();
      form.append("audio", blob, `stt.${blob.type.includes("webm") ? "webm" : "m4a"}`);
      form.append("language", "ko");
      form.append("model_size", "base");

      const res = await fetch("/api/tools/comfyui/stt", { method: "POST", body: form });
      const data = await res.json();
      if (data.text) {
        insertAtCursor(data.text);
      }
    } catch (err) {
      console.error("[stt] Transcribe failed:", err);
    } finally {
      setSttTranscribing(false);
    }
  }, [insertAtCursor]);

  const startRecorderSTT = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer webm for smaller size; fall back to whatever is supported
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.start(1000); // collect chunks every 1s
      mediaRecorderRef.current = recorder;
      setSttActive(true);
    } catch (err) {
      console.error("[stt] Mic access denied:", err);
    }
  }, []);

  // -- Unified toggle --
  const toggleSTT = useCallback(() => {
    if (sttActive) {
      if (sttMode === "web") stopWebSTT();
      else stopRecorderSTT();
    } else {
      if (sttMode === "web") startWebSTT();
      else startRecorderSTT();
    }
  }, [sttActive, sttMode, stopWebSTT, stopRecorderSTT, startWebSTT, startRecorderSTT]);

  const prevTtsPlayingRef = useRef(ttsPlaying);

  // Cleanup on disable; auto-start STT on voiceChat after TTS finishes
  useEffect(() => {
    if (disabled && sttActive) {
      clearAutoSendTimer();
      if (sttMode === "web") stopWebSTT();
      else { mediaRecorderRef.current?.stop(); setSttActive(false); }
    }

    // Voice chat: auto-start STT when ready
    if (voiceChat && !disabled && !sttActive && sttMode === "web") {
      const wasBusy = prevDisabledRef.current || prevTtsPlayingRef.current;
      const isReady = !ttsPlaying;
      if (wasBusy && isReady) {
        startWebSTT();
      }
    }

    prevDisabledRef.current = disabled;
    prevTtsPlayingRef.current = ttsPlaying;
  }, [disabled, ttsPlaying, sttActive, sttMode, stopWebSTT, voiceChat, startWebSTT, clearAutoSendTimer]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    mediaRecorderRef.current?.stop();
    if (autoSendTimerRef.current) clearTimeout(autoSendTimerRef.current);
  }, []);

  const btnBase = "w-9 h-9 flex items-center justify-center rounded-lg border cursor-pointer text-xs font-medium shrink-0 transition-all duration-fast";

  return (
    <footer className="flex flex-col bg-surface backdrop-blur-[16px] border-t border-border shrink-0">
      {choices && choices.length > 0 && !disabled && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
          {choices.map((c, i) => (
            <button
              key={i}
              disabled={choiceBusy}
              onClick={() => handleChoice(c)}
              title={c.actions?.length ? c.actions.map(a => {
                if (a.panel) {
                  const registry = getPanelActionRegistry();
                  const available = registry.getAvailable();
                  const meta = available.find(m => m.panel === a.panel && m.id === a.action);
                  const label = meta?.label || a.action;
                  const paramsStr = a.params ? Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(", ") : "";
                  return paramsStr ? `${label} (${paramsStr})` : label;
                }
                return a.action;
              }).join(" → ") : undefined}
              className={`relative px-3.5 py-2 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
                border border-border/60 cursor-pointer
                transition-all duration-fast
                hover:border-accent hover:bg-[rgba(var(--accent-rgb),0.08)] hover:-translate-y-px
                hover:shadow-[0_2px_12px_var(--accent-glow)]
                active:translate-y-0
                ${c.actions?.length ? "pr-7" : ""}
                ${choiceBusy ? "opacity-50 pointer-events-none" : ""}`}
            >
              {c.text}
              {c.actions && c.actions.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex items-center gap-px px-1 py-0.5 rounded-full text-[10px] leading-none bg-accent/20 text-accent border border-accent/30">
                  <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>
                  {c.actions.length > 1 && <span>{c.actions.length}</span>}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {pendingEvents && pendingEvents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2 pb-1">
          {pendingEvents.map((header, i) => (
            <span
              key={i}
              className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs
                bg-amber-500/10 text-amber-300/90 border border-amber-500/20"
            >
              {header}
            </span>
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
          {sttMode !== "none" && (
            <button
              onClick={toggleSTT}
              disabled={sttTranscribing}
              className={`${btnBase} relative ${
                sttTranscribing
                  ? "border-blue-500/60 text-blue-400 bg-blue-500/15 animate-pulse"
                  : sttActive
                    ? "border-red-500/60 text-red-400 bg-red-500/15 animate-pulse"
                    : "border-border/40 text-text-dim/50 bg-transparent hover:border-border/60 hover:text-text-dim/80"
              }`}
              title={sttTranscribing ? "변환 중..." : sttActive ? "음성 입력 중지" : "음성 입력"}
            >
              {/* Auto-send countdown ring */}
              {autoSendCountdown && (
                <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
                  <circle
                    cx="18" cy="18" r="15"
                    fill="none"
                    stroke="rgba(96,165,250,0.3)"
                    strokeWidth="2"
                  />
                  <circle
                    cx="18" cy="18" r="15"
                    fill="none"
                    stroke="rgb(96,165,250)"
                    strokeWidth="2.5"
                    strokeDasharray={`${Math.PI * 30}`}
                    strokeDashoffset="0"
                    strokeLinecap="round"
                    style={{
                      animation: `stt-countdown ${AUTO_SEND_DELAY}ms linear forwards`,
                    }}
                  />
                </svg>
              )}
              {sttTranscribing ? (
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-1-9a1 1 0 1 1 2 0v6a1 1 0 1 1-2 0V5zm6 6a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2z"/>
                </svg>
              )}
            </button>
          )}
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
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          autoFocus
        />
        <button
          disabled={disabled}
          onClick={handleSend}
          className="px-5 py-2.5 border-none rounded-xl bg-accent text-white cursor-pointer text-sm font-medium shrink-0 shadow-[0_2px_12px_var(--accent-glow)] transition-all duration-fast hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_20px_var(--accent-glow)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
        >
          Send
        </button>
        {/* Autoplay toggle */}
        <button
          onClick={onAutoplayToggle}
          className={`${btnBase} relative ${
            autoplayActive
              ? "border-blue-500/60 text-blue-400 bg-blue-500/15 shadow-[0_0_8px_rgba(59,130,246,0.3)]"
              : "border-border/40 text-text-dim/50 bg-transparent hover:border-border/60 hover:text-text-dim/80"
          }`}
          title={autoplayActive ? "오토플레이 중지" : "오토플레이 시작"}
        >
          {autoplayActive ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
      </div>
      {/* Steering preset indicator — always visible so user can set direction before starting autoplay */}
      <div className="flex items-center gap-2 px-4 pb-2 -mt-1">
        <span className="text-[11px] text-text-dim/50">스티어링:</span>
        <button
          onClick={onSteeringEdit}
          className={`text-[11px] truncate max-w-[200px] transition-colors ${
            steeringPresetName
              ? "text-blue-400/70 hover:text-blue-300"
              : "text-text-dim/50 hover:text-text-dim/80"
          }`}
        >
          {steeringPresetName || "없음"}
        </button>
      </div>
    </footer>
  );
}

// React.memo로 감싸서 props가 실제로 변하지 않으면 리렌더 방지
// → AI 스트리밍 중 부모(ChatPage)가 매 text_delta마다 리렌더되더라도
//   ChatInput의 textarea DOM은 건드리지 않으므로 IME 상태 보존
export default memo(ChatInput);
