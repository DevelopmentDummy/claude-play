"use client";

import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ImageModalProps {
  src: string;
  onClose: () => void;
}

export default function ImageModal({ src, onClose }: ImageModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 확대 창이 최상위 — 같은 Esc가 아래 모달(useEscapeKey 등 window/document 리스너)까지
      // 닫지 않도록 window capture 단계에서 먼저 받아 전파를 끊는다.
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt=""
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
