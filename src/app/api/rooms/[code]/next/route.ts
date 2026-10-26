import { NextResponse } from "next/server";
import { requestIp } from "../../../../../lib/backend/ip";
import { getLibrary, jellyfinConfigured } from "../../../../../lib/backend/jellyfin";
import { MOCK_ITEMS } from "../../../../../lib/backend/mock";
import { lookupRoom, setRoomItem } from "../../../../../lib/backend/roomserver";
import { nextInSeries } from "../../../../../lib/backend/series";

export const dynamic = "force-dynamic";

async function find(code: string) {
  const found = await lookupRoom(code.toUpperCase(), requestIp());
  if (!found.ok) return { error: NextResponse.json({ error: "no room" }, { status: found.reason === "limited" ? 429 : found.reason === "down" ? 502 : 404 }) };
  const items = jellyfinConfigured() ? await getLibrary().catch(() => []) : MOCK_ITEMS;
  return { room: found.room, next: nextInSeries(items, found.room.itemId) };
}

// Moves everyone in the room to the next episode. `from` is the episode the caller was watching, so a double press does it once.
export async function POST(req: Request, { params }: { params: { code: string } }) {
  const r = await find(params.code);
  if (r.error) return r.error;
  const body = await req.json().catch(() => ({}));
  if (body.from !== r.room.itemId) return NextResponse.json({ error: "The room has already moved on." }, { status: 409 });
  if (!r.next) return NextResponse.json({ error: "That was the last episode." }, { status: 404 });
  const moved = await setRoomItem(params.code.toUpperCase(), r.next.id, r.next.title, r.room.itemId).catch(() => null);
  if (moved === null) return NextResponse.json({ error: "The room server is not answering." }, { status: 502 });
  if (!moved) return NextResponse.json({ error: "The room has already moved on." }, { status: 409 });
  return NextResponse.json({ ok: true, title: r.next.title });
}
