import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance, getSessionInstance } from "@/lib/services";
import { getAppRoot, getDataDir } from "@/lib/data-dir";
import { AIProvider, providerFromModel, resolveBuilderModel } from "@/lib/ai-provider";
import { getGpuManagerPort } from "@/lib/endpoints";
import { consumeRestartMarker } from "@/lib/restart-notification";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string; service?: AIProvider };
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
  const gpuManagerPort = getGpuManagerPort();
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
  const builderSkillsSrc = path.join(getDataDir(), "builder_skills");
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
  // Model switch / reinit: an explicit model request must respawn the locked process to
  // apply the model. We respawn on ANY explicit request — not just when it differs from the
  // saved value — so a stale process (e.g. stuck on a now-disabled model like fable while
  // the saved model already points to opus) can be recovered by simply re-selecting. Plain
  // reopen (no model in the request body) keeps resuming without a respawn.
  const modelRequested = !!requestedModel;

  if (providerChanged) {
    instance.clearHistory();
  } else {
    instance.loadHistory();
  }

  instance.panels.watch(personaDir);

  // Try to resume the existing conversation across the model switch. If the resume fails
  // (e.g. the session was created with a now-unavailable model like fable), claude-process
  // auto-retries without --resume, starting a fresh session with the new model.
  const resumeId = providerChanged ? undefined : svc.sessions.getBuilderSessionId(name, resolved.provider);

  // Spawn when the process isn't running, the provider changed, or a model was explicitly requested.
  if (!instance.claude.isRunning() || providerChanged || modelRequested) {
    const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
    if (resolved.provider === "codex") {
      svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
    } else if (resolved.provider === "gemini") {
      svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
    } else if (resolved.provider === "kimi") {
      svc.sessions.writeKimiInstructions(personaDir, runtimeSystemPrompt);
    }
    instance.claude.spawn(personaDir, resumeId, resolved.model, runtimeSystemPrompt, resolved.effort, true, "claude-stream.log", resolved.advisor);
  }

  // If this builder persona triggered a service restart on the previous boot, deliver the
  // silent "restart completed" notification once the AI is ready. Noop when no marker exists.
  // Fire-and-forget: don't block the response on the AI handshake (mirrors /api/sessions/[id]/open).
  void consumeRestartMarker(personaDir, instance);

  const displayName = svc.sessions.getPersonaDisplayName(name);
  return NextResponse.json({ name, displayName, dir: personaDir, resumed: !!resumeId, provider: resolved.provider, model: resolved.combined });
}
