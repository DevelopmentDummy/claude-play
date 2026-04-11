import { NextResponse } from "next/server";
import { getSessionManager, getSessionInstance } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

/** GET: Compare persona vs session to show diff */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const direction = url.searchParams.get("direction") || "forward";

  const sm = getSessionManager();
  const info = sm.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const diff = direction === "reverse"
    ? sm.getReverseSyncDiff(id)
    : sm.getSyncDiff(id);

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

  const sm = getSessionManager();
  const info = sm.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (direction === "reverse") {
    sm.syncSessionToPersonaSelective(id, elements, variablesMode);
  } else {
    sm.syncPersonaToSessionSelective(id, elements);
    // Force panel refresh if panels or variables were synced
    if (elements.panels || elements.variables || elements.layout) {
      getSessionInstance(id)?.panels.reload();
    }
  }

  // Restart AI process if skills or instructions were synced (Claude CLI loads skills at startup only)
  let restarted = false;
  const instance = getSessionInstance(id);
  if ((elements.skills || elements.instructions) && instance && instance.claude.running) {
    instance.claude.kill();

    const sessionDir = sm.getSessionDir(id);
    const resolvedOptions = sm.resolveOptions(sessionDir);
    const savedModel = sm.getSessionModel(id) || "";
    const { model, effort } = parseModelEffort(savedModel);
    const provider = providerFromModel(model);

    const resumeId = provider === "codex"
      ? sm.getCodexThreadId(id)
      : sm.getClaudeSessionId(id);

    const profile = info.profileSlug ? sm.getProfile(info.profileSlug) : undefined;
    const runtimeSystemPrompt = sm.buildServiceSystemPrompt(info.persona, provider, resolvedOptions, profile?.name);
    const skipPerms = resolvedOptions.skipPermissions !== false;
    instance.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort, skipPerms);
    restarted = true;
  }

  return NextResponse.json({ ok: true, restarted });
}
