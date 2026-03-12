"use client";

import { useState, useEffect, useRef } from "react";
import ImageModal from "./ImageModal";

interface InlineImageProps {
  sessionId: string;
  path: string;
  onReady?: () => void;
}

type ImageState = "loading" | "ready" | "error";

const POLL_INTERVAL = 2000;
const MAX_POLLS = 23; // ~45 seconds

export default function InlineImage({ sessionId, path: imgPath, onReady }: InlineImageProps) {
  const [state, setState] = useState<ImageState>("loading");
  const [showModal, setShowModal] = useState(false);
  const [cacheBuster] = useState(() => Date.now());
  const [retryKey, setRetryKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);
  const readyNotifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    pollCountRef.current = 0;
    readyNotifiedRef.current = false;

    const poll = async () => {
      if (cancelled) return;

      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/files/${encodeURIComponent(imgPath)}?v=${cacheBuster}`,
          {
            method: "HEAD",
            cache: "no-store",
            headers: {
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            },
          }
        );

        if (cancelled) return;

        if (res.ok) {
          setState("ready");
          return;
        }

        if (res.status === 404) {
          pollCountRef.current++;
          if (pollCountRef.current >= MAX_POLLS) {
            setState("error");
            return;
          }
          timerRef.current = setTimeout(poll, POLL_INTERVAL);
          return;
        }

        // Other error status — retry instead of giving up immediately
        pollCountRef.current++;
        if (pollCountRef.current >= MAX_POLLS) {
          setState("error");
          return;
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL);
      } catch {
        if (cancelled) return;
        // Network error — retry instead of giving up immediately
        pollCountRef.current++;
        if (pollCountRef.current >= MAX_POLLS) {
          setState("error");
          return;
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, imgPath, retryKey]);

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
        onClick={() => {
          setState("loading");
          setRetryKey((k) => k + 1);
        }}
      >
        <span className="text-[#a08888] text-sm">이미지 로드 실패 — 탭하여 재시도</span>
      </div>
    );
  }

  const src = `/api/sessions/${sessionId}/files/${encodeURIComponent(imgPath)}?v=${cacheBuster}`;
  const handleImageLoad = () => {
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onReady?.();
  };

  return (
    <>
      <div className="block my-2 cursor-zoom-in" onClick={() => setShowModal(true)}>
        <img
          src={src}
          alt={imgPath}
          className="max-w-full rounded-lg max-h-[400px] object-contain hover:opacity-90 transition-opacity"
          onLoad={handleImageLoad}
        />
      </div>
      {showModal && <ImageModal src={src} onClose={() => setShowModal(false)} />}
    </>
  );
}
