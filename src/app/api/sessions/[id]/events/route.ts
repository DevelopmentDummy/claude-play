import { NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/services";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  const instance = getSessionInstance(sessionId);
  if (!instance) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const { header, silent } = (await req.json()) as { header?: string; silent?: boolean };
  if (!header?.trim()) {
    return NextResponse.json({ error: "header required" }, { status: 400 });
  }

  instance.queueEvent(header.trim());
  if (!silent) {
    instance.broadcast("event:pending", { headers: instance.getPendingEvents() });
  }
  return NextResponse.json({ ok: true });
}
