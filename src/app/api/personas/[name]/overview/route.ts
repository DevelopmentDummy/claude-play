import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { sessions } = getServices();
  return NextResponse.json(sessions.readPersonaOverview(name));
}
