import { NextResponse } from "next/server";
import { isAuthed } from "../../../lib/backend/session";
import { getLibrary, jellyfinConfigured } from "../../../lib/backend/jellyfin";
import { MOCK_ITEMS } from "../../../lib/backend/mock";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "passcode needed" }, { status: 401 });
  if (!jellyfinConfigured()) return NextResponse.json({ mock: true, items: MOCK_ITEMS });
  try {
    return NextResponse.json({ mock: false, items: await getLibrary() });
  } catch {
    return NextResponse.json({ error: "Could not reach Jellyfin." }, { status: 502 });
  }
}
