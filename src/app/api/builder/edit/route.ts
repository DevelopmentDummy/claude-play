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

  if (!svc.sessions.personaExists(name)) {
    return NextResponse.json(
      { error: `Persona "${name}" not found` },
      { status: 404 }
    );
  }

  const personaDir = svc.sessions.getPersonaDir(name);
  svc.builderPersonaName = name;
  svc.isBuilderActive = true;
  svc.currentSessionId = null;

  // Always overwrite CLAUDE.md with builder prompt (session instructions are in session-instructions.md)
  const claudeMdPath = path.join(personaDir, "CLAUDE.md");
  const builderPrompt = svc.sessions.getBuilderPrompt();
  fs.writeFileSync(claudeMdPath, builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  const resumeId = svc.sessions.getBuilderSessionId(name);
  svc.claude.spawn(personaDir, resumeId);

  return NextResponse.json({ name, dir: personaDir, resumed: !!resumeId });
}
