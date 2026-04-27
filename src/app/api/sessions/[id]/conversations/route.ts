import { NextResponse } from "next/server";
import { listConversationsForSession } from "@/lib/session-list";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || id.includes("/") || id.includes("..") || id.includes("\\")) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const result = listConversationsForSession(id);
  return NextResponse.json(result);
}
