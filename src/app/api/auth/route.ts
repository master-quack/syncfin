import { NextResponse } from "next/server";
import { COOKIE, cookieOptions, makeSessionValue, passcodeMatches } from "../../../lib/backend/session";
import { isHttps, requestIp } from "../../../lib/backend/ip";

export const dynamic = "force-dynamic";

const attempts = new Map<string, number[]>();

function allowed(ip: string): boolean {
  const now = Date.now();
  for (const [key, times] of attempts) if (times.every((t) => now - t >= 60_000)) attempts.delete(key);
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  attempts.set(ip, recent);
  return true;
}

export async function POST(req: Request) {
  if (!allowed(requestIp())) return NextResponse.json({ error: "Too many tries. Give it a minute." }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const given = typeof body.passcode === "string" ? body.passcode.slice(0, 200) : "";
  if (!passcodeMatches(given)) return NextResponse.json({ error: "That is not the passcode." }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, makeSessionValue(), cookieOptions(isHttps()));
  return res;
}
