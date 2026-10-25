import { NextResponse } from "next/server";
import { requestIp } from "../../../../../lib/backend/ip";
import { playbackStream, jellyfinConfigured, warmSubtitles } from "../../../../../lib/backend/jellyfin";
import { MOCK_AUDIO, MOCK_SUBTITLES } from "../../../../../lib/backend/mock";
import { lookupRoom } from "../../../../../lib/backend/roomserver";

export const dynamic = "force-dynamic";

// Needs only the room code. The stream URL (which carries the Jellyfin token) is handed out here
// and nowhere else, only for the item of a room that exists.
export async function GET(req: Request, { params }: { params: { code: string } }) {
  const found = await lookupRoom(params.code.toUpperCase(), requestIp());
  if (!found.ok) {
    const status = found.reason === "limited" ? 429 : found.reason === "down" ? 502 : 404;
    return NextResponse.json({ error: "no room" }, { status });
  }
  const { room } = found;
  // Optional: the audio track this viewer chose. Each viewer picks their own; it changes only their stream.
  const rawAudio = new URL(req.url).searchParams.get("audio");
  const audioIndex = rawAudio === null ? undefined : /^\d{1,3}$/.test(rawAudio) ? Number(rawAudio) : NaN;
  if (Number.isNaN(audioIndex)) return NextResponse.json({ error: "bad audio track" }, { status: 400 });
  if (!jellyfinConfigured()) {
    return NextResponse.json({ title: room.title, streamUrl: "/api/mock/video", hls: false, subtitles: MOCK_SUBTITLES, audio: { tracks: MOCK_AUDIO, index: audioIndex ?? 0 } });
  }
  const result = await playbackStream(room.itemId, audioIndex).catch(() => ({ error: "Could not reach Jellyfin." }));
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 422 });
  warmSubtitles(room.itemId, result.subtitles);
  return NextResponse.json({ title: room.title, streamUrl: result.url, hls: result.hls, mode: result.mode, subtitles: result.subtitles, video: result.video, audio: result.audio });
}
