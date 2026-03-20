import { NextRequest, NextResponse } from "next/server";
import { requireSetupAuth } from "@/lib/setup-auth";

export async function POST(req: NextRequest) {
  const authError = requireSetupAuth(req);
  if (authError) return authError;

  const { key } = await req.json();
  if (!key) return NextResponse.json({ ok: false, error: "No key provided" });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: `API returned ${res.status}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Validation failed";
    return NextResponse.json({ ok: false, error: msg });
  }
}
