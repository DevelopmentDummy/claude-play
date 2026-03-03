import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-light": "var(--surface-light)",
        text: "var(--text)",
        "text-dim": "var(--text-dim)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-glow": "var(--accent-glow)",
        "user-bubble": "var(--user-bubble)",
        "assistant-bubble": "var(--assistant-bubble)",
        error: "var(--error)",
        success: "var(--success)",
        warning: "var(--warning)",
        border: "var(--border)",
        "code-bg": "var(--code-bg)",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionDuration: {
        fast: "150ms",
        normal: "250ms",
      },
    },
  },
  plugins: [],
};

export default config;
