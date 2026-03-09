import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET: Compare persona vs session to show diff */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const direction = url.searchParams.get("direction") || "forward";

  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const diff = direction === "reverse"
    ? svc.sessions.getReverseSyncDiff(id)
    : svc.sessions.getSyncDiff(id);

  return NextResponse.json({ diff });
}

/** POST: Sync selected elements between persona and session */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { elements = {}, direction = "forward", variablesMode } = body as {
    elements?: Record<string, boolean>;
    direction?: "forward" | "reverse";
    variablesMode?: "merge" | "overwrite" | "skip";
  };

  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (direction === "reverse") {
    svc.sessions.syncSessionToPersonaSelective(id, elements, variablesMode);
  } else {
    svc.sessions.syncPersonaToSessionSelective(id, elements);
    // Force panel refresh if panels or variables were synced
    if (elements.panels || elements.variables || elements.layout) {
      svc.panels.reload();
    }
  }

  return NextResponse.json({ ok: true });
}
