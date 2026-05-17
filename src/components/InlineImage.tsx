"use client";

import { useState, useEffect, useRef } from "react";
import ImageModal from "./ImageModal";

interface InlineImageProps {
  sessionId?: string;
  personaName?: string;
  path: string;
  onReady?: () => void;
}

type ImageState = "loading" | "ready" | "error";
type ImageSource = "session" | "persona";

const POLL_INTERVAL = 2000;
const MAX_POLLS = 60; // ~120 seconds — async gens may queue behind other ComfyUI work

// `<img>` GET retry cap when the request *itself* fails (e.g. ERR_NO_BUFFER_SPACE on
// Windows, transient connection refused). The retries use exponential backoff with
// a cap, so we don't make the situation worse by reflooding the network stack.
const MAX_IMG_RETRIES = 6;
const IMG_RETRY_BASE_MS = 800;
const IMG_RETRY_CAP_MS = 8000;

function imgBackoffMs(retryCount: number): number {
  return Math.min(IMG_RETRY_BASE_MS * Math.pow(1.5, retryCount), IMG_RETRY_CAP_MS);
}

function isPersonaPath(imgPath: string): boolean {
  return imgPath.startsWith("persona:") || imgPath.startsWith("persona/");
}

function personaFileName(imgPath: string): string {
  if (imgPath.startsWith("persona:")) return imgPath.slice("persona:".length);
  if (imgPath.startsWith("persona/")) return imgPath.slice("persona/".length);
  return imgPath.startsWith("images/") ? imgPath.slice(7) : imgPath;
}

/** Stable URL — no per-mount cache buster. The browser cache is now an ally:
 *  same imgPath returns the same URL across mounts, so re-rendered chat does not
 *  reflood the network. Explicit refresh after regeneration is handled by
 *  `bustImageCache()` in panel-image-polling (for panels) or the imgRetryCount
 *  marker below (for `<img>` GET failures). */
function buildFileUrl(
  imgPath: string,
  sessionId?: string,
  personaName?: string,
  source: ImageSource = "session",
): string {
  if (source === "persona") {
    const file = personaFileName(imgPath);
    if (sessionId) {
      return `/api/sessions/${encodeURIComponent(sessionId)}/persona-images?file=${encodeURIComponent(file)}`;
    }
    if (personaName) {
      return `/api/personas/${encodeURIComponent(personaName)}/images?file=${encodeURIComponent(file)}`;
    }
  }

  if (personaName) {
    // Builder mode: strip "images/" prefix for persona images API
    const file = imgPath.startsWith("images/") ? imgPath.slice(7) : imgPath;
    return `/api/personas/${encodeURIComponent(personaName)}/images?file=${encodeURIComponent(file)}`;
  }
  const encodedPath = imgPath.split('/').map(encodeURIComponent).join('/');
  return `/api/sessions/${sessionId}/files/${encodedPath}`;
}

/** Append a retry marker so the browser actually re-issues GET after an error.
 *  retryCount === 0 returns the URL unchanged so the cache can serve repeat mounts. */
