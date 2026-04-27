import { NextResponse } from "next/server";
import { relinkConversation } from "@/lib/session-list";
import { closeSessionInstance } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || id.includes("/") || id.includes("..") || id.includes("\\")) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: { conversationId?: unknown };
  try {
    body = await req.json() as { conversationId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const conversationId = body.conversationId;
  if (typeof conversationId !== "string" || !conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

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
