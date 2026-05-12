/**
 * Shared inline-text tokenizer for RP-style markdown-lite syntax.
 *
 * Recognized tokens (in addition to plain text):
 * - `**bold**`              → bold
 * - `*italic*`              → italic (action/narration)
 * - `` `code` ``            → inline code
 * - `'thought'` / `‘thought’` → thought/inner monologue
 * - `$PANEL:name$`          → inline panel placeholder
 * - `$IMAGE:path$`          → inline image placeholder
 *
 * Two outputs are supported:
 * - {@link tokenize}: returns a token stream so callers (e.g. React) can
 *   decide their own rendering. Used by ChatMessages.
 * - {@link formatInlineHtml}: emits an HTML string with inline styles for
 *   color-bearing tokens. Used by Shadow DOM panels (where Tailwind /
 *   external stylesheets are not available).
 */

export type InlineToken =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "code"; value: string }
  | { type: "thought"; value: string }
  | { type: "panel"; name: string; raw: string }
  | { type: "image"; path: string; raw: string };

const INLINE_RE_SOURCE =
  "(\\$PANEL:[^$]+\\$|\\$IMAGE:[^$]+\\$|\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|`[^`]+`|\\u2018[^\\u2019]+\\u2019|'[^']+['\\u2019])";

export function tokenize(text: string): InlineToken[] {
  const re = new RegExp(INLINE_RE_SOURCE, "g");
  const out: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ type: "text", value: text.slice(last, m.index) });
    }
    const raw = m[0];
    if (raw.startsWith("$PANEL:") && raw.endsWith("$")) {
      out.push({ type: "panel", name: raw.slice(7, -1), raw });
    } else if (raw.startsWith("$IMAGE:") && raw.endsWith("$")) {
      out.push({ type: "image", path: raw.slice(7, -1), raw });
    } else if (raw.startsWith("**") && raw.endsWith("**")) {
      out.push({ type: "bold", value: raw.slice(2, -2) });
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      out.push({ type: "code", value: raw.slice(1, -1) });
    } else if (raw.startsWith("‘") || (raw.startsWith("'") && /['’]$/.test(raw))) {
      out.push({ type: "thought", value: raw });
    } else {
      out.push({ type: "italic", value: raw.slice(1, -1) });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) {
    out.push({ type: "text", value: text.slice(last) });
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

export interface FormatInlineHtmlOptions {
  /** Color for 'thought' tokens (single quotes / curly quotes). Default: #7eb8e0. */
  thoughtColor?: string;
  /** Color for 'italic' (action / narration) tokens. Default: #e8a862. */
  actionColor?: string;
}

/**
 * Render tokens as an HTML string with inline styles for color-bearing tokens.
 * `$PANEL` / `$IMAGE` are emitted as placeholder `<span>` elements with
 * `data-inline-panel` / `data-inline-image` attributes — callers can post-process
 * those to mount their own content.
 */
export function formatInlineHtml(text: string, opts: FormatInlineHtmlOptions = {}): string {
  const thoughtColor = opts.thoughtColor ?? "#7eb8e0";
  const actionColor = opts.actionColor ?? "#e8a862";
  const parts: string[] = [];
  for (const t of tokenize(text)) {
    switch (t.type) {
      case "text":
        parts.push(escapeHtml(t.value));
        break;
      case "bold":
        parts.push(`<strong>${escapeHtml(t.value)}</strong>`);
        break;
      case "italic":
        parts.push(`<em style="color:${actionColor};font-style:italic">${escapeHtml(t.value)}</em>`);
        break;
      case "code":
        parts.push(`<code>${escapeHtml(t.value)}</code>`);
        break;
      case "thought":
        parts.push(`<em style="color:${thoughtColor};font-style:italic">${escapeHtml(t.value)}</em>`);
        break;
      case "panel":
        parts.push(`<span data-inline-panel="${escapeHtml(t.name)}"></span>`);
        break;
      case "image":
        parts.push(`<span data-inline-image="${escapeHtml(t.path)}"></span>`);
        break;
    }
  }
  return parts.join("");
}
