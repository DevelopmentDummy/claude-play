import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const { sessions } = getServices();
  return NextResponse.json(sessions.listSessions());
}

export async function POST(req: Request) {
  const { personaName, title, profileSlug } = (await req.json()) as {
    personaName: string;
    title?: string;
    profileSlug?: string;
  };
  const { sessions } = getServices();
  const profile = profileSlug ? sessions.getProfile(profileSlug) : undefined;
  const session = sessions.createSession(personaName, title, profile ?? undefined);
  return NextResponse.json(session);
}
