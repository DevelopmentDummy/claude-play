import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance, getSessionInstance } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";
import { providerFromModel, resolveBuilderModel } from "@/lib/ai-provider";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string; service?: "claude" | "codex" | "gemini" };
  const { name } = body;
  const requestedModel = body.model || "";
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



  // Copy builder-only skills
  const builderSkillsSrc = path.join(process.cwd(), "data", "builder_skills");
  if (fs.existsSync(builderSkillsSrc)) {
    const claudeSkillsDir = path.join(personaDir, ".claude", "skills");
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
    for (const skillDir of fs.readdirSync(builderSkillsSrc, { withFileTypes: true })) {
      if (skillDir.isDirectory()) {
        const dest = path.join(claudeSkillsDir, skillDir.name);
        fs.mkdirSync(dest, { recursive: true });
        for (const file of fs.readdirSync(path.join(builderSkillsSrc, skillDir.name))) {
          fs.copyFileSync(
            path.join(builderSkillsSrc, skillDir.name, file),
            path.join(dest, file)
          );
        }
      }
    }
  }

  // Determine provider: explicit service > explicit model > saved provider > current instance provider > default
  const savedProvider = svc.sessions.getBuilderProvider(name);
  const savedModel = svc.sessions.getBuilderModel(name);
  const existingInstance = getSessionInstance(name);
  const currentProvider = existingInstance?.provider || savedProvider || "claude";
  const effectiveModel = requestedModel || savedModel || "";
  const providerHint = body.service || (effectiveModel ? providerFromModel(effectiveModel) : currentProvider);
  const resolved = resolveBuilderModel(effectiveModel || undefined, providerHint);
  console.log(`[builder/edit] name=${name} model=${resolved.combined} provider=${resolved.provider} (saved=${savedProvider}/${savedModel} current=${currentProvider})`);
  svc.sessions.saveBuilderModel(name, resolved.combined);

  const instance = openSessionInstance(name, true, resolved.provider);
  const providerChanged = existingInstance ? resolved.provider !== existingInstance.provider : false;

  if (providerChanged) {
    instance.clearHistory();
  } else {
    instance.loadHistory();
  }

  instance.panels.watch(personaDir);

  const resumeId = providerChanged ? undefined : svc.sessions.getBuilderSessionId(name, resolved.provider);

  // Only spawn if process is not running or provider changed
  if (!instance.claude.isRunning() || providerChanged) {
    const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
    if (resolved.provider === "codex") {
      svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
    } else if (resolved.provider === "gemini") {
      svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
    }
    instance.claude.spawn(personaDir, resumeId, resolved.model, runtimeSystemPrompt, resolved.effort);
  }

  const displayName = svc.sessions.getPersonaDisplayName(name);
  return NextResponse.json({ name, displayName, dir: personaDir, resumed: !!resumeId, provider: resolved.provider, model: resolved.combined });
}
