import { NextResponse } from "next/server";
import { stopPipelineScheduler } from "@/lib/pipeline-scheduler";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  try {
    const result = await stopPipelineScheduler(sessionId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop scheduler" },
      { status: 500 },
    );
  }
}
