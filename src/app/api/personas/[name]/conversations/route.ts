import { NextResponse } from "next/server";
import { listConversationsForPersona } from "@/lib/session-list";
import { isUnsafePathSegment } from "@/lib/path-safety";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (isUnsafePathSegment(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const result = listConversationsForPersona(name);
  return NextResponse.json(result);
}
