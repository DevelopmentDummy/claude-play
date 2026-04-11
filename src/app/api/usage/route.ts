// src/app/api/usage/route.ts
import { NextResponse } from "next/server";
import { getClaudeUsage } from "@/lib/usage-checker";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") || "claude";

  if (provider === "claude") {
    const usage = await getClaudeUsage();
    return NextResponse.json(usage);
  }

  return NextResponse.json(
    { provider, windows: [], error: `지원하지 않는 provider: ${provider}` },
    { status: 400 }
  );
}
