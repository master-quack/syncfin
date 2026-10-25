import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const COOKIE = "wp_session";
const MAX_AGE_S = 60 * 60 * 24 * 90;

function secret(): string {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** Constant-time comparison that does not leak the passcode length. */
export function passcodeMatches(given: string): boolean {
  const want = process.env.PARTY_PASSCODE ?? "";
  if (!want) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

export function makeSessionValue(now = Date.now()): string {
  const exp = String(now + MAX_AGE_S * 1000);
  return `${exp}.${sign(exp)}`;
}

export function sessionValid(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  return Number(exp) > now;
}

export const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure,
  path: "/",
  maxAge: MAX_AGE_S,
});

/** True when this request carries a valid passcode session. Use in pages and route handlers. */
export function isAuthed(): boolean {
  return sessionValid(cookies().get(COOKIE)?.value);
}
