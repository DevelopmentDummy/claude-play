import { NextResponse } from "next/server";
import { listConversationsForPersona } from "@/lib/session-list";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!name || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const result = listConversationsForPersona(name);
  return NextResponse.json(result);
}
