import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";

export async function POST() {
  const svc = getServices();

  svc.claude.kill();

  if (svc.builderPersonaName) {
    const personaDir = svc.sessions.getPersonaDir(svc.builderPersonaName);
    const builderClaude = path.join(personaDir, "CLAUDE.md");

    // Only remove if it's still the builder prompt
    if (fs.existsSync(builderClaude)) {
      const content = fs.readFileSync(builderClaude, "utf-8");
      if (content.startsWith("# Persona Builder")) {
        fs.unlinkSync(builderClaude);
      }
    }

    // Clean up builder-session.json
    const builderSessionPath = path.join(personaDir, "builder-session.json");
    if (fs.existsSync(builderSessionPath)) {
      fs.unlinkSync(builderSessionPath);
    }

    svc.builderPersonaName = null;
    svc.isBuilderActive = false;
  }

  return NextResponse.json({ ok: true });
}
