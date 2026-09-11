import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { HistoryMessage } from "./session-instance";

/** Replace a UTF-8 history file atomically; retain an existing UTF-8 BOM. */
export function writeHistoryJson(file: string, value: unknown): void {
  const bom = fs.existsSync(file) && fs.readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${bom ? "\ufeff" : ""}${JSON.stringify(value)}`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function readHistoryJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff/, ""));
}

export function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as HistoryMessage;
  return typeof m.id === "string" && typeof m.content === "string"
    && (m.role === "user" || m.role === "assistant")
    && (m.tools === undefined || Array.isArray(m.tools));
}

// Runtime-only directory: never copied as persona data or exposed to panels.
export function historyDraftPath(dir: string): string {
  return path.join(dir, ".claude", "history-draft.json");
}

/** Recovery is idempotent even if a crash occurred between final save and unlink. */
export function recoverHistoryDraft(dir: string, history: HistoryMessage[]): HistoryMessage[] {
  const file = historyDraftPath(dir);
  if (!fs.existsSync(file)) return history;
  const draft = readHistoryJson(file);
  if (!isHistoryMessage(draft) || draft.role !== "assistant") throw new Error("Invalid assistant history draft");
  return history.some(m => m.id === draft.id) ? history : [...history, draft];
}

export function nextHistorySequence(history: HistoryMessage[]): number {
  return history.reduce((max, m) => Math.max(max, Number(/^hist-[ua]-(\d+)$/.exec(m.id)?.[1] ?? 0)), 0);
}
