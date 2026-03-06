import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";
import { providerFromModel } from "@/lib/ai-provider";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string };
  const { name } = body;
  const model = body.model || undefined;
  const svc = getServices();

  svc.claude.kill();
  svc.panels.stop();

  if (!svc.sessions.personaExists(name)) {
    return NextResponse.json(
      { error: `Persona "${name}" not found` },
      { status: 404 }
    );
  }

  const personaDir = svc.sessions.getPersonaDir(name);
  svc.sessions.ensureClaudeRuntimeConfig(personaDir, name, "builder");
  svc.builderPersonaName = name;
  svc.isBuilderActive = true;
  svc.currentSessionId = null;

  // Always overwrite CLAUDE.md and AGENTS.md with builder prompt
  const builderPrompt = svc.sessions.getBuilderPrompt();
  fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "AGENTS.md"), builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  // If model is specified, derive provider from it; otherwise keep current provider
  const provider = model ? providerFromModel(model) : svc.provider;
  console.log(`[builder/edit] name=${name} model=${model} provider=${provider} (current=${svc.provider})`);
  const providerChanged = provider !== svc.provider;
  if (providerChanged) {
    svc.switchProvider(provider);
    // Provider switch = fresh start, clear history and don't resume
    svc.clearHistory();
  } else {
    svc.loadHistory(); // Load from chat-history.json (empty if new)
  }

  // Only resume if provider didn't change
  const resumeId = providerChanged ? undefined : svc.sessions.getBuilderSessionId(name);
  const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
  // If no model specified and provider is codex, use default codex model
  const effectiveModel = model || (provider === "codex" ? "gpt-5.4" : undefined);
  svc.claude.spawn(personaDir, resumeId, effectiveModel, runtimeSystemPrompt);

  return NextResponse.json({ name, dir: personaDir, resumed: !!resumeId, provider });
}
