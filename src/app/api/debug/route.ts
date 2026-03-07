import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const svc = getServices(auth.userId);
  return NextResponse.json({
    claudeRunning: svc.claude.running,
    isBuilderActive: svc.isBuilderActive,
    builderPersonaName: svc.builderPersonaName,
    currentSessionId: svc.currentSessionId,
    historyLength: svc.chatHistory.length,
  });
}
