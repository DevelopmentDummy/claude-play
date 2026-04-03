import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { spawnBackgroundClaude } from "@/lib/background-session";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const id = decodeURIComponent(rawId);
    const body = await req.json().catch(() => ({}));
    const { prompt, model, effort, notify } = body as {
      prompt?: string;
      model?: string;
      effort?: string;
      notify?: boolean;
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

    const result = spawnBackgroundClaude({
      sessionDir,
      prompt,
      model,
      effort,
      notify: notify ?? false,
      callerSessionId: id,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error("[fire-ai] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
