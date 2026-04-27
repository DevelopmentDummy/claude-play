import { NextRequest, NextResponse } from "next/server";
import { listSessionsForPersona } from "@/lib/session-list";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!name || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const currentId = req.nextUrl.searchParams.get("currentId") || undefined;
  const items = listSessionsForPersona(name, currentId);
  return NextResponse.json({ items });
}
