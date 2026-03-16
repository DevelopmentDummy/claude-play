"use client";

import { useEffect } from "react";

/** Internal event prefix for bridge events dispatched on window */
const EVT_PREFIX = "__bridge_evt:";

/** Supported panel bridge event names */
type BridgeEvent = "turnStart" | "turnEnd" | "imageUpdated";

/**
 * Dispatch a bridge event from the app to panel scripts.
 * Called by ChatPage when relevant state changes happen.
 */
export function dispatchBridgeEvent(event: BridgeEvent, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(`${EVT_PREFIX}${event}`, { detail }));
}

export function usePanelBridge(
  sessionId: string | undefined,
  panelData: Record<string, unknown> | undefined,
) {
  useEffect(() => {
    const bridge = {
      sendMessage(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail: text }));
      },
      fillInput(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
      },
      async updateVariables(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async updateData(fileName: string, patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables?file=${encodeURIComponent(fileName)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async updateLayout(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/layout`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async queueEvent(header: string) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header }),
        });
        return res.json();
      },
      async runTool(toolName: string, args?: Record<string, unknown>) {
        if (!sessionId) return { ok: false, error: "No session" };
        const res = await fetch(`/api/sessions/${sessionId}/tools/${encodeURIComponent(toolName)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: args || {} }),
        });
        return res.json();
      },
      async showPopup(template: string, opts?: { duration?: number; vars?: Record<string, unknown> }) {
        if (!sessionId) return;
        const existing = ((panelData || {}).__popups as Array<Record<string, unknown>>) || [];
        const entry: Record<string, unknown> = { template };
        if (opts?.duration) entry.duration = opts.duration;
        if (opts?.vars) entry.vars = opts.vars;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ __popups: [...existing, entry] }),
        });
        return res.json();
      },
      /** Subscribe to a bridge event. Returns an unsubscribe function. */
      on(event: string, handler: (detail?: unknown) => void): () => void {
        const wrapped = (e: Event) => handler((e as CustomEvent).detail);
        window.addEventListener(`${EVT_PREFIX}${event}`, wrapped);
        return () => window.removeEventListener(`${EVT_PREFIX}${event}`, wrapped);
      },
      sessionId,
      data: panelData || {},
      get isStreaming() {
        return !!(window as unknown as Record<string, unknown>).__bridgeIsStreaming;
      },
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
  }, [sessionId, panelData]);
}
