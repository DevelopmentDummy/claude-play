import { NextResponse } from "next/server";
import { listConversationsForSession } from "@/lib/session-list";
import { isUnsafePathSegment } from "@/lib/path-safety";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (isUnsafePathSegment(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const result = listConversationsForSession(id);
  return NextResponse.json(result);
}
