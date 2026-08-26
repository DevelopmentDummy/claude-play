import { NextResponse } from "next/server";
import { closeSessionInstance } from "@/lib/services";
import { isUnsafePathSegment } from "@/lib/path-safety";

export const dynamic = "force-dynamic";

/** 수동 세션 종료 — 살아있는 SessionInstance(CLI 프로세스 + PanelEngine + 스케줄러)를
 *  grace period 를 기다리지 않고 즉시 정리한다. 대화 기록은 파일에 남으므로
 *  다음 /open 때 resume 된다. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (isUnsafePathSegment(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  closeSessionInstance(id);
  return NextResponse.json({ ok: true });
}
