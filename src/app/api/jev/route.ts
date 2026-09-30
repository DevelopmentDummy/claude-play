import { NextResponse } from "next/server";
import { askJev, JevError, type JevQuestion } from "@/lib/jev-client";

// Jev(TypeSafe System One) 프록시. 인증은 middleware가 처리한다(쿠키 또는 x-bridge-token).
// 소비자: MCP jev_ask, 패널/앱의 __panelBridge.jev(). 키는 서버에만 있다.
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf-8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: `Request body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  }
  let body: { state?: unknown; questions?: unknown; model?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await askJev(body.state, body.questions as Record<string, JevQuestion>, {
      model: typeof body.model === "string" ? body.model : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof JevError ? err.status : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
