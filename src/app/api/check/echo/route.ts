import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// A tiny answer, for timing the round trip between a browser and this site.
export async function GET() {
  return NextResponse.json({ t: Date.now() }, { headers: { "cache-control": "no-store" } });
}
