# Inline emphasis nesting & robustness — design

- Date: 2026-05-31
- Scope: `src/lib/inline-formatter.ts` (parser) + `src/components/ChatMessages.tsx` (React renderer). `formatInlineHtml` public signature unchanged.
- Status: approved (approach A), implementation delegated.

## Problem

The RP chat/panel inline formatter (`inline-formatter.ts`) tokenizes markdown-lite
syntax (`**bold**`, `*action*`, `` `code` ``, `'thought'`, `$PANEL:..$`, `$IMAGE:..$`)
with a single flat regex:

```
(\$PANEL:[^$]+\$|\$IMAGE:[^$]+\$|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|‘[^’]+’|'[^']+['’])
```

Two failures, both rooted in the flat regex:

1. **No nesting (either direction).** Because the single-`*` alternative's `[^*]+`
   stops at any `*`, an outer `*` pairs with the first `*` of an inner `**`.
   - `*내용 **굵게** 내용*` → three `italic` tokens, bold lost entirely (verified).
   - `**굵게 *기울임* 굵게**` → stray `*` leaks as literal text (verified).
2. **Stray single `*` breaks the rest of the line.** The AI frequently emits loose
   single asterisks; greedy matching swallows spans and fragments the message.

We keep our semantics: `*` = action/narration (orange italic `#e8a862`),
`**` = bold. We do **not** adopt standard markdown's "`*` = emphasis" meaning.

## Approach (A): hand-rolled CommonMark-lite delimiter-stack, `*` only

Replace the flat regex for emphasis with a two-phase parser modeled on CommonMark's
emphasis algorithm, restricted to the `*` delimiter:

1. **Scan** left-to-right into an item list. Atomic tokens (panel, image, code,
   thought) are matched first and consume their content (so a `*` inside code or a
   thought stays literal). Runs of `*` become *delimiter* items classified as
   left/right-flanking. Everything else is plain text.
2. **process_emphasis** (delimiter stack): match the nearest can-close run to the
   nearest preceding can-open run, consuming 1 star (→ action) or 2 stars (→ bold)
   per match, honoring the "rule of 3". Matched ranges set style flags on the items
   between the delimiters. Unmatched `*` remain literal text.

This yields, in one move: **both-direction nesting**, **unmatched-`*`-is-literal**,
and **flanking** (a `*` adjacent to whitespace on its inner side can't open/close —
kills the stray-asterisk fragmentation).

Rejected alternatives:
- **B. Minimal stack without flanking** — nesting works but space-adjacent stray
  `*` still fragments; only half the robustness goal.
- **C. markdown-it / micromark** — most standard but adds a dependency, needs block
  markdown disabled and `em`→action remapping plus custom rules for our tokens.
  Conflicts with the lightweight custom-token design.

## Token (segment) model

Nesting is restricted to **bold ↔ action only** (code/thought/panel/image are
atomic — their *contents* are not re-parsed, though emphasis may wrap around them).
With only two nestable styles, the nesting state is exactly two bits, so we use a
**flat segment list with style flags** instead of a tree:

```ts
interface StyleFlags { bold?: boolean; action?: boolean }
type InlineSegment =
  | ({ kind: "text";    value: string } & StyleFlags)
  | ({ kind: "code";    value: string } & StyleFlags)
  | ({ kind: "thought"; value: string } & StyleFlags)
  | { kind: "panel"; name: string }
  | { kind: "image"; path: string };
```

- `*액션 **굵게** 액션*` → `text("액션 ",{action})`, `text("굵게",{action,bold})`, `text(" 액션",{action})`
- `**굵게 *액션* 굵게**` → `text("굵게 ",{bold})`, `text("액션",{bold,action})`, `text(" 굵게",{bold})`
- `***굵은액션***` → `text("굵은액션",{bold,action})`

Renderers wrap per flag (bold outer): `<strong><em>…</em></strong>`. No recursion.
If we later make thought/code containers, promote to a tree then (YAGNI now).

## Flanking & rule-of-3 (parser details)

For a `*` run, with `before`/`after` = the chars immediately around it in the
source (string boundary counts as whitespace):

- `whitespace(c)` = boundary or `/\s/u`. `punct(c)` = `/[\p{P}\p{S}]/u`.
  (CJK syllables are letters → treated as word chars, so `한글*액션*한글` works.)
- **left-flanking** = `!ws(after) && (!punct(after) || ws(before) || punct(before))`
- **right-flanking** = `!ws(before) && (!punct(before) || ws(after) || punct(after))`
- For `*`: `canOpen = leftFlanking`, `canClose = rightFlanking`.

process_emphasis (single-char `*`), per CommonMark:
- Walk closers forward; for each can-close run, walk back to the nearest can-open
  run (above `openers_bottom`). **Rule of 3:** skip an opener when
  `(closer.canOpen || opener.canClose) && closer.orig%3!==0 && (opener.orig+closer.orig)%3===0`.
- On match: `use = (opener.star>=2 && closer.star>=2) ? 2 : 1`; flag the items
  strictly between the two runs (`use===2 ? bold : action`); decrement both runs by
  `use`; drop delimiters between them; drop a run when its star count hits 0.
- Leftover runs (star count > 0) emit their remaining `*` characters as literal text.

Atomic-token precedence (scanned before `*`): panel `\$PANEL:[^$]+\$`,
image `\$IMAGE:[^$]+\$`, code `` `[^`]+` ``, thought `‘[^’]+’` / `'[^']+['’]`. An
unterminated code/thought open char falls through to literal text (current behavior).
Thought `value` keeps its surrounding quotes (current behavior).

## Rendering

- **ChatMessages.tsx `renderInline`**: switch over `InlineSegment`. text/code/thought
  wrap with `<em className="italic text-[#e8a862]">` when `action` and
  `<strong className="font-semibold">` when `bold` (bold outer). Thought keeps its
  blue (`text-[#7eb8e0] italic`) base and ignores `action` color (only adds bold if
  flagged). Panel/image unchanged. The existing `\n`-trim around `$IMAGE$` still
  operates on adjacent `text` segments.
- **formatInlineHtml**: same composition as an HTML string; `thoughtColor` /
  `actionColor` opts and the `data-inline-panel` / `data-inline-image` placeholder
  spans are unchanged.

## Compatibility & testing

- `tokenize`'s return type changes (flat union → segment-with-flags). Only two
  consumers: `ChatMessages.tsx` (updated) and `use-panel-bridge.ts` via
  `formatInlineHtml` (signature unchanged). No persisted data changes; histories
  re-render under the new rules (cosmetic, strictly better).
- No test framework is configured. A standalone `inline-formatter.test.mts` runs via
  `npx tsx`, importing the real module and asserting the behavior table:
  forward/reverse nesting, triple-star, stray/space-adjacent `*` → literal,
  unterminated `**`, `*` inside code/thought stays literal, emphasis wrapping
  code/panel/image, mixed sequential, thought/panel/image passthrough.

## Out of scope

- thought/code as nesting containers; apostrophe-vs-thought disambiguation;
  underscore (`_`) emphasis; block markdown (headings, lists, links).
