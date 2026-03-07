import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { sessions } = getServices(auth.userId);
  return NextResponse.json(sessions.listProfiles());
}

export async function POST(req: Request) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { name, description, isPrimary } = (await req.json()) as {
    name: string;
    description: string;
    isPrimary?: boolean;
  };
  const { sessions } = getServices(auth.userId);
  const slug = sessions.saveProfile({ name, description, ...(isPrimary ? { isPrimary } : {}) });
  return NextResponse.json({ slug, name, description, isPrimary });
}
