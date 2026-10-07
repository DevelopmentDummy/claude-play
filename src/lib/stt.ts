/**
 * STT — Qwen3-ASR(GPU Manager) with conversation-context biasing.
 *
 * 매 발화를 무맥락으로 인식하면 캐릭터 이름·고유명사가 깨진다. 최근 대화 몇 턴을
 * Qwen3-ASR의 context(system turn)로 넘겨 인식을 그쪽으로 기울인다(soft bias).
 */
import * as fs from "fs";
import * as path from "path";
import { getGpuManagerUrl } from "./endpoints";
import { isHistoryMessage, readHistoryJson } from "./history-storage";
import { getSessionInstance, getSessionManager } from "./services";
import type { HistoryMessage } from "./services";

const CONTEXT_TURNS = 4;
const PER_MESSAGE_CHARS = 500;
const CONTEXT_HEADER = "다음은 한국어 롤플레이 대화의 최근 내용이다. 등장인물 이름과 고유명사 표기를 참고하라.";

function normalizeForEcho(s: string): string {
  return s.replace(/[\s.,!?…·:;"'“”‘’()[\]-]+/g, "");
}

/**
 * Qwen3-ASR은 말소리가 약하거나 짧으면 context(system turn)를 그대로 읽어 내놓는다
 * (2026-10-07 실측: 처음엔 머리말, 그게 기록에 남자 다음 발화에서는 대화 전체).
 * 결과가 머리말을 포함하거나 결과 전체가 context의 일부면 "문맥 누출"로 본다 → 호출측이 context 없이 재인식.
 */
export function looksLikeContextEcho(text: string, context: string): boolean {
  const t = normalizeForEcho(text);
  if (!t) return false;
  if (t.includes(normalizeForEcho(CONTEXT_HEADER).slice(0, 14))) return true;
  return !!context && t.length >= 12 && normalizeForEcho(context).includes(t);
}

/** RP 메시지에서 인식에 도움 안 되는 마크업을 걷어낸다. */
function cleanForContext(content: string): string {
  return content
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, " ") // <panel-actions>…</panel-actions> 등 블록 태그
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 이미지 마크다운
    .replace(/^\[STT\]\s*/, "")
    .replace(/^OOC:\s*/, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 최근 대화 → Qwen3-ASR context 문자열. 긴 메시지는 끝부분(유저가 방금 들은 쪽)을 남긴다. */
export function buildSttContext(history: HistoryMessage[]): string {
  const lines: string[] = [];
  for (let i = history.length - 1; i >= 0 && lines.length < CONTEXT_TURNS; i--) {
    const text = cleanForContext(history[i].content);
    if (!text || /^\[[A-Z_]+\]/.test(text)) continue; // [MEMO]/[TIME] 같은 이벤트 줄
    // 예전에 누출돼 기록에 남은 메시지는 뺀다 — 다시 넣으면 다음 인식이 그걸 따라 읽는 악순환이 된다.
    if (looksLikeContextEcho(text, "")) continue;
    const clipped = text.length > PER_MESSAGE_CHARS ? "…" + text.slice(-PER_MESSAGE_CHARS) : text;
    lines.unshift(`${history[i].role === "user" ? "유저" : "AI"}: ${clipped}`);
  }
  if (lines.length === 0) return "";
  return `${CONTEXT_HEADER}\n${lines.join("\n")}`;
}

function loadHistory(sessionId: string): HistoryMessage[] {
  const instance = getSessionInstance(sessionId);
  if (instance) return instance.chatHistory;
  try {
    const fp = path.join(getSessionManager().getSessionDir(sessionId), "chat-history.json");
    if (!fs.existsSync(fp)) return [];
    const raw = readHistoryJson(fp);
    return Array.isArray(raw) ? raw.filter(isHistoryMessage) : [];
  } catch {
    return [];
  }
}

export function getSttContext(sessionId: string | null | undefined): string {
  return sessionId ? buildSttContext(loadHistory(sessionId)) : "";
}

export type AsrResult =
  | { ok: true; text: string }
  | { ok: false; unavailable: boolean; error: string };

/** GPU Manager `/asr/transcribe` 호출. unavailable=true면 호출측이 Whisper 폴백. */
export async function transcribeWithQwenAsr(
  audio: Buffer,
  opts: { language: string; context: string; modelSize?: string },
): Promise<AsrResult> {
  try {
    const res = await fetch(`${getGpuManagerUrl()}/asr/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: audio.toString("base64"),
        language: opts.language,
        context: opts.context,
        model_size: opts.modelSize || process.env.ASR_MODEL_SIZE || "1.7B",
      }),
      signal: AbortSignal.timeout(130_000),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (res.status === 503 || res.status === 404) {
      return { ok: false, unavailable: true, error: data.error || `GPU Manager ${res.status}` };
    }
    if (!res.ok) return { ok: false, unavailable: false, error: data.error || `ASR failed (${res.status})` };
    return { ok: true, text: (data.text || "").trim() };
  } catch (err) {
    // GPU Manager 자체가 꺼져 있음 → 폴백 대상
    return { ok: false, unavailable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 녹음 시작 시점에 모델을 미리 올려 콜드 로드를 발화 시간 뒤로 숨긴다. 실패는 무시. */
export async function warmupQwenAsr(): Promise<boolean> {
  try {
    const res = await fetch(`${getGpuManagerUrl()}/asr/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_size: process.env.ASR_MODEL_SIZE || "1.7B" }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
