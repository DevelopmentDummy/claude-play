import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET: Compare persona vs session to show diff */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const diff = svc.sessions.getSyncDiff(id);
  return NextResponse.json({ diff });
}

/** POST: Sync selected elements from persona to session */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const elements = (body as { elements?: Record<string, boolean> }).elements || {};

  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  svc.sessions.syncPersonaToSessionSelective(id, elements);

  // Force panel refresh if panels or variables were synced
  if (elements.panels || elements.variables || elements.layout) {
    svc.panels.reload();
  }

  return NextResponse.json({ ok: true });
}
