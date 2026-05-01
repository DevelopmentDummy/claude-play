"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { usePanelBridge } from "@/lib/use-panel-bridge";
import { getPanelActionRegistry, parsePanelActions, stripPanelActions } from "@/lib/panel-action-registry";

interface PanelSlotProps {
  name: string;
  html: string;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onSendMessage?: (text: string) => void;
}

interface PanelSandbox {
  timeouts: Set<ReturnType<typeof setTimeout>>;
  intervals: Set<ReturnType<typeof setInterval>>;
  rafs: Set<number>;
  bridgeUnsubs: Array<() => void>;
  windowListeners: Array<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }>;
}

function clearSandbox(sb: PanelSandbox): void {
  sb.timeouts.forEach((t) => clearTimeout(t));
  sb.timeouts.clear();
  sb.intervals.forEach((t) => clearInterval(t));
  sb.intervals.clear();
  sb.rafs.forEach((id) => cancelAnimationFrame(id));
  sb.rafs.clear();
  for (const fn of sb.bridgeUnsubs) {
    try { fn(); } catch { /* ignore */ }
  }
  sb.bridgeUnsubs.length = 0;
  for (const { target, type, listener, options } of sb.windowListeners) {
    try { target.removeEventListener(type, listener, options); } catch { /* ignore */ }
  }
  sb.windowListeners.length = 0;
}

