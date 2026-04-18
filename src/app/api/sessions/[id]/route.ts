import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";
import { retryOnWindowsLock } from "@/lib/fs-retry";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();

  // Close session instance (kills process + stops panels) if active
  closeSessionInstance(id);

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
