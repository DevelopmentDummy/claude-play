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
        "text-mute": "var(--text-mute)",
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
        "lobby-bg": "var(--lobby-bg)",
        "lobby-surface": "var(--lobby-surface)",
        "lobby-card": "var(--lobby-card)",
        "lobby-border": "var(--lobby-border)",
        "lobby-border-hover": "var(--lobby-border-hover)",
        plum: "var(--plum)",
        "plum-soft": "var(--plum-soft)",
        "plum-hairline": "var(--plum-hairline)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        serif: ["var(--font-playfair)", "Georgia", "serif"],
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
