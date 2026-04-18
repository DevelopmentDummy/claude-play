import { NextResponse } from "next/server";
import { getServices, closeSessionInstance } from "@/lib/services";
import { retryOnWindowsLock } from "@/lib/fs-retry";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string };
  const { name } = body;
  const svc = getServices();

  closeSessionInstance(name);

  if (name && svc.sessions.personaExists(name)) {
    try {
      await retryOnWindowsLock(() => svc.sessions.deletePersona(name));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      console.error(`[builder/cancel] Failed to delete persona ${name}:`, err);
      return NextResponse.json(
        { error: `Failed to delete persona: ${code || String(err)}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}
