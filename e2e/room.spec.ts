import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const WEB = "http://127.0.0.1:3190";
const ROOM_PORT = 3191;
const SHOTS = process.env.SHOTS_DIR ?? "test-results/shots";

let server: ChildProcess | null = null;

async function startRoomServer(): Promise<void> {
  server = spawn("node", ["--env-file=.env", "--import", "tsx", "server/index.ts"], {
    env: { ...process.env, ROOM_SERVER_PORT: String(ROOM_PORT), DB_PATH: "./data/e2e.db" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ROOM_PORT}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("room server did not start");
}

async function stopRoomServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  const exited = new Promise((r) => s.once("exit", r));
  s.kill("SIGTERM"); // the server persists room positions on SIGTERM
  await exited;
}

test.beforeAll(async () => {
  for (const f of ["data/e2e.db", "data/e2e.db-wal", "data/e2e.db-shm"]) rmSync(f, { force: true });
  await startRoomServer();
});
test.afterAll(stopRoomServer);

/** Passcode flow, then open a room for the first mock title. Returns the room code. */
async function createRoom(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${WEB}/library`);
  await page.getByLabel("Passcode").fill(process.env.PARTY_PASSCODE!);
  await page.getByRole("button", { name: "Let me in" }).click();
  await page.getByTestId("library-item").first().getByRole("button", { name: "Open a room" }).click();
  await page.waitForURL(/\/room\/[A-Z0-9]{8}$/);
  const code = page.url().split("/").pop()!;
  await ctx.close();
  return code;
}

const pageErrors: string[] = [];
test.afterEach(() => {
  expect(pageErrors, "uncaught errors in the page").toEqual([]);
  pageErrors.length = 0;
});

async function sit(ctx: BrowserContext, code: string, name: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${WEB}/room/${code}`);
  await page.locator("#name").fill(name);
  const join = page.getByTestId("join");
  await expect(join).toBeEnabled({ timeout: 15_000 });
  await join.click();
  await expect(page.getByTestId("members").getByText(name)).toBeVisible();
  return page;
}

const video = (p: Page) =>
  p.evaluate(() => {
    const v = document.querySelector("video")!;
    return { paused: v.paused, t: v.currentTime };
  });

