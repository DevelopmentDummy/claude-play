import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id: rawId, name: rawName } = await params;
  const id = decodeURIComponent(rawId);
  const name = decodeURIComponent(rawName);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const instance = getSessionInstance(id);
  if (!instance) return NextResponse.json({ error: `Session "${id}" not active` }, { status: 404 });

  const ok = instance.subAgents.dispatch(name, text, "operator");
  if (!ok) return NextResponse.json({ error: `Unknown or undeclared sub-agent "${name}"` }, { status: 404 });

  return NextResponse.json({ ok: true });
}
