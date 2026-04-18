/**
 * Retry a filesystem mutation that can transiently fail on Windows
 * because an agent process is still releasing its cwd/handles.
 * Retries on EBUSY/EPERM/ENOTEMPTY with growing backoff.
 */
export async function retryOnWindowsLock<T>(
  fn: () => T,
  { attempts = 5, baseDelayMs = 250 }: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}
