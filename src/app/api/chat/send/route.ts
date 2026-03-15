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
  instance.isOOC = isOOC;
  instance.addUserToHistory(text, isOOC);

  // Flush pending event headers and prepend to AI message
  const eventHeaders = isOOC ? "" : instance.flushEvents();
  const aiText = eventHeaders ? `${eventHeaders}\n${text}` : text;
  instance.claude.send(aiText);
  return NextResponse.json({ ok: true });
}
