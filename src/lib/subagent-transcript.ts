import * as fs from "fs";
import * as path from "path";

export type TranscriptDir = "in" | "out";
export type TranscriptKind = "dispatch" | "response" | "report";
export type TranscriptOrigin = "operator" | "auto" | "hook" | "delegate";

export interface TranscriptEntry {
  ts: string;
  dir: TranscriptDir;
  kind: TranscriptKind;
  origin?: TranscriptOrigin;
  text: string;
}

/** Per-turn text accumulator state for one sub-agent's provider stream. */
export interface SubTextState {
  buf: string;
  sawDelta: boolean;
}

export function newSubTextState(): SubTextState {
  return { buf: "", sawDelta: false };
}

/**
 * Pure reducer: fold one provider `message` event into the text accumulator.
 * Returns the next state, and (only on a turn-ending `result`) the final text
 * to record — or `undefined` when the turn produced no user-visible text
 * (e.g. tool-only turn). Provider shapes (verified against session-instance
 * bindProcessEvents):
 *  - non-Claude: { type:"assistant", subtype:"text_delta", message:{content:string} }
 *  - Claude stream: { type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}} }
 *  - Claude non-stream: { type:"assistant", message:{content:[{type:"text", text}]} }
 *  - end: { type:"result" }  (Claude carries final text in result.result / result.text)
 * The `sawDelta` guard prevents double-counting Claude's streamed deltas and
 * its trailing cumulative assistant message.
 */
export function reduceSubMessage(
  state: SubTextState,
  msg: Record<string, unknown>,
): { state: SubTextState; final?: string } {
  const am = msg.message as Record<string, unknown> | undefined;

  // 1) non-Claude unified delta
  if (msg.type === "assistant" && msg.subtype === "text_delta") {
    if (typeof am?.content === "string") {
      return { state: { buf: state.buf + am.content, sawDelta: true } };
    }
    return { state };
  }

  // 2) Claude streaming delta
  if (msg.type === "stream_event") {
    const ev = msg.event as Record<string, unknown> | undefined;
    const delta = ev?.delta as Record<string, unknown> | undefined;
    if (ev?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return { state: { buf: state.buf + delta.text, sawDelta: true } };
    }
    return { state };
  }

  // 3) Claude non-streaming text — only when no stream deltas arrived this turn
  if (msg.type === "assistant" && !state.sawDelta && am) {
    let add = "";
    if (typeof am.content === "string") {
      add = am.content;
    } else if (Array.isArray(am.content)) {
      for (const b of am.content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string") add += b.text;
      }
    }
    return { state: { buf: state.buf + add, sawDelta: state.sawDelta } };
  }

  // 4) turn end → flush
  if (msg.type === "result") {
    const r = msg.result as Record<string, unknown> | string | undefined;
    const fromResult = typeof r === "string" ? r : typeof r?.text === "string" ? (r.text as string) : "";
    const final = state.buf.trim() || fromResult.trim();
    return { state: newSubTextState(), final: final || undefined };
  }

  return { state };
}

export function transcriptPath(sessionDir: string, name: string): string {
  return path.join(sessionDir, "subagents", name, "transcript.jsonl");
}

/** Append one entry as a JSONL line. Best-effort (creates the dir if missing). */
export function appendTranscriptLine(sessionDir: string, name: string, entry: TranscriptEntry): void {
  const fp = transcriptPath(sessionDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}

/** Read the last `n` valid entries (malformed lines skipped). Returns [] if no file. */
export function readTranscriptTail(sessionDir: string, name: string, n: number): TranscriptEntry[] {
  const fp = transcriptPath(sessionDir, name);
  let raw: string;
  try {
    raw = fs.readFileSync(fp, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out: TranscriptEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
