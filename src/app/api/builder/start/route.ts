import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";

export async function POST(req: Request) {
  const { name } = (await req.json()) as { name: string };
  const svc = getServices();

  svc.claude.kill();
  svc.panels.stop();

  const personaDir = svc.sessions.createPersonaDir(name);
  svc.sessions.ensureClaudeRuntimeConfig(personaDir, name, "builder");
  svc.builderPersonaName = name;
  svc.isBuilderActive = true;
  svc.currentSessionId = null;
  svc.clearHistory();

  // Copy builder prompt as CLAUDE.md
  const builderPrompt = svc.sessions.getBuilderPrompt();
  fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
  svc.claude.spawn(personaDir, undefined, undefined, runtimeSystemPrompt);

  return NextResponse.json({ name, dir: personaDir });
}
