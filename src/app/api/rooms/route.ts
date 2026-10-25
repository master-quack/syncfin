import { NextResponse } from "next/server";
import { isAuthed } from "../../../lib/backend/session";
import { getLibrary, itemTitle, jellyfinConfigured } from "../../../lib/backend/jellyfin";
import { MOCK_ITEMS } from "../../../lib/backend/mock";
import { createRoom } from "../../../lib/backend/roomserver";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "passcode needed" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 64) : "";
  if (!/^[A-Za-z0-9_-]+$/.test(itemId)) return NextResponse.json({ error: "Pick something first." }, { status: 400 });

  let title: string | null;
  if (!jellyfinConfigured()) {
    const mock = MOCK_ITEMS.find((i) => i.id === itemId && i.playable);
    title = mock?.title ?? null;
  } else {
    const known = (await getLibrary().catch(() => [])).find((i) => i.id === itemId);
    if (known && !known.playable) return NextResponse.json({ error: known.reason ?? "That title cannot be played here." }, { status: 409 });
    title = await itemTitle(itemId).catch(() => null);
  }
  if (!title) return NextResponse.json({ error: "That title is not available." }, { status: 404 });

  try {
    return NextResponse.json({ code: await createRoom(itemId, title) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "The room server is not answering." }, { status: 502 });
  }
}
