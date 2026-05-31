/**
 * Shared inline-text tokenizer for RP-style markdown-lite syntax.
 *
 * Recognized tokens (in addition to plain text):
 * - `**bold**`              → bold
 * - `*action*`              → action / narration (italic, colored)
 * - `***both***`            → bold + action
 * - `` `code` ``            → inline code (literal; contents not re-parsed)
 * - `'thought'` / `‘thought’` → thought / inner monologue
 * - `$PANEL:name$`          → inline panel placeholder
 * - `$IMAGE:path$`          → inline image placeholder
 *
 * Emphasis (`*` / `**`) is parsed with a CommonMark-style delimiter-stack
 * algorithm restricted to the `*` delimiter. Consequences:
 * - Nesting works in both directions: `*a **b** c*`, `**a *b* c**`.
 * - Unmatched `*` stay literal text (don't swallow the rest of the line).
 * - Left/right-flanking rules mean a `*` adjacent to whitespace on its inner
 *   side can't open/close, so stray / space-padded asterisks are literal.
 *
 * Code, thought, panel and image are atomic: they are scanned first and consume
 * their content (a `*` inside code or a thought stays literal), but emphasis can
 * still wrap around them. Only bold and action nest, so the nesting state is two
 * bits and the output is a flat segment list with style flags (see
 * {@link InlineSegment}) rather than a tree.
 *
 * Two outputs are supported:
 * - {@link tokenize}: returns the segment stream so callers (e.g. React) can
 *   decide their own rendering. Used by ChatMessages.
 * - {@link formatInlineHtml}: emits an HTML string with inline styles for
 *   color-bearing tokens. Used by Shadow DOM panels (where Tailwind /
 *   external stylesheets are not available).
 */

export interface StyleFlags {
  bold?: boolean;
  action?: boolean;
}

export type InlineSegment =
  | ({ kind: "text"; value: string } & StyleFlags)
  | ({ kind: "code"; value: string } & StyleFlags)
  | ({ kind: "thought"; value: string } & StyleFlags)
  | { kind: "panel"; name: string }
  | { kind: "image"; path: string };

// ----------------------------------------------------------------------------
// Internal parse model
// ----------------------------------------------------------------------------

interface Delim {
  pos: number; // index of this run's item in the items array
  star: number; // remaining (unconsumed) asterisks
  orig: number; // original run length (for the rule-of-3)
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
}

type Item =
  | { kind: "text"; value: string; bold: boolean; action: boolean }
  | { kind: "code"; value: string; bold: boolean; action: boolean }
  | { kind: "thought"; value: string; bold: boolean; action: boolean }
  | { kind: "panel"; name: string }
  | { kind: "image"; path: string }
  | { kind: "stars"; delim: Delim; bold?: boolean; action?: boolean };

const isWs = (c: string | undefined): boolean => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined): boolean => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// CommonMark flanking. `before`/`after` are the chars surrounding the run in the
// source; a string boundary counts as whitespace.
function leftFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWs(after)) return false;
  if (!isPunct(after)) return true;
  return isWs(before) || isPunct(before);
}
function rightFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWs(before)) return false;
  if (!isPunct(before)) return true;
  return isWs(after) || isPunct(after);
}

// Thought quotes ('...' / ‘...’) use flanking too, so apostrophes inside words
// (it's, don't) and possessives (James') stay literal: a quote may OPEN only when
// the preceding char isn't a letter/digit and the next isn't whitespace, and may
// CLOSE only when the preceding char isn't whitespace and the next isn't a
// letter/digit. Apostrophes inside a thought (e.g. 'he said don't') can't close,
// so they're naturally skipped.
function quoteCanOpen(text: string, i: number): boolean {
  return !isWord(text[i - 1]) && !isWs(text[i + 1]);
}
function quoteCanClose(text: string, i: number): boolean {
  return !isWs(text[i - 1]) && !isWord(text[i + 1]);
}
interface NextClose {
  straight: Int32Array; // next close-eligible ' or ’ at index >= k  (for straight opens)
  curly: Int32Array; // next close-eligible ’ at index >= k          (for curly opens)
}

// Precompute, for every index, the next quote eligible to CLOSE a thought, so
// matchThought is O(1). Without this, every opening quote that never finds a
// close re-scans to EOF and scan() advances one char, making quote-heavy input
// (many unmatched opens) O(n²) — a multi-second synchronous render hang.
function buildNextClose(text: string): NextClose {
  const n = text.length;
  const straight = new Int32Array(n + 1);
  const curly = new Int32Array(n + 1);
  straight[n] = -1;
  curly[n] = -1;
  let nextS = -1;
  let nextC = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (quoteCanClose(text, k)) {
      const ch = text[k];
      if (ch === "'" || ch === "’") nextS = k;
      if (ch === "’") nextC = k;
    }
    straight[k] = nextS;
    curly[k] = nextC;
  }
  return { straight, curly };
}

