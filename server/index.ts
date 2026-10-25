import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS, REACTIONS, ROOM_ALPHABET, STATS_KEYS, ROOM_CODE_LENGTH, type ClientMessage, type ServerMessage } from "../src/lib/sync/protocol";
import { Store } from "./db";
import { Room } from "./room";

const PORT = Number(process.env.ROOM_SERVER_PORT ?? 3181);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? "";
const DB_PATH = process.env.DB_PATH ?? "./data/party.db";
const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

if (INTERNAL_SECRET.length < 16) {
  console.error("INTERNAL_SECRET is missing or too short; refusing to start.");
  process.exit(1);
}

const store = new Store(DB_PATH);
const rooms = new Map<string, Room>();

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function cleanup(): void {
  const n = store.cleanup();
  if (n > 0) log(`cleanup: removed ${n} expired room(s)`);
  for (const [code, room] of rooms) {
    if (!store.getRoom(code) && room.peers.size === 0) rooms.delete(code);
  }
}
cleanup();
setInterval(cleanup, 60 * 60 * 1000).unref();

// Save the position of every busy room periodically so a crash loses at most 30 s.
setInterval(() => {
  for (const room of rooms.values()) if (room.peers.size > 0) room.persist();
}, 30_000).unref();

/** Per-IP sliding window for join attempts. */
class IpLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }
  sweep(now = Date.now()): void {
    for (const [ip, ts] of this.hits) if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(ip);
  }
}
const joinLimiter = new IpLimiter(45, 60_000);
setInterval(() => joinLimiter.sweep(), 60_000).unref();

