import { NextResponse } from "next/server";
import { getServices, listActiveInstances } from "@/lib/services";
import { listPipelineSchedulers } from "@/lib/pipeline-scheduler";
import { getWebSocketStats, listSessionClientCounts } from "@/lib/ws-server";

export async function GET(req: Request) {
  const svc = getServices();
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const filterSessionId = url.searchParams.get("sessionId")?.trim() || null;

  const allSessions = svc.sessions.listSessions();
  const activeInstances = listActiveInstances();
  const activeMap = new Map(activeInstances.map((item) => [item.id, item]));
  const clientCounts = listSessionClientCounts();
  const clientMap = new Map(clientCounts.map((item) => [item.sessionId, item.clients]));
  const schedulers = listPipelineSchedulers();
  const schedulerMap = new Map(schedulers.map((item) => [item.sessionId, item]));

  const baseSessions = includeInactive
    ? allSessions
    : allSessions.filter((session) =>
        activeMap.has(session.id) ||
        clientMap.has(session.id) ||
        schedulerMap.has(session.id),
      );

  const sessions = baseSessions
    .filter((session) => !filterSessionId || session.id === filterSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title,
      persona: session.persona,
      displayName: session.displayName,
      model: session.model || null,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity || null,
      clients: clientMap.get(session.id) || 0,
      instance: activeMap.get(session.id) || null,
      scheduler: schedulerMap.get(session.id) || null,
    }));

  const ws = getWebSocketStats();

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      sessions: sessions.length,
      activeInstances: activeInstances.length,
      runningSchedulers: schedulers.filter((item) => item.running).length,
      totalClients: ws.totalClients,
      boundClients: ws.boundClients,
      unboundClients: ws.unboundClients,
      builderClients: ws.builderClients,
    },
    schedulers: filterSessionId
      ? schedulers.filter((item) => item.sessionId === filterSessionId)
      : schedulers,
    sessions,
  });
}
