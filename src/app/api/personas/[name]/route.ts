import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";
import { retryOnWindowsLock } from "@/lib/fs-retry";
import { killAgyForDir } from "@/lib/antigravity-pid-registry";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();

  // Close builder instance (kills agent process + stops panels) if active —
  // otherwise Windows keeps the persona dir locked and rename fails with EPERM.
  closeSessionInstance(name);

  // Reap orphaned agy.exe (builder mode spawns it with the persona dir as cwd)
  // left behind by an earlier dev-server generation — same EBUSY/EPERM cause.
  killAgyForDir(sessions.getPersonaDir(name));

  try {
    await retryOnWindowsLock(() => sessions.deletePersona(name));
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(`[DELETE persona] Failed to delete ${name}:`, err);
    return NextResponse.json(
      { error: `Failed to delete persona: ${code || String(err)}` },
      { status: 500 }
    );
  }
}
