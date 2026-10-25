const base = () => process.env.ROOM_SERVER_URL ?? "http://127.0.0.1:3181";
const headers = () => ({ "x-internal-secret": process.env.INTERNAL_SECRET ?? "", "content-type": "application/json" });

export interface RoomInfo {
  code: string;
  itemId: string;
  title: string;
}

export async function createRoom(itemId: string, title: string): Promise<string> {
  const res = await fetch(`${base()}/internal/rooms`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ itemId, title }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`room server said ${res.status}`);
  return (await res.json()).code as string;
}

export type Lookup = { ok: true; room: RoomInfo } | { ok: false; reason: "missing" | "limited" | "down" };

export async function lookupRoom(code: string, ip: string): Promise<Lookup> {
  try {
    const res = await fetch(`${base()}/internal/rooms/${encodeURIComponent(code)}?ip=${encodeURIComponent(ip)}`, {
      headers: headers(),
      cache: "no-store",
    });
    if (res.status === 429) return { ok: false, reason: "limited" };
    if (!res.ok) return { ok: false, reason: "missing" };
    return { ok: true, room: (await res.json()) as RoomInfo };
  } catch {
    return { ok: false, reason: "down" };
  }
}
