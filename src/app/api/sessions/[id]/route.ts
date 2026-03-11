import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  // Close session instance (kills process + stops panels) if active
  closeSessionInstance(id);

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
