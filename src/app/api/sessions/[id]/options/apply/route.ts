import { NextResponse } from "next/server";
import { getSessionManager, getSessionInstance } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const sm = getSessionManager();
  const info = sm.getSessionInfo(id);
  if (!info) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionDir = sm.getSessionDir(id);

  // Save options
  sm.writeOptions(sessionDir, body);

  // Check if any prompt-targeting options changed (need restart)
  const schema = sm.readOptionsSchema();
  const promptKeys = new Set(
    schema
      .filter((o: Record<string, unknown>) => o.target === "prompt" || o.target === "both")
      .map((o: Record<string, unknown>) => o.key as string)
  );
  const runtimeKeys = new Set(
    schema
      .filter((o: Record<string, unknown>) => o.target === "runtime")
      .map((o: Record<string, unknown>) => o.key as string)
  );
  const hasPromptChanges = Object.keys(body).some(k => promptKeys.has(k));
  const hasRuntimeChanges = Object.keys(body).some(k => runtimeKeys.has(k));

  const instance = getSessionInstance(id);
  if ((hasPromptChanges || hasRuntimeChanges) && instance) {
    // Kill current process
    instance.claude.kill();

    // Rebuild prompt with new options
    const resolvedOptions = sm.resolveOptions(sessionDir);
    const savedModel = sm.getSessionModel(id) || "";
    const { model, effort } = parseModelEffort(savedModel);
    const provider = providerFromModel(model);

    if (provider !== instance.provider) {
      instance.switchProvider(provider);
    }

    const resumeId = provider === "codex"
      ? sm.getCodexThreadId(id)
      : sm.getClaudeSessionId(id);

    const runtimeSystemPrompt = sm.buildServiceSystemPrompt(info.persona, provider, resolvedOptions);
    const skipPerms = resolvedOptions.skipPermissions !== false;
    instance.claude.spawn(sessionDir, resumeId, model || undefined, runtimeSystemPrompt, effort, skipPerms);

    return NextResponse.json({ ok: true, restarted: true });
  }

  return NextResponse.json({ ok: true, restarted: false });
}