function clientIp(req: IncomingMessage): string {
  const h = req.headers;
  const fwd = (h["cf-connecting-ip"] ?? h["x-forwarded-for"] ?? "") as string;
  return fwd.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function authorised(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers["x-internal-secret"] ?? ""));
  const want = Buffer.from(INTERNAL_SECRET);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4096) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getRoom(code: string): Room | null {
  const live = rooms.get(code);
  if (live) return live;
  const row = store.getRoom(code);
  if (!row) return null;
  const room = new Room(row, store, Date.now, log);
  rooms.set(code, room);
  return room;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/health") return json(200, { ok: true });
  if (!url.pathname.startsWith("/internal/")) return json(404, { error: "not found" });
  if (!authorised(req)) return json(401, { error: "unauthorised" });

  try {
    if (req.method === "POST" && url.pathname === "/internal/rooms") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const itemId = String(body.itemId ?? "").slice(0, 128);
      const title = String(body.title ?? "").slice(0, 200);
      if (!itemId) return json(400, { error: "itemId required" });
      const row = store.createRoom(itemId, title);
      log(`room created ${row.code}`);
      return json(201, { code: row.code });
    }

    const m = url.pathname.match(/^\/internal\/rooms\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const ip = url.searchParams.get("ip") || "unknown";
      if (!joinLimiter.allow(ip)) return json(429, { error: "slow down" });
      const code = m[1].toUpperCase();
      const room = CODE_RE.test(code) ? getRoom(code) : null;
      if (!room) return json(404, { error: "no such room" });
      return json(200, { code, itemId: room.row.itemId, title: room.row.title });
    }
  } catch (e) {
    log(`internal error: ${String(e)}`);
    return json(400, { error: "bad request" });
  }
  json(404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: LIMITS.MAX_MSG_BYTES });

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function uniqueName(room: Room, raw: string): string {
  const base = raw.replace(/\s+/g, " ").trim().slice(0, LIMITS.MAX_NAME) || "Guest";
  const taken = new Set([...room.peers.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, LIMITS.MAX_NAME - 3)} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 16)} ${randomUUID().slice(0, 4)}`;
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  let room: Room | null = null;
  let id = "";
  let tokens: number = LIMITS.RATE_PER_SEC;
  let refilled = Date.now();

  const fail = (code: string, message: string, close = 4000) => {
    send(ws, { t: "error", code, message });
    ws.close(close, code);
  };

  // Joining must happen quickly or the socket is dropped.
  const joinTimer = setTimeout(() => !room && ws.close(4408, "join timeout"), 10_000);

  ws.on("message", (raw) => {
    const now = Date.now();
    tokens = Math.min(LIMITS.RATE_PER_SEC, tokens + ((now - refilled) / 1000) * LIMITS.RATE_PER_SEC);
    refilled = now;
    if (tokens < 1) return fail("RATE_LIMITED", "Too many messages.", 4429);
    tokens -= 1;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "ping") {
      if (typeof msg.clientTs === "number") send(ws, { t: "pong", clientTs: msg.clientTs, serverTs: now });
      return;
    }

    if (msg.t === "join") {
      if (room) return;
      if (!joinLimiter.allow(ip)) return fail("RATE_LIMITED", "Too many join attempts. Try again in a minute.", 4429);
      const code = String(msg.code ?? "").toUpperCase();
      const target = CODE_RE.test(code) ? getRoom(code) : null;
      if (!target) return fail("NO_ROOM", "That room does not exist (anymore).", 4404);
      if (target.peers.size >= LIMITS.MAX_CLIENTS) return fail("ROOM_FULL", "That room is full.", 4403);
      clearTimeout(joinTimer);
      id = randomUUID();
      room = target;
      const name = uniqueName(target, String(msg.name ?? ""));
      target.join({ id, name, send: (m) => send(ws, m) });
      log(`join ${code} (${target.peers.size} in room)`);
      return;
    }

    if (!room) return;
    switch (msg.t) {
      case "cmd": {
        const c = msg.cmd;
        if (!c || typeof c !== "object") return;
        if (c.kind === "play" || c.kind === "pause") room.command(id, { kind: c.kind });
        else if (c.kind === "seek" && typeof c.position === "number") room.command(id, { kind: "seek", position: c.position });
        else if (c.kind === "back") room.command(id, { kind: "back", seconds: 15 });
        break;
      }
      case "stalled":
        room.markStalled(id);
        break;
      case "ready":
        room.markReady(id);
        break;
      case "chat":
        if (typeof msg.text === "string") room.chat(id, msg.text);
        break;
      case "react":
        if (typeof msg.kind === "string" && (REACTIONS as readonly string[]).includes(msg.kind)) room.react(id, msg.kind);
        break;
      case "stats": {
        // Playback numbers for diagnosing stutter: only known keys, short plain values, logged once.
        const who = room.peers.get(id)?.name ?? "?";
        const parts: string[] = [];
        for (const k of STATS_KEYS) {
          const v = (msg.s as Record<string, unknown> | undefined)?.[k];
          if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}=${Math.round(v * 100) / 100}`);
          else if (typeof v === "string" && /^[\w./:-]{1,24}$/.test(v)) parts.push(`${k}=${v}`);
        }
        if (parts.length) log(`stats ${room.row.code.slice(0, 3)}… ${JSON.stringify(who.slice(0, 24))} ${parts.join(" ")}`);
        break;
      }
      case "sync":
        room.sync(id);
        break;
    }
  });

  ws.on("close", () => {
    clearTimeout(joinTimer);
    if (room && id) {
      room.leave(id);
      log(`leave ${room.row.code} (${room.peers.size} in room)`);
    }
  });
  ws.on("error", () => ws.terminate());
});

// Drop dead sockets.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as WebSocket & { alive?: boolean };
    if (w.alive === false) {
      ws.terminate();
      continue;
    }
    w.alive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();
wss.on("connection", (ws) => {
  const w = ws as WebSocket & { alive?: boolean };
  w.alive = true;
  ws.on("pong", () => (w.alive = true));
});

server.listen(PORT, "127.0.0.1", () => log(`room server listening on 127.0.0.1:${PORT}`));

function shutdown(): void {
  for (const room of rooms.values()) room.persist();
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
