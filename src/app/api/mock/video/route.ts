import { createReadStream, statSync, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { jellyfinConfigured } from "../../../../lib/backend/jellyfin";

export const dynamic = "force-dynamic";
const FILE = process.env.MOCK_VIDEO_FILE || "data/test.mp4";
const TYPE = FILE.endsWith(".webm") ? "video/webm" : "video/mp4";

// Range-capable stand-in video for the mock library and the Playwright tests.
export async function GET(req: Request) {
  if (jellyfinConfigured() || !existsSync(FILE)) return new NextResponse(null, { status: 404 });
  const size = statSync(FILE).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  const headers: Record<string, string> = { "content-type": TYPE, "accept-ranges": "bytes" };
  if (!range) {
    headers["content-length"] = String(size);
    return new NextResponse(Readable.toWeb(createReadStream(FILE)) as ReadableStream, { headers });
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  headers["content-range"] = `bytes ${start}-${end}/${size}`;
  headers["content-length"] = String(end - start + 1);
  return new NextResponse(Readable.toWeb(createReadStream(FILE, { start, end })) as ReadableStream, { status: 206, headers });
}
