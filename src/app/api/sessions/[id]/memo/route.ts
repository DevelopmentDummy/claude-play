import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** 세션 메모 갱신. memo=사용자 수동, autoMemo=세션 AI 자동, memoAuto=자동 요약 on/off. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const hasMemo = "memo" in body;
  const hasAuto = "autoMemo" in body;
  const hasToggle = "memoAuto" in body;

  if (hasMemo && hasAuto) {
    return NextResponse.json({ error: "memo와 autoMemo는 동시에 보낼 수 없습니다" }, { status: 400 });
  }
  if (!hasMemo && !hasAuto && !hasToggle) {
    return NextResponse.json({ error: "memo, autoMemo, memoAuto 중 하나가 필요합니다" }, { status: 400 });
  }

  const { sessions } = getServices();
  if (!sessions.getSessionInfo(id)) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  if (hasMemo) {
    if (typeof body.memo !== "string") {
      return NextResponse.json({ error: "memo must be a string" }, { status: 400 });
    }
    sessions.setSessionMemo(id, body.memo);
  }
  if (hasAuto) {
    if (typeof body.autoMemo !== "string") {
      return NextResponse.json({ error: "autoMemo must be a string" }, { status: 400 });
    }
    sessions.setSessionAutoMemo(id, body.autoMemo);
  }
  if (hasToggle) {
    if (typeof body.memoAuto !== "boolean") {
      return NextResponse.json({ error: "memoAuto must be a boolean" }, { status: 400 });
    }
    sessions.setSessionMemoAuto(id, body.memoAuto);
  }

  // patchSessionMeta는 쓰기 실패를 삼키므로 재조회로 확인한다.
  return NextResponse.json(sessions.getSessionMemoState(id));
}
