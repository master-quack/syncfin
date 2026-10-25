import { NextResponse } from "next/server";
import { getLibrary, jellyfinConfigured, playbackStream } from "../../../../lib/backend/jellyfin";
import { isAuthed } from "../../../../lib/backend/session";

export const dynamic = "force-dynamic";

// Behind the passcode (it hands out a stream URL). Picks a typical heavy live-remux title so the browser can time
// how fast a real stream of that weight arrives over its own connection.
export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "passcode needed" }, { status: 401 });
  if (!jellyfinConfigured()) return NextResponse.json({ title: "Test card", streamUrl: "/api/mock/video", hls: false, video: null, bitrateMbps: 0.5 });
  const items = (await getLibrary().catch(() => [])).filter((i) => i.mode === "remux" && i.bitrateMbps);
  const pick = [...items].sort((a, b) => Math.abs((a.bitrateMbps ?? 0) - 4.7) - Math.abs((b.bitrateMbps ?? 0) - 4.7))[0];
  if (!pick) return NextResponse.json({ error: "no remux title to test with" }, { status: 404 });
  const plan = await playbackStream(pick.id).catch(() => ({ error: "Could not reach Jellyfin." }));
  if ("error" in plan) return NextResponse.json({ error: plan.error }, { status: 422 });
  return NextResponse.json({ title: pick.title, streamUrl: plan.url, hls: plan.hls, video: plan.video, bitrateMbps: pick.bitrateMbps });
}
