import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const svc = getServices();
  return NextResponse.json(svc.chatHistory);
}
