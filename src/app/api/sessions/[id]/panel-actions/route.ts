import { NextRequest, NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/session-registry";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const instance = getSessionInstance(id);
  if (!instance) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await req.json();
  const { panel, action, params: actionParams } = body;

  if (!panel || !action) {
    return NextResponse.json({ error: "panel and action required" }, { status: 400 });
  }

  instance.queueAction({
    panel,
    action,
    ...(actionParams && Object.keys(actionParams).length > 0 ? { params: actionParams } : {}),
  });

  return NextResponse.json({ ok: true });
}
