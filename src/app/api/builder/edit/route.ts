import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance, getSessionInstance } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string; service?: "claude" | "codex" | "gemini" };
  const { name } = body;
  const { model, effort } = parseModelEffort(body.model || "");
  const svc = getServices();

  if (!svc.sessions.personaExists(name)) {
    return NextResponse.json(
      { error: `Persona "${name}" not found` },
      { status: 404 }
    );
  }

  const personaDir = svc.sessions.getPersonaDir(name);
  svc.sessions.ensureClaudeRuntimeConfig(personaDir, name, "builder");

  // Check Local TTS availability for conditional builder prompt
  const gpuManagerPort = parseInt(process.env.GPU_MANAGER_PORT || String((parseInt(process.env.PORT || "3340", 10)) + 2), 10);
  let localTtsAvailable = false;
  try {
    const healthRes = await fetch(`http://127.0.0.1:${gpuManagerPort}/health`, { signal: AbortSignal.timeout(2000) });
    if (healthRes.ok) {
      const health = await healthRes.json();
      localTtsAvailable = health.tts_available === true;
    }
  } catch { /* GPU Manager unavailable */ }

  // Always overwrite CLAUDE.md and AGENTS.md with builder prompt
  const builderPrompt = svc.sessions.getBuilderPrompt({ localTtsAvailable });
  fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "AGENTS.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "GEMINI.md"), builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  // Determine provider: explicit service > explicit model > saved provider > current instance provider > default
  const savedProvider = svc.sessions.getBuilderProvider(name);
  const existingInstance = getSessionInstance(name);
  const currentProvider = existingInstance?.provider || savedProvider || "claude";
  const provider = body.service || (model ? providerFromModel(model) : currentProvider);
  console.log(`[builder/edit] name=${name} model=${model} service=${body.service} provider=${provider} (saved=${savedProvider} current=${currentProvider})`);

  const instance = openSessionInstance(name, true, provider);
  const providerChanged = existingInstance ? provider !== existingInstance.provider : false;

  if (providerChanged) {
    // Provider switch = fresh start, clear history and don't resume
    instance.clearHistory();
  } else {
    instance.loadHistory(); // Load from chat-history.json (empty if new)
  }

  instance.panels.watch(personaDir);

  // Provider switch = always fresh session (no resume across providers)
  const resumeId = providerChanged ? undefined : svc.sessions.getBuilderSessionId(name, provider);
  // If no model specified and provider is codex, use default codex model
  const effectiveModel = model || (provider === "codex" ? "gpt-5.4" : provider === "gemini" ? "gemini-3.1-pro-preview" : undefined);
  // Builder default effort: highest for each provider
  const effectiveEffort = effort || (provider === "codex" ? "xhigh" : provider === "gemini" ? undefined : "high");

  // Only spawn if process is not running or provider changed
  if (!instance.claude.isRunning() || providerChanged) {
    const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
    // For Codex: write instructions file (file-based prompt delivery via model_instructions_file)
    if (provider === "codex") {
      svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
    } else if (provider === "gemini") {
      svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
    }
    instance.claude.spawn(personaDir, resumeId, effectiveModel, runtimeSystemPrompt, effectiveEffort);
  }

  const displayName = svc.sessions.getPersonaDisplayName(name);
  return NextResponse.json({ name, displayName, dir: personaDir, resumed: !!resumeId, provider });
}