// If a thought starts at i, return its end index (exclusive); else -1. Content
// must be non-empty. A straight open closes on ' or ’; a curly open closes on ’.
function matchThought(text: string, i: number, nextClose: NextClose): number {
  const open = text[i];
  if (open !== "'" && open !== "‘") return -1;
  if (!quoteCanOpen(text, i)) return -1;
  const k = (open === "‘" ? nextClose.curly : nextClose.straight)[i + 1];
  if (k <= i + 1) return -1; // -1 (no close) or i+1 (empty '' content) → not a thought
  return k + 1;
}

// Sticky atomic-token matchers (anchored at the scan position).
const RE_PANEL = /\$PANEL:([^$]+)\$/y;
const RE_IMAGE = /\$IMAGE:([^$]+)\$/y;
const RE_CODE = /`([^`]+)`/y;

function matchAt(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  const m = re.exec(text);
  return m && m.index === i ? m : null;
}

function scan(text: string): { items: Item[]; delims: Delim[] } {
  const items: Item[] = [];
  const delims: Delim[] = [];
  let buf = "";
  let nextClose: NextClose | null = null; // built lazily on first quote char
  const flush = () => {
    if (buf) {
      items.push({ kind: "text", value: buf, bold: false, action: false });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === "$") {
      const pm = matchAt(RE_PANEL, text, i);
      if (pm) { flush(); items.push({ kind: "panel", name: pm[1] }); i = RE_PANEL.lastIndex; continue; }
      const im = matchAt(RE_IMAGE, text, i);
      if (im) { flush(); items.push({ kind: "image", path: im[1] }); i = RE_IMAGE.lastIndex; continue; }
      buf += c; i++; continue;
    }

    if (c === "`") {
      const cm = matchAt(RE_CODE, text, i);
      if (cm) { flush(); items.push({ kind: "code", value: cm[1], bold: false, action: false }); i = RE_CODE.lastIndex; continue; }
      buf += c; i++; continue;
    }

    if (c === "'" || c === "‘") {
      if (!nextClose) nextClose = buildNextClose(text);
      const end = matchThought(text, i, nextClose);
      if (end !== -1) {
        flush();
        items.push({ kind: "thought", value: text.slice(i, end), bold: false, action: false });
        i = end;
        continue;
      }
      buf += c; i++; continue;
    }

    if (c === "*") {
      let j = i;
      while (j < text.length && text[j] === "*") j++;
      const run = j - i;
      const before = i > 0 ? text[i - 1] : undefined;
      const after = j < text.length ? text[j] : undefined;
      flush();
      const delim: Delim = {
        pos: items.length,
        star: run,
        orig: run,
        canOpen: leftFlanking(before, after),
        canClose: rightFlanking(before, after),
        prev: null,
        next: null,
      };
      items.push({ kind: "stars", delim });
      delims.push(delim);
      i = j;
      continue;
    }

    buf += c;
    i++;
  }

  flush();
  return { items, delims };
}

// CommonMark process_emphasis, single delimiter char (`*`). Matches each
// can-close run to the nearest preceding can-open run, consuming 2 stars (bold)
// or 1 (action), honoring the rule-of-3, and tagging the items between them.
function processEmphasis(items: Item[], delims: Delim[]): void {
  if (delims.length === 0) return;
  for (let k = 0; k < delims.length; k++) {
    delims[k].prev = k > 0 ? delims[k - 1] : null;
    delims[k].next = k < delims.length - 1 ? delims[k + 1] : null;
  }

  const unlink = (d: Delim) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    d.prev = null;
    d.next = null;
  };

  // openers_bottom keyed by (canClose-run can also open ? 3 : 0) + run%3
  const openersBottom: (Delim | null)[] = [null, null, null, null, null, null];

  let closer: Delim | null = delims[0];
  while (closer) {
    if (!closer.canClose) { closer = closer.next; continue; }

    // Key by the closer's ORIGINAL run length (immutable), per CommonMark — a
    // multi-star closer that is kept across partial matches must not change its
    // openers_bottom bucket mid-loop, or valid openers get skipped.
    const bucket = (closer.canOpen ? 3 : 0) + (closer.orig % 3);
    let opener: Delim | null = closer.prev;
    let found = false;
    while (opener && opener !== openersBottom[bucket]) {
      const oddMatch =
        (closer.canOpen || opener.canClose) &&
        closer.orig % 3 !== 0 &&
        (opener.orig + closer.orig) % 3 === 0;
      if (opener.canOpen && opener.star > 0 && !oddMatch) { found = true; break; }
      opener = opener.prev;
    }

    const oldCloser = closer;
    if (found && opener) {
      const use = opener.star >= 2 && closer.star >= 2 ? 2 : 1;
      const bold = use === 2;
      for (let p = opener.pos + 1; p < closer.pos; p++) {
        const it = items[p];
        // panel/image carry no style; text/code/thought and leftover literal
        // stars (e.g. the lone `*` in `**a*b**`) inherit the enclosing style.
        if (it.kind === "panel" || it.kind === "image") continue;
        if (bold) it.bold = true;
        else it.action = true;
      }
      opener.star -= use;
      closer.star -= use;
      // drop delimiters strictly between the matched pair — they can't match now
      let between = opener.next;
      while (between && between !== closer) {
        const nxt = between.next;
        unlink(between);
        between = nxt;
      }
      if (opener.star === 0) unlink(opener);
      if (closer.star === 0) {
        const nxt = closer.next;
        unlink(closer);
        closer = nxt;
      }
      // else: keep the same closer; it may still match a further opener
    } else {
      openersBottom[bucket] = oldCloser.prev;
      const nxt = oldCloser.next;
      if (!oldCloser.canOpen) unlink(oldCloser);
      closer = nxt;
    }
  }
}

