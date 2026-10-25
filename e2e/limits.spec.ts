import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import WebSocket from "ws";

const PORT = 3192;
const URL = `ws://127.0.0.1:${PORT}/ws`;
let server: ChildProcess;
let code = "";

test.beforeAll(async () => {
  for (const f of ["data/limits.db", "data/limits.db-wal", "data/limits.db-shm"]) rmSync(f, { force: true });
  server = spawn("node", ["--env-file=.env", "--import", "tsx", "server/index.ts"], {
    env: { ...process.env, ROOM_SERVER_PORT: String(PORT), DB_PATH: "./data/limits.db" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/internal/rooms`, {
    method: "POST",
    headers: { "x-internal-secret": process.env.INTERNAL_SECRET!, "content-type": "application/json" },
    body: JSON.stringify({ itemId: "mock-1", title: "T" }),
  });
  code = (await res.json()).code;
});
test.afterAll(() => server?.kill("SIGTERM"));

const connect = (name: string, c = code) =>
  new Promise<{ ws: WebSocket; msgs: any[]; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(URL, { headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` } });
    const msgs: any[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "join", code: c, name }));
      resolve({ ws, msgs, closed });
    });
  });

test("internal API refuses calls without the secret", async () => {
  expect((await fetch(`http://127.0.0.1:${PORT}/internal/rooms`, { method: "POST", body: "{}" })).status).toBe(401);
});

test("chat is capped at 500 characters", async () => {
  const a = await connect("A");
  await expect.poll(() => a.msgs.some((m) => m.t === "welcome")).toBe(true);
  a.ws.send(JSON.stringify({ t: "chat", text: "x".repeat(900) }));
  await expect.poll(() => a.msgs.find((m) => m.t === "chat")?.msg.text.length).toBe(500);
  a.ws.close();
});

test("messages over 64 KB are refused and the socket is dropped", async () => {
  const a = await connect("Big");
  await expect.poll(() => a.msgs.some((m) => m.t === "welcome")).toBe(true);
  a.ws.send(JSON.stringify({ t: "chat", text: "y".repeat(70_000) }));
  expect(await a.closed).toBe(1009);
});

test("more than 30 messages per second gets the socket closed", async () => {
  const a = await connect("Spammer");
  await expect.poll(() => a.msgs.some((m) => m.t === "welcome")).toBe(true);
  for (let i = 0; i < 100; i++) a.ws.send(JSON.stringify({ t: "sync" }));
  expect(await a.closed).toBe(4429);
});

test("an unknown code is told so, and a room holds at most 20", async () => {
  const bad = await connect("Lost", "ZZZZZZZZ");
  await expect.poll(() => bad.msgs.find((m) => m.t === "error")?.code).toBe("NO_ROOM");
  const crowd = [];
  for (let i = 0; i < 20; i++) crowd.push(await connect(`Guest${i}`));
  await expect.poll(() => crowd.filter((c) => c.msgs.some((m) => m.t === "welcome")).length).toBe(20);
  const extra = await connect("TooMany");
  await expect.poll(() => extra.msgs.find((m) => m.t === "error")?.code).toBe("ROOM_FULL");
  crowd.forEach((c) => c.ws.close());
});

test("stats reports are accepted, junk in them is ignored, and the server stays up", async () => {
  const a = await connect("Reporter");
  await expect.poll(() => a.msgs.some((m) => m.t === "welcome")).toBe(true);
  a.ws.send(JSON.stringify({ t: "stats", s: { drift: 0.4, rate: 1, device: "iphone", path: "direct", evil: "x".repeat(500), nested: { a: 1 } } }));
  a.ws.send(JSON.stringify({ t: "stats", s: "not an object" }));
  a.ws.send(JSON.stringify({ t: "stats" }));
  await new Promise((r) => setTimeout(r, 300));
  expect((await fetch(`http://127.0.0.1:${PORT}/health`)).ok).toBe(true);
  a.ws.close();
});

