import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";
import { retryOnWindowsLock } from "@/lib/fs-retry";
import { killAgyForDir } from "@/lib/antigravity-pid-registry";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  // Close session instance (kills process + stops panels) if active
  closeSessionInstance(id);

  // Reap any orphaned agy.exe still holding this session dir as its cwd —
  // detached processes survive dev-server restarts and otherwise block the
  // rename (soft-delete) with EBUSY. closeSessionInstance only knows the live
  // instance's PID; this catches orphans from earlier server generations.
  killAgyForDir(svc.sessions.getSessionDir(id));

  try {
    await retryOnWindowsLock(() => svc.sessions.deleteSession(id));
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(`[DELETE session] Failed to delete ${id}:`, err);
    return NextResponse.json(
      { error: `Failed to delete session: ${code || String(err)}` },
      { status: 500 }
    );
  }
}
