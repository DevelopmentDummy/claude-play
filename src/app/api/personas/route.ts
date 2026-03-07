import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { sessions } = getServices(auth.userId);
  return NextResponse.json(sessions.listPersonas());
}
