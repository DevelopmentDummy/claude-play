import { NextResponse } from "next/server";
import { listActiveInstances } from "@/lib/services";

export async function GET() {
  return NextResponse.json({
    instances: listActiveInstances(),
  });
}
