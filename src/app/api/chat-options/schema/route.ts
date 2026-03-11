import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET() {
  const { sessions } = getServices();
  const schema = sessions.readOptionsSchema();
  return NextResponse.json(schema);
}
