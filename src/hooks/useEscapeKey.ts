import { useEffect } from "react";

/**
 * Invoke `onEscape` when the Escape key is pressed, via a global keydown
 * listener. Pass `active=false` to disable the listener (e.g. while a modal is
 * closed or not the topmost in a stack) — equivalent to an early `if (!open) return`.
 */
export function useEscapeKey(onEscape: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onEscape, active]);
}
