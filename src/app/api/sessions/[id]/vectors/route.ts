import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { runVectorAction, vectorErrorStatus, type VectorContext } from "@/lib/vector-index";

// 임베딩·벡터 검색 인프라(EmbeddingGemma 2). 본문 { action, ...params } → runVectorAction.
// 소비자: MCP vector_*, 패널 __panelBridge.vectors(). 페르소나 도구는 context.vectors로 lib를 직접 부른다.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf-8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: `Request body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessions } = getServices();
  const info = sessions.getSessionInfo(sessionId);
  if (!info) return NextResponse.json({ error: "session not found" }, { status: 404 });
  const ctx: VectorContext = {
    sessionDir: sessions.getSessionDir(sessionId),
    personaDir: info.persona ? sessions.getPersonaDir(info.persona) : null,
  };

  const { action, ...rest } = body;
  try {
    return NextResponse.json(await runVectorAction(ctx, String(action ?? ""), rest));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: vectorErrorStatus(err) });
  }
}
