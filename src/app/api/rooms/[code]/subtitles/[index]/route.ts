import { NextResponse } from "next/server";
import { requestIp } from "../../../../../../lib/backend/ip";
import { fetchSubtitleVtt, jellyfinConfigured } from "../../../../../../lib/backend/jellyfin";
import { MOCK_SUBTITLES, MOCK_VTT } from "../../../../../../lib/backend/mock";
import { lookupRoom } from "../../../../../../lib/backend/roomserver";

export const dynamic = "force-dynamic";

// Needs only the room code, like the stream itself. Serves one subtitle track as WebVTT from our own origin.
export async function GET(_req: Request, { params }: { params: { code: string; index: string } }) {
  if (!/^\d{1,3}$/.test(params.index)) return new NextResponse(null, { status: 400 });
  const found = await lookupRoom(params.code.toUpperCase(), requestIp());
  if (!found.ok) return new NextResponse(null, { status: found.reason === "limited" ? 429 : found.reason === "down" ? 502 : 404 });
  const index = Number(params.index);

  let vtt: string | null;
  if (!jellyfinConfigured()) {
    const track = MOCK_SUBTITLES.find((t) => t.index === index);
    vtt = track ? MOCK_VTT(track.lang) : null;
  } else {
    vtt = await fetchSubtitleVtt(found.room.itemId, index).catch(() => null);
  }
  if (!vtt) return new NextResponse(null, { status: 404 });
  return new NextResponse(vtt, { headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": "private, max-age=3600" } });
}
