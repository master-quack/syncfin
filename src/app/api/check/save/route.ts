import { NextResponse } from "next/server";
import { requestIp } from "../../../../lib/backend/ip";

export const dynamic = "force-dynamic";

const hits = new Map<string, number[]>();

/** Keep only plain, short values so a report can never smuggle anything odd into the log. */
function clean(v: unknown, depth = 0): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.replace(/[\r\n]+/g, " ").slice(0, 200);
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) if (/^[\w.-]{1,32}$/.test(k)) out[k] = clean(x, depth + 1);
    return out;
  }
  return null;
}

// A browser's own measurements from the diagnostic page, written to this service's log so they can be read later.
export async function POST(req: Request) {
  const ip = requestIp();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 6) return NextResponse.json({ error: "slow down" }, { status: 429 });
  recent.push(now);
  hits.set(ip, recent);
  const text = await req.text();
  if (text.length > 16_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  try {
    console.log(`diag ${JSON.stringify(clean(JSON.parse(text)))}`);
  } catch {
    return NextResponse.json({ error: "bad report" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
