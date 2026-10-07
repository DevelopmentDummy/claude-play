"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * 음성 입력 엔진 — 마이크를 켜고, 말을 받아 글로 바꿔 돌려준다. "언제 켤지"는 호출측(ChatInput) 정책이다.
 *
 * 두 엔진:
 *  - recorder: MediaRecorder → 서버 STT(`/api/tools/comfyui/stt`, Qwen3-ASR + 대화 문맥, Whisper 폴백).
 *    GPU Manager가 asr_available이면 이쪽이 우선 — Web Speech는 문맥을 못 받아 고유명사가 깨진다.
 *  - web: Web Speech API(크롬 등). 실시간으로 입력창에 받아쓴다.
 *
 * handsFree(음성 대화) 세션은 말이 끝나고 `autoSendDelay` 동안 조용하면 스스로 끝내고 `onAutoSend`로 보낸다.
 * 수동 세션은 다시 누르면(stop) 전사해서 입력창에 넣는다.
 */
export type VoiceMode = "none" | "web" | "recorder";
export type VoiceState = "idle" | "listening" | "transcribing";

interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult { isFinal: boolean; [index: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionEvent extends Event { results: { length: number; [index: number]: SpeechRecognitionResult } }
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  start(): void;
  stop(): void;
}
type SRCtor = { new(): ISpeechRecognition };
function getSR(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

/** 이 RMS 이상이면 말소리로 본다(녹음기 엔진의 끝점 검출). */
const SPEECH_RMS = 0.02;
/** 이보다 작은 녹음은 전사하지 않는다(버튼 오조작·잡음). */
const MIN_BLOB_BYTES = 1000;

export interface VoiceInputOptions {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  sessionId?: string;
  autoSendDelay: number;
  /** 수동 세션의 전사 결과(녹음기 엔진) — 입력창 커서에 넣는다. */
  onInsert: (text: string) => void;
  /** handsFree 세션의 결과 — 바로 전송. text는 이미 trim 됨. */
  onAutoSend: (text: string) => void;
}

export interface VoiceInput {
  mode: VoiceMode;
  state: VoiceState;
  /** 지금 세션이 음성 대화(자동) 세션인가 */
  handsFree: boolean;
  /** 무음 카운트다운 표시용 */
  countdown: boolean;
  start: (opts?: { handsFree?: boolean }) => void;
  /** 끝내고 전사(녹음기) / 받아쓴 내용 유지(web). */
  stop: () => void;
  /** 녹음을 버리고 끈다(전송·턴 시작·TTS 시작·언마운트). */
  cancel: () => void;
}

export function useVoiceInput({ inputRef, sessionId, autoSendDelay, onInsert, onAutoSend }: VoiceInputOptions): VoiceInput {
  const [mode, setMode] = useState<VoiceMode>("none");
  const [state, setState] = useState<VoiceState>("idle");
  const [countdown, setCountdown] = useState(false);
  const [handsFree, setHandsFree] = useState(false);

  // 콜백·설정은 ref로 들고 있어 엔진 함수들이 매 렌더 새로 만들어지지 않게 한다.
  const cb = useRef({ onInsert, onAutoSend, sessionId, autoSendDelay });
  cb.current = { onInsert, onAutoSend, sessionId, autoSendDelay };

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const detachSilenceRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 세션 세대 — cancel/새 start 이후 도착한 옛 세션의 결과(onresult·전사 응답)를 버린다. */
  const genRef = useRef(0);
  const handsFreeRef = useRef(false);

  // 엔진 결정: 녹음기가 있고 서버 ASR이 살아 있으면 recorder, 아니면 Web Speech.
  useEffect(() => {
    const hasRecorder = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    if (getSR()) setMode("web");
    else if (hasRecorder) setMode("recorder");
    if (!hasRecorder) return;
    let cancelled = false;
    fetch("/api/setup/tts-status")
      .then((r) => r.json())
      // 응답 전에 이미 Web Speech 세션이 열렸다면 모드를 뒤집지 않는다(stop이 엉뚱한 엔진을 부름).
      .then((d: { asrAvailable?: boolean }) => { if (!cancelled && d.asrAvailable && !recognitionRef.current) setMode("recorder"); })
      .catch(() => { /* Web Speech 유지 */ });
    return () => { cancelled = true; };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setCountdown(false);
  }, []);

  const releaseMic = useCallback(() => {
    detachSilenceRef.current?.();
    detachSilenceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const endSession = useCallback(() => {
    handsFreeRef.current = false;
    setHandsFree(false);
  }, []);

  /** 모든 엔진을 즉시 끄고 진행 중 결과를 버린다. */
  const cancel = useCallback(() => {
    genRef.current++;
    clearTimer();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) { rec.onend = null; rec.onresult = null; try { rec.stop(); } catch { /* ignore */ } }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    releaseMic();
    endSession();
    setState("idle");
  }, [clearTimer, releaseMic, endSession]);

  // ── recorder 엔진 ────────────────────────────────────────────
  const transcribe = useCallback(async (blob: Blob, gen: number, autoSend: boolean) => {
    setState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, `stt.${blob.type.includes("webm") ? "webm" : "m4a"}`);
      form.append("language", "ko");
      form.append("model_size", "base"); // Whisper 폴백 전용
      if (cb.current.sessionId) form.append("sessionId", cb.current.sessionId);
      const res = await fetch("/api/tools/comfyui/stt", { method: "POST", body: form });
      const data = (await res.json()) as { text?: unknown; contextEcho?: boolean };
      if (gen !== genRef.current) return; // 그 사이 취소·새 세션
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (data.contextEcho) console.warn("[stt] server dropped a context echo", { recovered: !!text });
      if (!text) return;
      if (autoSend) {
        const el = inputRef.current;
        const pending = el?.value.trim();
        if (el) { el.value = ""; el.style.height = "auto"; }
        cb.current.onAutoSend(pending ? `${pending} ${text}` : text);
      } else {
        cb.current.onInsert(text);
      }
    } catch (err) {
      console.error("[stt] transcribe failed:", err);
    } finally {
      if (gen === genRef.current) { endSession(); setState("idle"); }
    }
  }, [inputRef, endSession]);

  /** 녹음을 끝내고 전사. */
  const finishRecorder = useCallback(async (autoSend: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const gen = genRef.current;
    clearTimer();
    const blob = await new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });
    if (gen !== genRef.current) return;
    recorderRef.current = null;
    chunksRef.current = [];
    releaseMic();
    if (blob.size < MIN_BLOB_BYTES) { endSession(); setState("idle"); return; }
    await transcribe(blob, gen, autoSend);
  }, [clearTimer, releaseMic, transcribe, endSession]);

  /** handsFree: 말한 뒤 autoSendDelay만큼 조용하면 끝내고 보낸다. 말이 다시 나오면 카운트다운 취소. */
  const attachSilenceDetector = useCallback((stream: MediaStream) => {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let spoken = false;
    let silentSince = 0;
    let shown = false;
    const iv = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms >= SPEECH_RMS) {
        spoken = true;
        silentSince = 0;
        if (shown) { shown = false; setCountdown(false); }
        return;
      }
      if (!spoken) return;
      const now = Date.now();
      if (!silentSince) silentSince = now;
      if (!shown) { shown = true; setCountdown(true); }
      if (now - silentSince >= cb.current.autoSendDelay) {
        clearInterval(iv);
        setCountdown(false);
        void finishRecorder(true);
      }
    }, 100);
    detachSilenceRef.current = () => {
      clearInterval(iv);
      setCountdown(false);
      void ctx.close().catch(() => { /* ignore */ });
    };
  }, [finishRecorder]);

  const startRecorder = useCallback(async (gen: number, hf: boolean) => {
    // 말하는 동안 모델을 미리 올린다(콜드 로드 수 초).
    void fetch("/api/tools/comfyui/stt?warmup=1", { method: "POST" }).catch(() => { /* ignore */ });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("[stt] mic access denied:", err);
      if (gen === genRef.current) { endSession(); setState("idle"); }
      return;
    }
    if (gen !== genRef.current) { stream.getTracks().forEach((t) => t.stop()); return; } // 권한 대기 중 취소됨
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.start(1000);
    streamRef.current = stream;
    recorderRef.current = recorder;
    if (hf) attachSilenceDetector(stream);
  }, [attachSilenceDetector, endSession]);

  // ── web 엔진 ─────────────────────────────────────────────────
  const startWeb = useCallback((gen: number, hf: boolean) => {
    const SR = getSR();
    const el = inputRef.current;
    if (!SR || !el) { endSession(); setState("idle"); return; }
    const before = el.value;
    let hasSpoken = false;

    const open = () => {
      if (gen !== genRef.current) return;
      const rec = new SR();
      rec.lang = "ko-KR";
      rec.continuous = true;
      rec.interimResults = true;
      let prevFinal = 0;
      rec.onspeechstart = () => clearTimer();
      rec.onresult = (event) => {
        if (gen !== genRef.current) return;
        let final = "", interim = "", finalCount = 0;
        for (let i = 0; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) { final += r[0].transcript; finalCount++; } else interim += r[0].transcript;
        }
        const sep = before && !/[ \n]$/.test(before) ? " " : "";
        el.value = before + sep + final + interim;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 150) + "px";
        if (final.trim() || interim.trim()) hasSpoken = true;
        if (interim) clearTimer();
        if (hf && hasSpoken && finalCount > prevFinal && !interim) {
          clearTimer();
          setCountdown(true);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            setCountdown(false);
            const text = el.value.trim();
            cancel(); // 엔진 정리(입력창 값은 건드리지 않음)
            if (text) {
              el.value = "";
              el.style.height = "auto";
              cb.current.onAutoSend(text);
            }
          }, cb.current.autoSendDelay);
        }
        prevFinal = finalCount;
      };
      rec.onerror = (ev) => {
        console.warn("[stt] web speech error:", (ev as Event & { error?: string }).error);
        if (gen === genRef.current) cancel();
      };
      // 말하기 전에 엔진이 무음으로 끝나면 새 인스턴스로 계속 듣는다. 말한 뒤 끝나면 세션 종료.
      rec.onend = () => {
        if (gen !== genRef.current) return;
        clearTimer();
        if (!hasSpoken) { recognitionRef.current = null; setTimeout(open, 50); }
        else { recognitionRef.current = null; endSession(); setState("idle"); }
      };
      rec.start();
      recognitionRef.current = rec;
    };
    open();
  }, [inputRef, clearTimer, cancel, endSession]);

  // ── 공개 API ────────────────────────────────────────────────
  const start = useCallback((opts?: { handsFree?: boolean }) => {
    if (mode === "none" || state !== "idle") return;
    const gen = ++genRef.current;
    const hf = !!opts?.handsFree;
    handsFreeRef.current = hf;
    setHandsFree(hf);
    clearTimer();
    setState("listening");
    if (mode === "web") startWeb(gen, hf);
    else void startRecorder(gen, hf);
  }, [mode, state, clearTimer, startWeb, startRecorder]);

  const stop = useCallback(() => {
    if (state !== "listening") return;
    if (mode === "recorder") { void finishRecorder(false); return; }
    // web: 받아쓴 내용은 입력창에 남기고 엔진만 끈다.
    cancel();
  }, [state, mode, finishRecorder, cancel]);

  useEffect(() => () => {
    genRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") { recorder.onstop = null; recorder.stop(); }
    detachSilenceRef.current?.();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return useMemo(
    () => ({ mode, state, handsFree, countdown, start, stop, cancel }),
    [mode, state, handsFree, countdown, start, stop, cancel],
  );
}
