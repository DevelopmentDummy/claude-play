import { NextResponse } from "next/server";
import { relinkPersonaConversation } from "@/lib/session-list";
import { closeSessionInstance } from "@/lib/services";
import { isUnsafePathSegment } from "@/lib/path-safety";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (isUnsafePathSegment(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
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

  // The builder SessionInstance is registered under the persona name as id.
  closeSessionInstance(name);

  const result = relinkPersonaConversation(name, conversationId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
