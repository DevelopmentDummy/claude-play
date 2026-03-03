import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const { sessions } = getServices();
  return NextResponse.json(sessions.listProfiles());
}

export async function POST(req: Request) {
  const { name, description } = (await req.json()) as {
    name: string;
    description: string;
  };
  const { sessions } = getServices();
  const slug = sessions.saveProfile({ name, description });
  return NextResponse.json({ slug, name, description });
}