test("the library is behind the passcode and the room page is not", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${WEB}/library`);
  await expect(page.getByText("The library is")).toBeVisible();
  expect((await request.get(`${WEB}/api/library`)).status()).toBe(401);
  expect((await request.post(`${WEB}/api/rooms`, { data: { itemId: "mock-1" } })).status()).toBe(401);
  await page.getByLabel("Passcode").fill("wrong");
  await page.getByRole("button", { name: "Let me in" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("not the passcode");
  await ctx.close();

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(`${WEB}/room/ZZZZZZZZ`);
  await expect(page2.getByText("exist (anymore).")).toBeVisible();
  await ctx2.close();
});

test("two viewers stay in sync: play, pause, seek, back 15, stall, chat, restart", async ({ browser }) => {
  const code = await createRoom(browser);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await sit(ctxA, code, "Yousuf");
  const b = await sit(ctxB, code, "Simra");
  await expect(a.getByTestId("members").locator("li")).toHaveCount(2);
  await a.waitForTimeout(2300); // the 2 s echo guard after joining ignores the video's own events

  // --- play: both start and advance together
  await a.evaluate(() => document.querySelector("video")!.play());
  await expect.poll(async () => (await video(b)).paused, { timeout: 8000 }).toBe(false);
  await expect.poll(async () => (await video(a)).t, { timeout: 8000 }).toBeGreaterThan(1.5);
  const [ta, tb] = [(await video(a)).t, (await video(b)).t];
  expect(Math.abs(ta - tb)).toBeLessThan(0.6);

  await a.waitForTimeout(2300);
  // --- pause: the other context pauses within 500 ms (measured five times)
  await b.evaluate(() => {
    (window as any).__pausedAt = 0;
    document.querySelector("video")!.addEventListener("pause", () => ((window as any).__pausedAt = Date.now()));
  });
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    console.log(`pause round ${i + 1}: A visibility=${await a.evaluate(() => document.visibilityState)}, B visibility=${await b.evaluate(() => document.visibilityState)}, A paused=${(await video(a)).paused}, B paused=${(await video(b)).paused}`);
    await b.evaluate(() => ((window as any).__pausedAt = 0));
    const t0 = await a.evaluate(() => {
      const t = Date.now();
      document.querySelector("video")!.pause();
      return t;
    });
    try {
      await expect.poll(() => b.evaluate(() => (window as any).__pausedAt as number), { timeout: 5000 }).toBeGreaterThan(0);
    } catch (e) {
      console.log(`PAUSE LOST in round ${i + 1}: A=${JSON.stringify(await video(a))} B=${JSON.stringify(await video(b))}`);
      throw e;
    }
    delays.push((await b.evaluate(() => (window as any).__pausedAt as number)) - t0);
    expect((await video(b)).paused).toBe(true);
    await a.waitForTimeout(2300);
    await a.evaluate(() => document.querySelector("video")!.play());
    await expect.poll(async () => (await video(b)).paused, { timeout: 8000 }).toBe(false);
    await a.waitForTimeout(2500);
  }
  console.log(`pause propagation to the other context (ms): ${delays.join(", ")}`);
  expect(Math.max(...delays)).toBeLessThan(500);
  await a.evaluate(() => document.querySelector("video")!.pause());
  await expect.poll(async () => (await video(b)).paused, { timeout: 5000 }).toBe(true);

  await a.waitForTimeout(2300);
  // --- seek: the other follows
  await a.evaluate(() => (document.querySelector("video")!.currentTime = 90));
  await expect.poll(async () => Math.abs((await video(b)).t - 90), { timeout: 5000 }).toBeLessThan(1);
  expect((await video(b)).paused).toBe(true);

  await a.waitForTimeout(2300);
  // --- play again, then back 15 s for everyone
  await b.evaluate(() => document.querySelector("video")!.play());
  await expect.poll(async () => (await video(a)).paused, { timeout: 8000 }).toBe(false);
  await a.waitForTimeout(1500);
  const before = (await video(a)).t;
  await b.getByTestId("rewind15").click();
  await expect.poll(async () => (await video(a)).t, { timeout: 5000 }).toBeLessThan(before - 10);
  await expect.poll(async () => Math.abs((await video(a)).t - (await video(b)).t), { timeout: 5000 }).toBeLessThan(1);

  await b.waitForTimeout(2500);
  // --- stall: Simra buffers, the room waits and says so, then resumes together
  await b.evaluate(() => {
    const v = document.querySelector("video")!;
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 1 });
    v.dispatchEvent(new Event("waiting"));
  });
  const note = a.getByTestId("stall-note");
  await expect(note).toContainText("Simra is buffering. Continuing in", { timeout: 5000 });
  await expect(b.getByTestId("stall-note")).toBeVisible();
  await expect.poll(async () => (await video(a)).paused, { timeout: 3000 }).toBe(true);
  const countdown = Number((await note.textContent())!.match(/Continuing in (\d+)/)![1]);
  expect(countdown).toBeLessThanOrEqual(10);
  await a.screenshot({ path: `${SHOTS}/stall-note.png` });
  await b.evaluate(() => {
    const v = document.querySelector("video")!;
    delete (v as any).readyState;
    v.dispatchEvent(new Event("canplay"));
  });
  await expect(note).toBeHidden({ timeout: 5000 });
  await expect.poll(async () => (await video(a)).paused, { timeout: 5000 }).toBe(false);
  await expect.poll(async () => (await video(b)).paused, { timeout: 5000 }).toBe(false);

  // --- stall that never recovers: the room carries on after 10 s
  await b.evaluate(() => {
    const v = document.querySelector("video")!;
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 1 });
    v.dispatchEvent(new Event("waiting"));
  });
  await expect(note).toBeVisible({ timeout: 5000 });
  const stalledAt = Date.now();
  await expect(note).toBeHidden({ timeout: 14_000 });
  console.log(`room gave up waiting after ${Date.now() - stalledAt} ms`);
  await expect.poll(async () => (await video(a)).paused, { timeout: 5000 }).toBe(false);
  await b.evaluate(() => {
    const v = document.querySelector("video")!;
    delete (v as any).readyState;
    v.dispatchEvent(new Event("canplay"));
  });

  // --- chat, then a server restart keeps the history
  await a.locator("#chat").fill("is the popcorn ready");
  await a.locator("#chat").press("Enter");
  await expect(b.getByTestId("chat-log")).toContainText("is the popcorn ready");
  await b.screenshot({ path: `${SHOTS}/room-desktop.png` });

  await a.waitForTimeout(2500);
  await a.evaluate(() => document.querySelector("video")!.pause());
  await expect.poll(async () => (await video(b)).paused, { timeout: 5000 }).toBe(true);
  const pausedAt = (await video(a)).t;
  await ctxA.close();
  await ctxB.close();
  await stopRoomServer();
  await startRoomServer();

  const ctxC = await browser.newContext();
  const c = await sit(ctxC, code, "Simra");
  await expect(c.getByTestId("chat-log")).toContainText("is the popcorn ready");
  // reopening resumes at the last position, paused
  await expect.poll(async () => Math.abs((await video(c)).t - pausedAt), { timeout: 5000 }).toBeLessThan(1.5);
  expect((await video(c)).paused).toBe(true);
  await ctxC.close();
});

test("a stranger's code is refused after too many guesses", async ({ request }) => {
  let limited = false;
  for (let i = 0; i < 60 && !limited; i++) {
    const res = await request.get(`${WEB}/api/rooms/ABCDEFGH/stream`, { headers: { "x-forwarded-for": "203.0.113.7" } });
    limited = res.status() === 429;
  }
  expect(limited).toBe(true);
});

test("phone width (360 px): no sideways scroll, ticket and join fit", async ({ browser }) => {
  const code = await createRoom(browser);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const path of ["/", "/library", `/room/${code}`, "/missing"]) {
    await page.goto(`${WEB}${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/mobile-${path === "/" ? "home" : path.split("/")[1]}.png`, fullPage: true });
  }
  await ctx.close();
});

test("desktop screenshots for review", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/`);
  await page.screenshot({ path: `${SHOTS}/home.png` });
  await page.goto(`${WEB}/nope`);
  await page.screenshot({ path: `${SHOTS}/404.png` });
  await page.goto(`${WEB}/room/ZZZZZZZZ`);
  await page.screenshot({ path: `${SHOTS}/room-missing.png` });
  await ctx.close();
});

