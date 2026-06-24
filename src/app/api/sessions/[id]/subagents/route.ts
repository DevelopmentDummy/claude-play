import { NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });
  return NextResponse.json({ subs: instance.subAgents.listDetailed() });
}
