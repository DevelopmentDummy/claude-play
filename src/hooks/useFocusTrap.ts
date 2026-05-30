"use client";
import { useEffect, useRef } from "react";

interface FocusTrapOptions {
  active?: boolean;
  initialFocus?: boolean;
  restoreFocus?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  opts: FocusTrapOptions = {}
) {
  const { active = true, initialFocus = true, restoreFocus = true } = opts;
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prevActive = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    if (initialFocus && !node.contains(document.activeElement)) {
      const first = focusables()[0];
      (first ?? node).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !node.contains(cur))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault(); first.focus();
      }
    };
    node.addEventListener("keydown", onKeyDown);

    return () => {
      node.removeEventListener("keydown", onKeyDown);
      if (restoreFocus && prevActive && typeof prevActive.focus === "function") {
        prevActive.focus();
      }
    };
  }, [active, initialFocus, restoreFocus]);

  return ref;
}