test("skip and rewind move the whole room by 15 s, repeated presses add up, and the old button is gone", async ({ browser }) => {
  const code = await createRoom(browser);
  const a = await sit(await browser.newContext(), code, "Yousuf");
  const b = await sit(await browser.newContext(), code, "Simra");
  await expect(a.getByTestId("members").locator("li")).toHaveCount(2);
  await expect(a.getByTestId("back15")).toHaveCount(0);
  await a.waitForTimeout(2300);
  await a.evaluate(() => (document.querySelector("video")!.currentTime = 60));
  await expect.poll(async () => Math.abs((await video(b)).t - 60), { timeout: 6000 }).toBeLessThan(1.5);
  await a.waitForTimeout(2500);

  await b.getByTestId("skip15").click();
  await expect.poll(async () => Math.abs((await video(a)).t - 75), { timeout: 6000 }).toBeLessThan(1.5);
  await a.waitForTimeout(2500);
  await a.getByTestId("rewind15").click();
  await expect.poll(async () => Math.abs((await video(b)).t - 60), { timeout: 6000 }).toBeLessThan(1.5);
  await b.waitForTimeout(2500);

  await b.getByTestId("skip15").click();
  await b.getByTestId("skip15").click();
  await expect.poll(async () => Math.abs((await video(a)).t - 90), { timeout: 6000 }).toBeLessThan(1.5);
});

test("reactions float up for everyone and clear themselves; spam is thinned", async ({ browser }) => {
  const code = await createRoom(browser);
  const a = await sit(await browser.newContext(), code, "Yousuf");
  const b = await sit(await browser.newContext(), code, "Simra");
  await expect(a.getByTestId("members").locator("li")).toHaveCount(2);
  await a.getByTestId("react-btn").click();
  await a.getByTestId("react-heart").click();
  await expect(b.locator('[data-testid=reaction][data-kind=heart]')).toBeVisible();
  await expect(a.locator('[data-testid=reaction][data-kind=heart]')).toBeVisible();
  await expect(b.locator('[data-testid=reaction]')).toHaveCount(0, { timeout: 8000 });
  for (let i = 0; i < 12; i++) await a.getByTestId("react-fire").click({ delay: 0 });
  const n = await b.locator('[data-testid=reaction]').count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(12); // the server drops anything closer than 150 ms to the last one
  await b.screenshot({ path: `${SHOTS}/reactions.png` });
});