export default function PanelSlot({ name, html, sessionId, panelData, onSendMessage }: PanelSlotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const onSendRef = useRef(onSendMessage);
  onSendRef.current = onSendMessage;
  const sandboxRef = useRef<PanelSandbox>({ timeouts: new Set(), intervals: new Set(), rafs: new Set(), bridgeUnsubs: [], windowListeners: [] });
  const [modalSrc, setModalSrc] = useState<string | null>(null);

  usePanelBridge(sessionId, panelData);

  // Attach shadow DOM and install click handler (once)
  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
      // Intercept image clicks inside shadow DOM
      shadowRef.current.addEventListener("click", (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "IMG") {
          if (target.hasAttribute("data-no-zoom") || target.closest("[data-no-zoom]")) return;
          const src = (target as HTMLImageElement).src;
          if (src) { e.preventDefault(); setModalSrc(src); }
          return;
        }
        const anchor = target.closest("a");
        if (anchor) {
          if (anchor.hasAttribute("data-no-zoom")) return;
          const href = anchor.getAttribute("href") || "";
          if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(href)) {
            e.preventDefault();
            setModalSrc(anchor.href);
          }
        }
      });
    }
  }, []);

  // Re-render shadow content only when html actually changes
  const prevHtmlRef = useRef<string>("");
  useEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;

    shadow.innerHTML =
      `<style>:host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;color:#e0e0e0;}img{cursor:zoom-in;}</style>` +
      stripPanelActions(html);

    // Auto-poll images that haven't loaded yet (deferred generation)
    installImagePolling(shadow);

    // Parse <panel-actions> and register metadata
    const actionMetas = parsePanelActions(html);
    if (actionMetas.length > 0 && sessionId) {
      getPanelActionRegistry(sessionId).registerMeta(name, actionMetas);
    }

    // Set panel name context for registerAction calls in panel scripts
    (window as unknown as Record<string, unknown>).__currentPanelName = name;

    // Re-rendering this panel: discard previously registered timers/listeners so
    // stale handlers from the prior HTML version don't keep firing alongside the
    // new ones (the same script body can be re-executed multiple times).
    clearSandbox(sandboxRef.current);

    // Sandboxed globals for panel script execution. All side-effecting timer/listener
    // registrations are tracked so they can be cleared on unmount or re-render.
    const sandbox = sandboxRef.current;
    const sbSetTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = setTimeout(() => {
        sandbox.timeouts.delete(id);
        if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
        else new Function(handler as string)();
      }, timeout);
      sandbox.timeouts.add(id);
      return id;
    };
    const sbClearTimeout = (id: ReturnType<typeof setTimeout>) => {
      sandbox.timeouts.delete(id);
      clearTimeout(id);
    };
    const sbSetInterval = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = setInterval(() => {
        if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
        else new Function(handler as string)();
      }, timeout);
      sandbox.intervals.add(id);
      return id;
    };
    const sbClearInterval = (id: ReturnType<typeof setInterval>) => {
      sandbox.intervals.delete(id);
      clearInterval(id);
    };
    const sbRequestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = requestAnimationFrame((t) => {
        sandbox.rafs.delete(id);
        cb(t);
      });
      sandbox.rafs.add(id);
      return id;
    };
    const sbCancelAnimationFrame = (id: number) => {
      sandbox.rafs.delete(id);
      cancelAnimationFrame(id);
    };

    // Wrap __panelBridge.on() so unsubscribe is recorded automatically.
    const realBridge = (window as unknown as Record<string, unknown>).__panelBridge as
      | (Record<string, unknown> & { on?: (event: string, handler: (detail?: unknown) => void) => () => void })
      | undefined;
    const sandboxedBridge: Record<string, unknown> = realBridge
      ? new Proxy(realBridge, {
          get(target, prop) {
            if (prop === "on" && typeof target.on === "function") {
              return (event: string, handler: (detail?: unknown) => void) => {
                const unsub = target.on!(event, handler);
                sandbox.bridgeUnsubs.push(unsub);
                return unsub;
              };
            }
            return Reflect.get(target, prop);
          },
        }) as Record<string, unknown>
      : {};

    // Wrap window so any window.setTimeout / window.addEventListener / window.dispatchEvent
    // call from panel script also routes through the sandbox. Property access falls back
    // to the real window for read-only globals (location, navigator, etc.).
    const sbAddEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      window.addEventListener(type, listener, options);
      sandbox.windowListeners.push({ target: window, type, listener, options });
    };
    const sbRemoveEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      window.removeEventListener(type, listener, options);
      const idx = sandbox.windowListeners.findIndex(
        (e) => e.target === window && e.type === type && e.listener === listener,
      );
      if (idx >= 0) sandbox.windowListeners.splice(idx, 1);
    };

    const overrides: Record<string, unknown> = {
      setTimeout: sbSetTimeout,
      clearTimeout: sbClearTimeout,
      setInterval: sbSetInterval,
      clearInterval: sbClearInterval,
      requestAnimationFrame: sbRequestAnimationFrame,
      cancelAnimationFrame: sbCancelAnimationFrame,
      addEventListener: sbAddEventListener,
      removeEventListener: sbRemoveEventListener,
      __panelBridge: sandboxedBridge,
    };

    const sandboxedWindow: Window = new Proxy(window, {
      get(target, prop) {
        if (typeof prop === "string" && prop in overrides) return overrides[prop];
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) {
        return Reflect.set(target, prop, value);
      },
    }) as Window;

    // Execute <script> tags manually via Function() to avoid DOM insertion issues
    // Skip non-JS scripts (e.g. type="application/json" used as embedded data)
    const scripts = Array.from(shadow.querySelectorAll("script:not([type]), script[type='text/javascript']"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        // Remove full declaration (e.g. `const shadow = document.currentScript.getRootNode();`)
        // to avoid TDZ collision with the Function("shadow", ...) parameter
        code = code.replace(/(?:const|let|var)\s+shadow\s*=\s*document\.currentScript\??\.getRootNode\??\(\)\s*;?/g, "");
        // Replace remaining standalone calls
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function(
          "shadow",
          "window",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "addEventListener",
          "removeEventListener",
          "__panelBridge",
          code,
        );
        fn(
          shadow,
          sandboxedWindow,
          sbSetTimeout,
          sbClearTimeout,
          sbSetInterval,
          sbClearInterval,
          sbRequestAnimationFrame,
          sbCancelAnimationFrame,
          sbAddEventListener,
          sbRemoveEventListener,
          sandboxedBridge,
        );
      } catch (e) {
        console.warn(`[PanelSlot] Script error in "${name}":`, e);
      }
    }

    // Clear panel name context
    delete (window as unknown as Record<string, unknown>).__currentPanelName;
  }, [html, name]);

  // Cleanup panel action registry + sandbox on unmount
  useEffect(() => {
    const sandbox = sandboxRef.current;
    return () => {
      clearSandbox(sandbox);
      if (sessionId) getPanelActionRegistry(sessionId).clearPanel(name);
    };
  }, [name, sessionId]);

  return (
    <>
      <div className="bg-[rgba(15,15,26,0.25)] rounded-xl overflow-hidden border border-white/[0.06] shrink-0">
        <div className="px-4 py-2.5 text-[11px] font-semibold text-accent/80 uppercase tracking-wider">
          {name}
        </div>
        <div ref={containerRef} className="px-4 pb-4" />
      </div>
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
