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
  // AI 프로세스가 spawn 직후 init(LS port discovery, cascade resume 등) 중일 때
  // send를 호출하면 cascade에 메시지가 도달하지 않은 채 끝날 수 있다. 명시적으로 ready 보장.
  if (!instance.claude.isRunning()) {
    return NextResponse.json({ error: "AI process not running" }, { status: 503 });
  }
  const ready = await instance.claude.waitForReady(15_000);
  if (!ready) {
    return NextResponse.json({ error: "AI process not ready after 15s" }, { status: 503 });
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