test("subtitles: pick a language, cues load as a text track, the choice is remembered, Off removes them", async ({ browser }) => {
  const code = await createRoom(browser);
  const ctx = await browser.newContext();
  const page = await sit(ctx, code, "Subs");
  const track = () =>
    page.evaluate(() => {
      const t = document.querySelector("video")!.textTracks;
      return t.length ? `${t[0].mode}:${t[0].cues?.length ?? 0}` : "none";
    });
  await expect(page.getByTestId("subs-btn")).toBeVisible();
  await page.getByTestId("subs-btn").click();
  await expect(page.getByTestId("subs-item")).toHaveCount(2);
  await page.waitForTimeout(500); // let the menu finish fading in
  await page.screenshot({ path: `${SHOTS}/subtitles-menu.png` });
  await page.getByTestId("subs-item").first().click(); // English
  await expect.poll(track, { timeout: 8000 }).toBe("showing:2");

  // remembered on this device: a fresh visit turns English on by itself
  await page.reload();
  await page.locator("#name").fill("Subs");
  await expect(page.getByTestId("join")).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId("join").click();
  await expect(page.getByTestId("members").getByText("Subs")).toBeVisible();
  await expect.poll(track, { timeout: 8000 }).toBe("showing:2");

  await page.getByTestId("subs-btn").click();
  await page.getByRole("menuitemradio", { name: "Off" }).click();
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("track[data-ys]").length), { timeout: 4000 }).toBe(0);
  await ctx.close();
});

test("fullscreen chat: popups only while closed, a slide-over that never resizes the video, and a pin that sticks", async ({ browser }) => {
  const code = await createRoom(browser);
  const a = await sit(await browser.newContext(), code, "Yousuf");
  const b = await sit(await browser.newContext(), code, "Simra");
  await expect(a.getByTestId("members").locator("li")).toHaveCount(2);
  await a.getByTestId("fs-btn").click();
  await expect(a.getByTestId("player")).toHaveAttribute("data-fs", /native|css/);

  // chat closed: a new message pops up over the picture
  await b.locator("#chat").fill("psst, pizza?");
  await b.locator("#chat").press("Enter");
  await expect(a.getByTestId("chat-popup")).toContainText("psst, pizza?");
  await b.locator("#chat").fill("are you there");
  await b.locator("#chat").press("Enter");
  await expect(a.getByTestId("chat-popup")).toHaveCount(2);
  await a.waitForTimeout(500); // let them settle: the older one recedes
  await a.screenshot({ path: `${SHOTS}/fullscreen-popup.png` });

  // open it: popups go away and the panel overlays the picture without squeezing it
  const before = (await a.getByTestId("video").boundingBox())!;
  await a.getByTestId("chat-tab").click();
  await expect(a.getByTestId("chat-panel")).toBeVisible();
  await expect(a.getByTestId("chat-popup")).toHaveCount(0);
  const after = (await a.getByTestId("video").boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);

  // a message while it is open does not pop up; it just appears in the panel
  await b.locator("#chat").fill("second one");
  await b.locator("#chat").press("Enter");
  await expect(a.getByTestId("chat-panel")).toContainText("second one");
  await expect(a.getByTestId("chat-popup")).toHaveCount(0);
  await a.screenshot({ path: `${SHOTS}/fullscreen-chat-open.png` });

  // typing from inside fullscreen works, and the pin survives leaving and re-entering
  await a.getByTestId("chat-panel").locator("#chat").fill("from fullscreen");
  await a.getByTestId("chat-panel").locator("#chat").press("Enter");
  await expect(b.getByTestId("chat-log")).toContainText("from fullscreen");
  await a.getByTestId("chat-pin").click();
  await a.getByTestId("fs-btn").click();
  await expect(a.getByTestId("player")).toHaveAttribute("data-fs", "off");
  await a.getByTestId("fs-btn").click();
  await expect(a.getByTestId("chat-panel")).toBeVisible();
});

