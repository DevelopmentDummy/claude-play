"use client";

import { useCallback } from "react";
import { hexToRgba, lightenHex } from "@/lib/color-utils";

export interface LayoutConfig {
  panels: {
    position: "right" | "left" | "bottom" | "hidden";
    size: number;
    placement?: Record<string, "left" | "right">;
  };
  chat: {
    maxWidth: number | null;
    align: "stretch" | "center";
  };
  theme: {
    accent: string;
    bg: string;
    surface: string;
    surfaceLight: string;
    userBubble: string;
    assistantBubble: string;
    border: string;
    text: string;
    textDim: string;
  };
  customCSS: string;
}

export function useLayout() {
  const applyLayout = useCallback((layout: LayoutConfig | null, imageBase?: string) => {
    if (!layout) return;
    const root = document.documentElement.style;

    if (layout.theme) {
      const t = layout.theme;
      if (t.bg) root.setProperty("--bg", t.bg);
      if (t.surface) root.setProperty("--surface", hexToRgba(t.surface, 0.7));
      if (t.surfaceLight)
        root.setProperty("--surface-light", hexToRgba(t.surfaceLight, 0.7));
      if (t.text) root.setProperty("--text", t.text);
      if (t.textDim) root.setProperty("--text-dim", t.textDim);
      if (t.accent) {
        root.setProperty("--accent", t.accent);
        root.setProperty("--accent-hover", lightenHex(t.accent, 0.15));
        root.setProperty("--accent-glow", hexToRgba(t.accent, 0.35));
      }
      if (t.userBubble)
        root.setProperty("--user-bubble", hexToRgba(t.userBubble, 0.75));
      if (t.assistantBubble)
        root.setProperty(
          "--assistant-bubble",
          hexToRgba(t.assistantBubble, 0.75)
        );
      if (t.border) root.setProperty("--border", hexToRgba(t.border, 0.6));
    }

    if (layout.customCSS) {
      let style = document.getElementById("layout-custom-css");
      if (!style) {
        style = document.createElement("style");
        style.id = "layout-custom-css";
        document.head.appendChild(style);
      }
      // Replace {{__imageBase}} placeholders with actual image serving path
      let css = layout.customCSS;
      if (imageBase) {
        css = css.replace(/\{\{__imageBase\}\}/g, imageBase);
      }
      style.textContent = css;
    }
  }, []);

  const resetLayout = useCallback(() => {
    const root = document.documentElement.style;
    const vars = [
      "--bg",
      "--surface",
      "--surface-light",
      "--text",
      "--text-dim",
      "--accent",
      "--accent-hover",
      "--accent-glow",
      "--user-bubble",
      "--assistant-bubble",
      "--border",
    ];
    for (const v of vars) {
      root.removeProperty(v);
    }
    const customStyle = document.getElementById("layout-custom-css");
    if (customStyle) customStyle.remove();
  }, []);

  return { applyLayout, resetLayout };
}
