import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string };
  const { name } = body;
  const { model, effort } = parseModelEffort(body.model || "");
  const svc = getServices();

  svc.claude.kill();
  svc.panels.stop();

  const personaDir = svc.sessions.createPersonaDir(name);
  svc.sessions.ensureClaudeRuntimeConfig(personaDir, name, "builder");
  svc.builderPersonaName = name;
  svc.isBuilderActive = true;
  svc.currentSessionId = null;
  svc.clearHistory();

  // Copy builder prompt as both CLAUDE.md and AGENTS.md
  const builderPrompt = svc.sessions.getBuilderPrompt();
  fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "AGENTS.md"), builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  // Switch provider if needed
  const provider = providerFromModel(model || "");
  if (provider !== svc.provider) {
    svc.switchProvider(provider);
  }

  const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
  // Builder default effort: highest for each provider
  const effectiveEffort = effort || (provider === "codex" ? "xhigh" : "high");
  svc.claude.spawn(personaDir, undefined, model || undefined, runtimeSystemPrompt, effectiveEffort);

  return NextResponse.json({ name, dir: personaDir, provider });
}
