import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";
import type { ToolAnswer } from "@/lib/session-instance";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const instance = getSessionInstance(id);
  if (!instance) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let body: { toolUseId?: string; answer?: ToolAnswer };
  try {
    body = await req.json() as { toolUseId?: string; answer?: ToolAnswer };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { toolUseId, answer } = body;

  if (!toolUseId || !answer || typeof answer !== "object" || !answer.answers) {
    return NextResponse.json({ error: "toolUseId and answer.answers required" }, { status: 400 });
  }

  await instance.submitToolAnswer(toolUseId, answer);
  return NextResponse.json({ ok: true });
}
