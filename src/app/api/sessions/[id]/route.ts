import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  // Stop Claude and panels if they're using this session's directory
  if (svc.currentSessionId === id) {
    svc.currentSessionId = null;
  }
  svc.claude.kill();
  svc.panels.stop();

  // Brief delay for Windows to release file handles after process kill
  await new Promise((r) => setTimeout(r, 300));

  svc.sessions.deleteSession(id);
  return NextResponse.json({ ok: true });
}
