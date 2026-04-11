import { NextResponse } from "next/server";
import { getClaudeUsage, getCodexUsage } from "@/lib/usage-checker";
import { getSessionInstance } from "@/lib/session-registry";
import { CodexProcess } from "@/lib/codex-process";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") || "claude";
  const sessionId = searchParams.get("sessionId");

  if (provider === "claude") {
    return NextResponse.json(await getClaudeUsage());
  }

  if (provider === "codex") {
    if (!sessionId) {
      return NextResponse.json({ provider: "codex", windows: [], error: "sessionId가 필요합니다" });
    }
    const instance = getSessionInstance(sessionId);
    if (!instance || instance.provider !== "codex") {
      return NextResponse.json({ provider: "codex", windows: [], error: "활성 Codex 세션을 찾을 수 없습니다" });
    }
    const process = instance.claude as unknown as CodexProcess;
    return NextResponse.json(await getCodexUsage(process));
  }

  return NextResponse.json(
    { provider, windows: [], error: `지원하지 않는 provider: ${provider}` },
    { status: 400 }
  );
}
