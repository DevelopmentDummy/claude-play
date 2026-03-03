import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const svc = getServices();
  return NextResponse.json({
    claudeRunning: svc.claude.running,
    isBuilderActive: svc.isBuilderActive,
    builderPersonaName: svc.builderPersonaName,
    currentSessionId: svc.currentSessionId,
    sseClients: svc.sse.clientCount,
  });
}
