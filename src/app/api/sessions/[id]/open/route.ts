import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices } from "@/lib/services";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  svc.claude.kill();

  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json(
      { error: `Session "${id}" not found` },
      { status: 404 }
    );
  }

  const sessionDir = svc.sessions.getSessionDir(id);
  svc.currentSessionId = id;
  svc.isBuilderActive = false;
  svc.builderPersonaName = null;

  // Start panel watching
  svc.panels.watch(sessionDir);

  // Read opening message
  const openingPath = path.join(sessionDir, "opening.md");
  const opening = fs.existsSync(openingPath)
    ? fs.readFileSync(openingPath, "utf-8").trim() || null
    : null;

  // Read layout config
  const layout = svc.sessions.readLayout(sessionDir);

  // Resume previous Claude session if available
  const resumeId = svc.sessions.getClaudeSessionId(id);
  const isResume = !!resumeId;
  svc.claude.spawn(sessionDir, resumeId);

  return NextResponse.json({ ...info, opening, isResume, layout });
}
