/**
 * GET /api/sessions/:id/panel-actions-meta
 *
 * 클라이언트의 panel-action-registry가 init 시점에 호출하여
 * 패널 액션 spec을 로드한다. spec은 panels/_actions.meta.json
 * (서버 사이드 sidecar)에서 읽는다.
 *
 * 시스템 지시문에는 별도로 markdown 형식으로 한 번 박힌다 (open route).
 * 이 엔드포인트는 *런타임 [정의] 이벤트* 큐잉용 클라이언트 lookup 데이터.
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { readPanelActionsMeta } from "@/lib/panel-actions-meta";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const meta = readPanelActionsMeta(sessionDir);
  return NextResponse.json(meta || { panels: {} });
}
