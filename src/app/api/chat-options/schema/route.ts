import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(req: Request) {
  const { sessions } = getServices();
  const schema = sessions.readOptionsSchema();
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const filtered = scope
    ? schema.filter((o: Record<string, unknown>) => o.scope === scope || o.scope === "both")
    : schema;
  return NextResponse.json(filtered);
}
