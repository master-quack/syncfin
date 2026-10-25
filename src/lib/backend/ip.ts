import { headers } from "next/headers";

export function requestIp(): string {
  const h = headers();
  const raw = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "";
  return raw.split(",")[0].trim() || "unknown";
}

export function isHttps(): boolean {
  return headers().get("x-forwarded-proto") === "https";
}
