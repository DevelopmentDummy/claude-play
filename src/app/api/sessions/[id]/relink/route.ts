import { NextResponse } from "next/server";
import { relinkConversation } from "@/lib/session-list";
import { closeSessionInstance } from "@/lib/services";
import { isUnsafePathSegment } from "@/lib/path-safety";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (isUnsafePathSegment(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: { conversationId?: unknown };
  try {
    body = await req.json() as { conversationId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  // null = unlink (next spawn starts a fresh conversation, no --resume)
  const raw = body.conversationId;
  const isUnlink = raw === null;
  if (!isUnlink && (typeof raw !== "string" || !raw)) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }
  const conversationId: string | null = isUnlink ? null : (raw as string);

  // Tear down the live SessionInstance so the next /open spawns afresh with
  // the newly-linked conversation id. Without this, the in-memory AI process
  // and PanelEngine would keep running with the old id.
  closeSessionInstance(id);

  const result = relinkConversation(id, conversationId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
