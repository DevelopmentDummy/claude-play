import { NextResponse } from "next/server";
import { getClaudeUsage, getCodexUsage, getGeminiUsage } from "@/lib/usage-checker";
import { getSessionInstance } from "@/lib/session-registry";
import { CodexProcess } from "@/lib/codex-process";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") || "claude";
  const rawSessionId = searchParams.get("sessionId");
  const sessionId = rawSessionId ? decodeURIComponent(rawSessionId) : null;

  if (provider === "claude") {
    return NextResponse.json(await getClaudeUsage());
  }

  if (provider === "codex") {
    if (!sessionId) {
      return NextResponse.json({ provider: "codex", windows: [], error: "sessionId가 필요합니다" });
    }
    const instance = getSessionInstance(sessionId);
    if (!instance) {
      return NextResponse.json({ provider: "codex", windows: [], error: `세션을 찾을 수 없습니다 (id: ${sessionId})` });
    }
    if (instance.provider !== "codex") {
      return NextResponse.json({ provider: "codex", windows: [], error: `현재 세션은 ${instance.provider} provider입니다` });
    }
    const process = instance.claude as unknown as CodexProcess;
    return NextResponse.json(await getCodexUsage(process));
  }

  if (provider === "gemini") {
    return NextResponse.json(await getGeminiUsage());
  }

  return NextResponse.json(
    { provider, windows: [], error: `지원하지 않는 provider: ${provider}` },
    { status: 400 }
  );
}
