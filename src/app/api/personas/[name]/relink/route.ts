import { NextResponse } from "next/server";
import { relinkPersonaConversation } from "@/lib/session-list";
import { closeSessionInstance } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!name || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
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

  // The builder SessionInstance is registered under the persona name as id.
  closeSessionInstance(name);

  const result = relinkPersonaConversation(name, conversationId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
