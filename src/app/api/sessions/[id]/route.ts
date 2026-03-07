import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const svc = getServices(auth.userId);

  // Stop Claude and panels if they're using this session's directory
  if (svc.currentSessionId === id) {
    svc.currentSessionId = null;
  }
  svc.claude.kill();
  svc.panels.stop();

  // Retry deletion — Windows may need time to release file handles
  const maxRetries = 4;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    try {
      svc.sessions.deleteSession(id);
      return NextResponse.json({ ok: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EBUSY" || code === "EPERM") && i < maxRetries - 1) {
        continue;
      }
      console.error(`[DELETE session] Failed to delete ${id}:`, err);
      return NextResponse.json(
        { error: `Failed to delete session: ${code || String(err)}` },
        { status: 500 }
      );
    }
  }
  return NextResponse.json({ ok: true });
}
