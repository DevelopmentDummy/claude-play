import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { sessions } = getServices(auth.userId);
  return NextResponse.json(sessions.listSessions());
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { personaName, title, profileSlug } = (await req.json()) as {
    personaName: string;
    title?: string;
    profileSlug?: string;
  };
  const { sessions } = getServices(auth.userId);
  const profile = profileSlug ? sessions.getProfile(profileSlug) : undefined;
  const session = sessions.createSession(personaName, title, profile ?? undefined);
  return NextResponse.json(session);
}
