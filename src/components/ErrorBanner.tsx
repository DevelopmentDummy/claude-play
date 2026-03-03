"use client";

import { useEffect } from "react";

interface ErrorBannerProps {
  error: string | null;
  onDismiss: () => void;
}

export default function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  useEffect(() => {
    if (error) {
      const timer = setTimeout(onDismiss, 10000);
      return () => clearTimeout(timer);
    }
  }, [error, onDismiss]);

  if (!error) return null;

  return (
    <div className="px-4 py-2 bg-[rgba(255,77,106,0.12)] text-error text-xs border-b border-[rgba(255,77,106,0.25)] whitespace-pre-wrap break-words max-h-[100px] overflow-y-auto shrink-0">
      {error}
    </div>
  );
}
