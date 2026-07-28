/** 세션 메모의 순수 로직. 파일 I/O 없이 문자열만 다룬다. */

/** session.json에 저장되는 메모 최대 길이(문자). */
export const MEMO_MAX_LEN = 200;

/** 이벤트 헤더 줄(`[MEMO] …`, `[TIME] …`)은 유저가 친 말이 아니므로 프리뷰에서 제외한다. */
const EVENT_HEADER = /^\[[A-Z_]+\]/;

/** 임의 입력을 저장 가능한 메모 문자열로 정규화한다. */
export function clampMemo(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, MEMO_MAX_LEN);
}

/**
 * chat-history.json 원문에서 마지막 유저 발화를 한 줄로 뽑는다.
 * 수동/자동 메모가 둘 다 없을 때 세션 카드에 띄우는 최후 폴백.
 */
export function extractLastUserPreview(raw: string, maxLen = 60): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const msgs = Array.isArray(parsed)
    ? parsed
    : (parsed as { messages?: unknown })?.messages ?? (parsed as { history?: unknown })?.history;
  if (!Array.isArray(msgs)) return undefined;

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    const oneLine = m.content.replace(/\s+/g, " ").trim();
    if (!oneLine || EVENT_HEADER.test(oneLine)) continue;
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
  }
  return undefined;
}
