"use client";

import { useEffect } from "react";
import { getPanelActionRegistry, type PanelActionHandler } from "./panel-action-registry";

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
      sendMessage(text: string, opts?: { silent?: boolean }) {
        const win = window as unknown as Record<string, unknown>;
        // Suppress during compound panel action execution
        if (win.__panelActionSuppressSend) {
          win.__panelActionSuppressedMsg = { text, opts };
          return;
        }
        const detail = opts?.silent ? { text, silent: true } : text;
        // If popups are playing/pending, queue the message for later delivery
        if (win.__popupsPlaying) {
          win.__pendingPanelMsg = detail;
          return;
        }
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail }));
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
      /** Open a modal. Auto-closes other modals in the same group (defined in layout.json). */
      async openModal(name: string, mode?: "dismissible" | true) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "open", name, mode: mode ?? "dismissible" }),
        });
        return res.json();
      },
      /** Close a specific modal. */
      async closeModal(name: string) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "close", name }),
        });
        return res.json();
      },
      /** Close all modals, optionally keeping some open. */
      async closeAllModals(except?: string[]) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "closeAll", except }),
        });
        return res.json();
      },
      async showPopup(template: string, opts?: { duration?: number; vars?: Record<string, unknown> }) {
        if (!sessionId) return;
        // Signal that popups are pending — sendMessage will queue until playback finishes
        const win = window as unknown as Record<string, unknown>;
        win.__popupsPlaying = true;
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
      /** Show a toast notification (non-blocking, stacks in bottom-right corner). */
      showToast(text: string, opts?: { duration?: number }) {
        window.dispatchEvent(new CustomEvent("bridge:toast", {
          detail: { text, duration: opts?.duration || 3000 },
        }));
      },
      /** Show a confirm dialog. Returns a Promise<boolean> (true = confirmed, false = cancelled). */
      confirm(message: string, opts?: { yesText?: string; noText?: string }): Promise<boolean> {
        return new Promise((resolve) => {
          const yesText = opts?.yesText || "확인";
          const noText = opts?.noText || "취소";
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;animation:__confirmFade 0.15s ease";
          overlay.innerHTML = `
            <style>@keyframes __confirmFade{from{opacity:0}to{opacity:1}}</style>
            <div style="background:#121829;border:1px solid var(--accent,#c8a44e);border-radius:8px;padding:16px 20px;min-width:240px;max-width:300px;font-family:'Segoe UI',sans-serif;color:#e0ddd4;box-shadow:0 4px 20px rgba(0,0,0,0.5)">
              <div style="font-size:13px;margin-bottom:14px;line-height:1.5;text-align:center">${message}</div>
              <div style="display:flex;gap:8px;justify-content:center">
                <button data-confirm="yes" style="padding:6px 20px;border-radius:5px;font-size:12px;cursor:pointer;font-family:'Segoe UI',sans-serif;border:1px solid var(--accent,#c8a44e);background:#1a2035;color:var(--accent,#c8a44e);transition:all 0.2s">${yesText}</button>
                <button data-confirm="no" style="padding:6px 20px;border-radius:5px;font-size:12px;cursor:pointer;font-family:'Segoe UI',sans-serif;border:1px solid #1e2a45;background:#0d1220;color:#7a7a8a;transition:all 0.2s">${noText}</button>
              </div>
            </div>`;
          const cleanup = (result: boolean) => { overlay.remove(); resolve(result); };
          overlay.querySelector("[data-confirm=yes]")!.addEventListener("click", () => cleanup(true));
          overlay.querySelector("[data-confirm=no]")!.addEventListener("click", () => cleanup(false));
          overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
          document.body.appendChild(overlay);
        });
      },
      /** Subscribe to a bridge event. Returns an unsubscribe function. */
      on(event: string, handler: (detail?: unknown) => void): () => void {
        const wrapped = (e: Event) => handler((e as CustomEvent).detail);
        window.addEventListener(`${EVT_PREFIX}${event}`, wrapped);
        return () => window.removeEventListener(`${EVT_PREFIX}${event}`, wrapped);
      },
      /** Register a panel action handler. panelName auto-detected from __currentPanelName or registry lookup. */
      registerAction(actionId: string, handler: PanelActionHandler, panelName?: string): void {
        if (!sessionId) return;
        const registry = getPanelActionRegistry(sessionId);
        const panel = panelName
          || (window as unknown as Record<string, unknown>).__currentPanelName as string
          || registry.findPanelByAction(actionId)
          || "";
        if (!panel) {
          console.warn("[panelBridge] registerAction: no panel name context for", actionId);
          return;
        }
        registry.registerHandler(panel, actionId, handler);
      },
      /** Execute a registered panel action. Records to history automatically. Panel auto-resolved from registry if not provided. */
      async executeAction(actionId: string, params?: Record<string, unknown>, panelName?: string): Promise<void> {
        if (!sessionId) return;
        const panel = panelName || (window as unknown as Record<string, unknown>).__currentPanelName as string || "";
        await getPanelActionRegistry(sessionId).execute(panel, actionId, params);
      },
      sessionId,
      data: panelData || {},
      get isStreaming() {
        return !!(window as unknown as Record<string, unknown>).__bridgeIsStreaming;
      },
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
    // sessionId is already set during getPanelActionRegistry(sessionId) creation
  }, [sessionId, panelData]);
}
