import { NextResponse } from "next/server";
import { closeSessionInstance } from "./services";
import { retryOnWindowsLock } from "./fs-retry";
import { killAgyForDir } from "./antigravity-pid-registry";

/**
 * Shared soft-delete flow for sessions and builder personas:
 *  1. close the live instance (kills the agent process + stops panels)
 *  2. reap any orphaned agy.exe still holding `dir` as its cwd — detached
 *     processes survive dev-server restarts and otherwise block the rename
 *     with EBUSY/EPERM (closeSessionInstance only knows the live instance PID)
 *  3. soft-delete with Windows-lock retry
 *
 * Returns the API response (`{ ok: true }` or a 500 with the error code).
 */
export async function softDeleteWithReap(opts: {
  key: string;
  dir: string;
  del: () => void | Promise<void>;
  label: string;
}): Promise<NextResponse> {
  const { key, dir, del, label } = opts;

  closeSessionInstance(key);
  killAgyForDir(dir);

  try {
    await retryOnWindowsLock(del);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(`[DELETE ${label}] Failed to delete ${key}:`, err);
    return NextResponse.json(
      { error: `Failed to delete ${label}: ${code || String(err)}` },
      { status: 500 }
    );
  }
}
