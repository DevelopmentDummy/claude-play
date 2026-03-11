import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const svc = getServices();
  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionDir = svc.sessions.getSessionDir(id);

  // Save options
  svc.sessions.writeOptions(sessionDir, body);

  // Check if any prompt-targeting options changed (need restart)
  const schema = svc.sessions.readOptionsSchema();
  const promptKeys = new Set(
    schema
      .filter((o: Record<string, unknown>) => o.target === "prompt" || o.target === "both")
      .map((o: Record<string, unknown>) => o.key as string)
  );
  const hasPromptChanges = Object.keys(body).some(k => promptKeys.has(k));

  if (hasPromptChanges && svc.currentSessionId === id) {
    // Kill current process
    svc.claude.kill();

    // Rebuild prompt with new options
    const resolvedOptions = svc.sessions.resolveOptions(sessionDir);
    const savedModel = svc.sessions.getSessionModel(id) || "";
    const { model, effort } = parseModelEffort(savedModel);
    const provider = providerFromModel(model);

    if (provider !== svc.provider) {
      svc.switchProvider(provider);
    }

    const resumeId = provider === "codex"
      ? svc.sessions.getCodexThreadId(id)
      : svc.sessions.getClaudeSessionId(id);

    const runtimeSystemPrompt = svc.sessions.buildServiceSystemPrompt(info.persona, provider, resolvedOptions);
    svc.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort);

    return NextResponse.json({ ok: true, restarted: true });
  }

  return NextResponse.json({ ok: true, restarted: false });
}
