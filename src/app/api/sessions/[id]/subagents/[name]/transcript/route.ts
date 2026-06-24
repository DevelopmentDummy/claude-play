import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id: rawId, name: rawName } = await params;
  const id = decodeURIComponent(rawId);
  const name = decodeURIComponent(rawName);
  const nParam = Number(req.nextUrl.searchParams.get("n"));
  const n = Number.isFinite(nParam) && nParam > 0 ? Math.min(nParam, 1000) : 200;

  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });

  return NextResponse.json({ entries: instance.subAgents.readTranscript(name, n) });
}