test("Safari-style phones get a page-filling fullscreen (real fullscreen blocks typing there)", async ({ browser }) => {
  const code = await createRoom(browser);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await sit(ctx, code, "Phone");
  await page.getByTestId("fs-btn").tap();
  await expect(page.getByTestId("player")).toHaveAttribute("data-fs", "css");
  const box = (await page.getByTestId("player").boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(box.height).toBeGreaterThanOrEqual(843);
  // nothing of the page may show through: the room title, header and chat are all behind the player
  const covered = await page.evaluate(() => {
    const p = document.querySelector('[data-testid=player]')!;
    const bg = getComputedStyle(p).backgroundColor;
    const at = document.elementFromPoint(10, 10);
    return { bg, topmostInsidePlayer: !!at && p.contains(at) };
  });
  expect(covered.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(covered.topmostInsidePlayer).toBe(true);
  await page.screenshot({ path: `${SHOTS}/mobile-fullscreen.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByTestId("fs-btn").tap();
  await expect(page.getByTestId("player")).toHaveAttribute("data-fs", "off");
  await ctx.close();
});

test("playback check page: browser support list shows, the stream test asks for the passcode, then runs", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${WEB}/diag`);
  await expect(page.getByTestId("diag-support").locator("li")).toHaveCount(3);
  await page.getByTestId("diag-run").click();
  await expect(page.locator("p[role=alert]")).toContainText("needs the passcode", { timeout: 30_000 });

  // log in once, as a person would on the library page, then run again
  await page.goto(`${WEB}/library`);
  await page.getByLabel("Passcode").fill(process.env.PARTY_PASSCODE!);
  await page.getByRole("button", { name: "Let me in" }).click();
  await expect(page.getByRole("heading", { name: "Pick something." })).toBeVisible();
  await page.goto(`${WEB}/diag`);
  await page.getByTestId("diag-run").click();
  // the mock library is direct play, so there is no stream to time, but the page must say so rather than hang
  await expect(page.getByTestId("diag-stream")).toContainText("Could not run the stream test", { timeout: 40_000 });
  await ctx.close();
});

test("audio track picker: shows with 2+ tracks, switches only my own stream, asks for the right track, and is remembered", async ({ browser }) => {
  const code = await createRoom(browser);
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  const requested: string[] = [];
  a.on("request", (r) => r.url().includes("/stream") && requested.push(new URL(r.url()).search));
  a.on("pageerror", (e) => pageErrors.push(e.message));
  await a.goto(`${WEB}/room/${code}`);
  await a.locator("#name").fill("Yousuf");
  await expect(a.getByTestId("join")).toBeEnabled({ timeout: 15_000 });
  await a.getByTestId("join").click();
  const b = await sit(await browser.newContext(), code, "Simra");
  await expect(a.getByTestId("members").locator("li")).toHaveCount(2);

  await expect(a.getByTestId("audio-btn")).toBeVisible();
  await a.getByTestId("audio-btn").click();
  await expect(a.getByTestId("audio-item")).toHaveCount(2);
  await expect(a.getByTestId("audio-item").first()).toHaveAttribute("aria-checked", "true"); // English, the default
  await a.waitForTimeout(400); // let the menu finish fading in
  await a.screenshot({ path: `${SHOTS}/audio-menu.png` });

  const before = requested.length;
  await a.getByTestId("audio-item").nth(1).click(); // Spanish
  await expect.poll(() => requested.slice(before).some((q) => q.includes("audio=1")), { timeout: 5000 }).toBe(true);
  await a.getByTestId("audio-btn").click();
  await expect(a.getByTestId("audio-item").nth(1)).toHaveAttribute("aria-checked", "true", { timeout: 5000 });

  // my choice is mine alone: Simra still has the default
  await b.getByTestId("audio-btn").click();
  await expect(b.getByTestId("audio-item").first()).toHaveAttribute("aria-checked", "true");

  // remembered on this device: a fresh visit asks for the Spanish track straight away
  const mark = requested.length;
  await a.reload();
  await a.locator("#name").fill("Yousuf");
  await expect(a.getByTestId("join")).toBeEnabled({ timeout: 15_000 });
  expect(requested.slice(mark).some((q) => q.includes("audio=1"))).toBe(true);
  await a.getByTestId("join").click();
  await a.getByTestId("audio-btn").click();
  await expect(a.getByTestId("audio-item").nth(1)).toHaveAttribute("aria-checked", "true");
  await ctxA.close();
});

