import { NextRequest, NextResponse } from "next/server";
import { requireSetupAuth } from "@/lib/setup-auth";

export async function POST(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const { host, port } = await req.json();
  const url = `http://${host || "127.0.0.1"}:${port || 8188}/system_stats`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ ok: true, data });
    }
    return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Connection failed";
    return NextResponse.json({ ok: false, error: msg });
  }
}
