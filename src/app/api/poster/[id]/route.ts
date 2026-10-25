import { NextResponse } from "next/server";
import { isAuthed } from "../../../../lib/backend/session";
import { jellyfinConfigured, posterResponse } from "../../../../lib/backend/jellyfin";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!isAuthed() || !jellyfinConfigured() || !/^[0-9a-f]{32}$/i.test(params.id)) return new NextResponse(null, { status: 404 });
  const res = await posterResponse(params.id).catch(() => null);
  if (!res || !res.ok || !res.body) return new NextResponse(null, { status: 404 });
  return new NextResponse(res.body, {
    headers: { "content-type": res.headers.get("content-type") ?? "image/jpeg", "cache-control": "private, max-age=86400" },
  });
}
