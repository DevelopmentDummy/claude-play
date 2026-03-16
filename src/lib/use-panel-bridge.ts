"use client";

import { useEffect } from "react";

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
      sessionId,
      data: panelData || {},
      get isStreaming() {
        return !!(window as unknown as Record<string, unknown>).__bridgeIsStreaming;
      },
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
  }, [sessionId, panelData]);
}
