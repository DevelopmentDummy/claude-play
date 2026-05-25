import { NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/services";

export async function POST(req: Request) {
  const { text, sessionId } = (await req.json()) as { text: string; sessionId?: string };
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  const instance = getSessionInstance(sessionId);
  if (!instance) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const isOOC = text.startsWith("OOC:");

  // Pending AskUserQuestion fallback — 평문을 자유 답변으로 흡수. (OOC는 일반 turn으로 보냄)
  if (instance.pendingToolUseId && !isOOC) {
    const answer = { answers: {}, notes: { _freeform: text } };
    await instance.submitToolAnswer(instance.pendingToolUseId, answer);
    return NextResponse.json({ ok: true, absorbedAsToolAnswer: true });
  }
  instance.isOOC = isOOC;
  instance.addUserToHistory(text, isOOC);

  // Flush pending event headers and prepend to AI message
  const eventHeaders = isOOC ? "" : instance.flushEvents();
  const hintSnapshot = isOOC ? "" : instance.buildHintSnapshot();
  const actionHistory = isOOC ? "" : instance.flushActions();
  const jsonLint = instance.buildJsonLint();
  const parts = [eventHeaders, jsonLint, hintSnapshot, actionHistory, text].filter(Boolean);
  instance.claude.send(parts.join("\n"));
  return NextResponse.json({ ok: true });
}