function withRetryMarker(url: string, retryCount: number): string {
  if (retryCount <= 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}r=${retryCount}`;
}

export default function InlineImage({ sessionId, personaName, path: imgPath, onReady }: InlineImageProps) {
  const [state, setState] = useState<ImageState>("loading");
  const [source, setSource] = useState<ImageSource>(isPersonaPath(imgPath) ? "persona" : "session");
  const [showModal, setShowModal] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // `<img>` GET retry counter — survives across renders, drives src cache-buster.
  // Bumped by the onError handler with exponential backoff; reset on imgPath change.
  const [imgRetryCount, setImgRetryCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imgRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);
  const readyNotifiedRef = useRef(false);

  useEffect(() => {
    setSource(isPersonaPath(imgPath) ? "persona" : "session");
    setState("loading");
    setImgRetryCount(0);
    if (imgRetryTimerRef.current) {
      clearTimeout(imgRetryTimerRef.current);
      imgRetryTimerRef.current = null;
    }
  }, [imgPath]);

  useEffect(() => {
    let cancelled = false;
    pollCountRef.current = 0;
    readyNotifiedRef.current = false;

    const explicitPersona = isPersonaPath(imgPath);
    // Build all candidate sources to poll concurrently every cycle.
    // Explicit "persona:" prefix → only the persona endpoint.
    // Otherwise → poll BOTH session and persona endpoints simultaneously and
    // resolve as soon as either one responds OK. This avoids the old "guess
    // wrong on first 404" failure mode (async gens write to session/images/
    // and weren't ready on the first poll, but the previous code immediately
    // switched to the persona endpoint and then polled there forever).
    const candidateSources: ImageSource[] = explicitPersona
      ? ["persona"]
      : sessionId && personaName
        ? ["session", "persona"]
        : sessionId
          ? ["session"]
          : personaName
            ? ["persona"]
            : [];

    const poll = async () => {
      if (cancelled) return;

      // Fire HEAD for every candidate URL in parallel; the first OK wins.
      const checks = candidateSources.map((src) =>
        fetch(buildFileUrl(imgPath, sessionId, personaName, src), {
          method: "HEAD",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        })
          .then((res) => ({ src, ok: res.ok, status: res.status }))
          .catch(() => ({ src, ok: false, status: 0 })),
      );

      let results: Array<{ src: ImageSource; ok: boolean; status: number }> = [];
      try {
        results = await Promise.all(checks);
      } catch {
        results = [];
      }

      if (cancelled) return;

      const winner = results.find((r) => r.ok);
      if (winner) {
        // Lock the source that responded so the <img> uses the right URL.
        setSource(winner.src);
        setState("ready");
        return;
      }

      // No source has the file yet — keep waiting.
      pollCountRef.current++;
      if (pollCountRef.current >= MAX_POLLS) {
        setState("error");
        return;
      }
      timerRef.current = setTimeout(poll, POLL_INTERVAL);
    };

    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, personaName, imgPath, retryKey]);

  useEffect(() => {
    return () => {
      if (imgRetryTimerRef.current) clearTimeout(imgRetryTimerRef.current);
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="inline-flex items-center gap-2 bg-[#1a1a2e] rounded-lg px-3 py-2 my-1">
        <div className="w-4 h-4 border-2 border-[#8888a0] border-t-transparent rounded-full animate-spin" />
        <span className="text-[#8888a0] text-sm">이미지 생성 중...</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div
        className="inline-flex items-center gap-2 bg-[#2a1a1a] rounded-lg px-3 py-2 my-1 cursor-pointer hover:bg-[#3a2a2a] transition-colors"
        onClick={async () => {
          setState("loading");
          // Try to ask the AI to regenerate this missing image. If we have sessionId,
          // queue an event header pointing at the missing filename — the AI will see
          // this on its next turn and can re-issue the generate_image call. Then
          // restart polling in case the file does eventually appear via some other path.
          if (sessionId) {
            const filename = imgPath.startsWith("images/") ? imgPath.slice("images/".length) : imgPath;
            try {
              await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  header: `[이미지 재생성 요청] ${filename} — 사용자가 누락된 이미지의 재생성을 요청. 같은 파일명으로 generate_image 호출.`,
                }),
              });
            } catch { /* ignore — fall back to plain re-poll */ }
          }
          setRetryKey((k) => k + 1);
        }}
      >
        <span className="text-[#a08888] text-sm">이미지 로드 실패 — 탭하여 재생성 요청</span>
      </div>
    );
  }

  const src = withRetryMarker(buildFileUrl(imgPath, sessionId, personaName, source), imgRetryCount);
  const handleImageLoad = () => {
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onReady?.();
  };

  // <img> GET failed (most often ERR_NO_BUFFER_SPACE on Windows during burst loads).
  // HEAD succeeded so the file is *there* — schedule a backoff retry by bumping the
  // src marker. After MAX_IMG_RETRIES, surface the manual-regenerate UI.
  const handleImageError = () => {
    if (imgRetryTimerRef.current) clearTimeout(imgRetryTimerRef.current);
    if (imgRetryCount >= MAX_IMG_RETRIES) {
      setState("error");
      return;
    }
    const delay = imgBackoffMs(imgRetryCount);
    imgRetryTimerRef.current = setTimeout(() => {
      setImgRetryCount((c) => c + 1);
    }, delay);
  };

  return (
    <>
      <div className="block my-2 cursor-zoom-in" onClick={() => setShowModal(true)}>
        <img
          src={src}
          alt={imgPath}
          className="max-w-full rounded-lg max-h-[600px] object-contain hover:opacity-90 transition-opacity"
          onLoad={handleImageLoad}
          onError={handleImageError}
        />
      </div>
      {showModal && <ImageModal src={src} onClose={() => setShowModal(false)} />}
    </>
  );
}
