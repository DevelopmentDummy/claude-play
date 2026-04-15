import { NextResponse } from "next/server";
import { getSessionInstance } from "@/lib/services";
import { countSessionClients } from "@/lib/ws-server";
import { startPipelineScheduler } from "@/lib/pipeline-scheduler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  const body = (await req.json().catch(() => ({}))) as {
    label?: string;
    source?: string;
    requestedBy?: string;
    note?: string;
  };

  if (countSessionClients(sessionId) <= 0) {
    return NextResponse.json({ error: "No connected clients for this session" }, { status: 409 });
  }

  try {
    const instance = getSessionInstance(sessionId);
    if (!instance) {
      return NextResponse.json({ error: "Session is not active" }, { status: 409 });
    }

    const result = await startPipelineScheduler(sessionId, body);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start scheduler" },
      { status: 500 },
    );
  }
}