function pushText(out: InlineSegment[], value: string, bold: boolean, action: boolean): void {
  if (!value) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text" && !!last.bold === bold && !!last.action === action) {
    last.value += value;
    return;
  }
  const seg: InlineSegment = { kind: "text", value };
  if (bold) seg.bold = true;
  if (action) seg.action = true;
  out.push(seg);
}

function emit(items: Item[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "stars":
        if (it.delim.star > 0) pushText(out, "*".repeat(it.delim.star), !!it.bold, !!it.action);
        break;
      case "text":
        pushText(out, it.value, it.bold, it.action);
        break;
      case "code": {
        const seg: InlineSegment = { kind: "code", value: it.value };
        if (it.bold) seg.bold = true;
        if (it.action) seg.action = true;
        out.push(seg);
        break;
      }
      case "thought": {
        const seg: InlineSegment = { kind: "thought", value: it.value };
        if (it.bold) seg.bold = true;
        if (it.action) seg.action = true;
        out.push(seg);
        break;
      }
      case "panel":
        out.push({ kind: "panel", name: it.name });
        break;
      case "image":
        out.push({ kind: "image", path: it.path });
        break;
    }
  }
  return out;
}

/**
 * Parse RP markdown-lite into a flat segment stream. Bold and action may nest;
 * code/thought/panel/image are atomic. Unmatched `*` come back as literal text.
 */
export function tokenize(text: string): InlineSegment[] {
  const { items, delims } = scan(text);
  processEmphasis(items, delims);
  return emit(items);
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
  /** Color for 'action' (action / narration) tokens. Default: #e8a862. */
  actionColor?: string;
}

/**
 * Render segments as an HTML string with inline styles for color-bearing
 * tokens. `$PANEL` / `$IMAGE` are emitted as placeholder `<span>` elements with
 * `data-inline-panel` / `data-inline-image` attributes — callers can post-process
 * those to mount their own content.
 */
export function formatInlineHtml(text: string, opts: FormatInlineHtmlOptions = {}): string {
  const thoughtColor = opts.thoughtColor ?? "#7eb8e0";
  const actionColor = opts.actionColor ?? "#e8a862";
  const parts: string[] = [];
  for (const seg of tokenize(text)) {
    switch (seg.kind) {
      case "text": {
        let inner = escapeHtml(seg.value);
        if (seg.action) inner = `<em style="color:${actionColor};font-style:italic">${inner}</em>`;
        if (seg.bold) inner = `<strong>${inner}</strong>`;
        parts.push(inner);
        break;
      }
      case "code": {
        let inner = `<code>${escapeHtml(seg.value)}</code>`;
        if (seg.action) inner = `<em style="color:${actionColor};font-style:italic">${inner}</em>`;
        if (seg.bold) inner = `<strong>${inner}</strong>`;
        parts.push(inner);
        break;
      }
      case "thought": {
        // thought keeps its own color; only bold may stack on top of it.
        let inner = `<em style="color:${thoughtColor};font-style:italic">${escapeHtml(seg.value)}</em>`;
        if (seg.bold) inner = `<strong>${inner}</strong>`;
        parts.push(inner);
        break;
      }
      case "panel":
        parts.push(`<span data-inline-panel="${escapeHtml(seg.name)}"></span>`);
        break;
      case "image":
        parts.push(`<span data-inline-image="${escapeHtml(seg.path)}"></span>`);
        break;
    }
  }
  return parts.join("");
}
