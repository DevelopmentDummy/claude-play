import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { requireAuth } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { slug } = await params;
  const { sessions } = getServices(auth.userId);
  const profile = sessions.getProfile(slug);
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ slug, ...profile });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { slug } = await params;
  const { sessions } = getServices(auth.userId);
  const existing = sessions.getProfile(slug);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { name, description, isPrimary } = await req.json();
  const newSlug = sessions.saveProfile({
    name: name || existing.name,
    description: description ?? existing.description,
    ...(isPrimary !== undefined ? { isPrimary } : existing.isPrimary ? { isPrimary: existing.isPrimary } : {}),
  });
  // If name changed (slug changed), delete old file
  if (newSlug !== slug) {
    sessions.deleteProfile(slug);
  }
  return NextResponse.json({ slug: newSlug, name: name || existing.name });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const { slug } = await params;
  const { sessions } = getServices(auth.userId);
  sessions.deleteProfile(slug);
  return NextResponse.json({ ok: true });
}
