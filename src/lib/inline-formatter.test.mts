/**
 * Standalone behavior harness for inline-formatter (no test framework configured).
 * Run:  npx tsx src/lib/inline-formatter.test.mts
 * Exits non-zero on any failure.
 */
import type { InlineSegment } from "./inline-formatter.ts";
// tsx CJS/ESM interop: exports may live on the namespace or under `default`.
const mod = (await import("./inline-formatter.ts")) as unknown as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const tokenize = (mod.tokenize ?? mod.default?.tokenize) as (t: string) => InlineSegment[];
const formatInlineHtml = (mod.formatInlineHtml ?? mod.default?.formatInlineHtml) as (t: string) => string;

function ser(segs: InlineSegment[]): string {
  return segs
    .map((s) => {
      const f =
        "bold" in s || "action" in s
          ? `[${(s as { bold?: boolean }).bold ? "B" : ""}${(s as { action?: boolean }).action ? "A" : ""}]`
          : "";
      switch (s.kind) {
        case "text": return `T(${JSON.stringify(s.value)})${f}`;
        case "code": return `C(${JSON.stringify(s.value)})${f}`;
        case "thought": return `Q(${JSON.stringify(s.value)})${f}`;
        case "panel": return `P(${s.name})`;
        case "image": return `I(${s.path})`;
      }
    })
    .join("  ");
}

let pass = 0;
let fail = 0;
function check(input: string, expected: string) {
  const got = ser(tokenize(input));
  if (got === expected) {
    pass++;
  } else {
    fail++;
    console.log("FAIL:", JSON.stringify(input));
    console.log("  expected:", expected);
    console.log("  got     :", got);
  }
}

// --- basics ---
check("**굵게**", `T("굵게")[B]`);
check("*액션*", `T("액션")[A]`);
check("plain text", `T("plain text")`);

// --- nesting both directions ---
check("*액션 **굵게** 액션*", `T("액션 ")[A]  T("굵게")[BA]  T(" 액션")[A]`);
check("**굵게 *액션* 굵게**", `T("굵게 ")[B]  T("액션")[BA]  T(" 굵게")[B]`);
check("***굵은액션***", `T("굵은액션")[BA]`);
check("*a **b *c* d** e*", `T("a ")[A]  T("b c d")[BA]  T(" e")[A]`); // deep both-direction
check("**a*b**", `T("a*b")[B]`); // leftover literal * inherits the enclosing bold (CommonMark <strong>a*b</strong>)

// --- stray / space-adjacent stars become literal (flanking) ---
check("중간에 * 들어감", `T("중간에 * 들어감")`);
check("*열기만 닫기없음", `T("*열기만 닫기없음")`);
check("**굵게 시작만", `T("**굵게 시작만")`);

// --- mixed sequential (non-nested) ---
check("그녀가 *웃으며* 말했다. **정말?**", `T("그녀가 ")  T("웃으며")[A]  T(" 말했다. ")  T("정말?")[B]`);

// --- atomic tokens: contents not re-parsed ---
check("`a*b*c`", `C("a*b*c")`);
check("'그가 *왔다*'", `Q("'그가 *왔다*'")`);
check("$IMAGE:hero.png$", `I(hero.png)`);
check("$PANEL:stats$", `P(stats)`);

// --- emphasis wrapping an atomic token (code inside action) ---
check("*보세요 `코드` 여기*", `T("보세요 ")[A]  C("코드")[A]  T(" 여기")[A]`);

// --- thought passthrough keeps quotes ---
check("'정말?'", `Q("'정말?'")`);

// --- apostrophe/thought flanking: contractions & possessives stay literal ---
check("It's a trap, don't move.", `T("It's a trap, don't move.")`);
check("can't won't shan't", `T("can't won't shan't")`);
check("James' book is here.", `T("James' book is here.")`);
check("'90s were wild", `T("'90s were wild")`); // open with no eligible close → literal
check("그가 '정말?' 하고 외쳤다.", `T("그가 ")  Q("'정말?'")  T(" 하고 외쳤다.")`);
check("'그가 don't 왔다'", `Q("'그가 don't 왔다'")`); // inner apostrophe can't close → kept
check("He said 'hello' to me.", `T("He said ")  Q("'hello'")  T(" to me.")`);

// --- Korean: closing quote hugged by an attached particle (no space) must close ---
check("'검사실'이었다.", `Q("'검사실'")  T("이었다.")`);
check("둘러싸인 '검사실'이었다.", `T("둘러싸인 ")  Q("'검사실'")  T("이었다.")`);
check("그가 '진짜'가 나왔다", `T("그가 ")  Q("'진짜'")  T("가 나왔다")`);
check("'그가 don't 왔다'이라고", `Q("'그가 don't 왔다'")  T("이라고")`); // latin contraction skips to real close

// --- formatInlineHtml smoke ---
const html = formatInlineHtml("*액션 **굵게** 액션*");
const htmlOk = html.includes("<strong>") && html.includes("<em");
if (!htmlOk) { fail++; console.log("FAIL: formatInlineHtml missing strong/em:", html); } else { pass++; }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
