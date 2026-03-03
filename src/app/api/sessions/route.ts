import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const { sessions } = getServices();
  return NextResponse.json(sessions.listSessions());
}

export async function POST(req: Request) {
  const { personaName, title } = (await req.json()) as {
    personaName: string;
    title?: string;
  };
  const { sessions } = getServices();
  const session = sessions.createSession(personaName, title);
  return NextResponse.json(session);
}
