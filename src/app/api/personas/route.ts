import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const { sessions } = getServices();
  return NextResponse.json(sessions.listPersonas());
}
