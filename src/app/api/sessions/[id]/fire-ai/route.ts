import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { spawnBackgroundAI, type FireAIOnExit } from "@/lib/background-session";

function sanitizeOnExit(raw: unknown): FireAIOnExit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { broadcast?: unknown; script?: unknown };
  const out: FireAIOnExit = {};
  if (r.broadcast && typeof r.broadcast === "object") {
    const b = r.broadcast as { event?: unknown; data?: unknown };
    if (typeof b.event === "string" && b.event.trim()) {
      out.broadcast = { event: b.event, data: b.data };
    }
  }
  if (typeof r.script === "string" && r.script.trim()) {
    out.script = r.script;
  }
  return out.broadcast || out.script ? out : undefined;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const id = decodeURIComponent(rawId);
    const body = await req.json().catch(() => ({}));
    const { prompt, model, effort, notify, autoResume, onExit } = body as {
      prompt?: string;
      model?: string;
      effort?: string;
      notify?: boolean;
      autoResume?: boolean;
      onExit?: unknown;
    };

    if (!prompt) {
      return NextResponse.json(
        { error: "prompt is required" },
        { status: 400 }
      );
    }

    const svc = getServices();
    const info = svc.sessions.getSessionInfo(id);
    if (!info) {
      return NextResponse.json(
        { error: `Session "${id}" not found` },
        { status: 404 }
      );
    }

    const sessionDir = svc.sessions.getSessionDir(id);

    const result = spawnBackgroundAI({
      sessionDir,
      prompt,
      model,
      effort,
      notify: notify ?? false,
      autoResume: autoResume ?? false,
      callerSessionId: id,
      onExit: sanitizeOnExit(onExit),
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error("[fire-ai] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
