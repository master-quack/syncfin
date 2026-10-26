import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockSync } from "../src/lib/sync/clock";
import { driftAction } from "../src/lib/sync/drift";
import { ROOM_ALPHABET, STALL_WAIT_MS, type ServerMessage } from "../src/lib/sync/protocol";
import { applyCommand, initialTimeline, positionAt, promote, shouldAccept } from "../src/lib/sync/timeline";
import { Store, generateCode, RETENTION_MS } from "../server/db";
import { audioTracks } from "../src/lib/backend/jellyfin";
import { EMPTY_GRACE_MS, Room, type Peer } from "../server/room";
import { MOCK_ITEMS } from "../src/lib/backend/mock";
import { nextInSeries } from "../src/lib/backend/series";

describe("timeline maths", () => {
  const t0 = 1_000_000;
  const tl = initialTimeline("item", 100, t0);

  it("holds position while paused", () => {
    expect(positionAt(tl, t0 + 60_000)).toBe(100);
  });

  it("play is scheduled 1000 ms ahead and does not advance before then", () => {
    const p = applyCommand(tl, { kind: "play" }, t0);
    expect(p.playing).toBe(true);
    expect(p.effectiveAt).toBe(t0 + 1000);
    expect(positionAt(p, t0 + 500)).toBe(100);
    expect(positionAt(p, t0 + 3000)).toBeCloseTo(102);
  });

  it("pause is scheduled 300 ms ahead and freezes where the video will be then", () => {
    const p = applyCommand(tl, { kind: "play" }, t0);
    const s = applyCommand(p, { kind: "pause" }, t0 + 5000);
    expect(s.playing).toBe(false);
    expect(s.effectiveAt).toBe(t0 + 5300);
    expect(s.anchorPos).toBeCloseTo(100 + (5300 - 1000) / 1000);
  });

  it("seek keeps the playing state and clamps below zero", () => {
    const p = applyCommand(tl, { kind: "play" }, t0);
    const s = applyCommand(p, { kind: "seek", position: -5 }, t0 + 2000);
    expect(s.playing).toBe(true);
    expect(s.anchorPos).toBe(0);
    expect(s.effectiveAt).toBe(t0 + 2300);
  });

  it("back 15 s steps back from the position at execution time", () => {
    const p = applyCommand(tl, { kind: "play" }, t0);
    const s = applyCommand(p, { kind: "back", seconds: 15 }, t0 + 31_000);
    expect(s.anchorPos).toBeCloseTo(100 + (31_300 - 1000) / 1000 - 15);
  });

  it("returns the same object when a command changes nothing", () => {
    expect(applyCommand(tl, { kind: "pause" }, t0)).toBe(tl);
    const p = applyCommand(tl, { kind: "play" }, t0);
    expect(applyCommand(p, { kind: "play" }, t0 + 10)).toBe(p);
  });

  it("increments the version monotonically", () => {
    let cur = tl;
    for (let i = 0; i < 5; i++) {
      const next = applyCommand(cur, { kind: "seek", position: i }, t0 + i * 1000);
      expect(next.version).toBe(cur.version + 1);
      cur = next;
    }
  });
});

describe("command ordering", () => {
  it("drops late and duplicate versions", () => {
    expect(shouldAccept(5, 6)).toBe(true);
    expect(shouldAccept(5, 5)).toBe(false);
    expect(shouldAccept(5, 3)).toBe(false);
  });

  it("promotes a pending timeline only once its time arrives", () => {
    const a = initialTimeline("i", 0, 0);
    const b = applyCommand(a, { kind: "play" }, 0);
    expect(promote(a, b, 500).active).toBe(a);
    expect(promote(a, b, 1000).active).toBe(b);
    expect(promote(b, a, 5000).active).toBe(b); // stale pending ignored
  });
});

describe("clock sync", () => {
  it("computes offset = server + rtt/2 - now", () => {
    const c = new ClockSync();
    // client sends at 1000, server stamps 5050, client receives at 1100 => rtt 100, offset 5050+50-1100
    c.addSample(1000, 5050, 1100);
    expect(c.offset).toBe(4000);
    expect(c.serverNow(2000)).toBe(6000);
  });

  it("trusts the lowest-RTT sample over a noisy one", () => {
    const c = new ClockSync();
    c.addSample(0, 4050, 100); // rtt 100, offset 4000
    c.addSample(1000, 5900, 1800); // rtt 800, offset 4500 (noisy)
    expect(c.offset).toBe(4000);
  });

  it("keeps only the last 8 samples", () => {
    const c = new ClockSync();
    c.addSample(0, 4010, 20); // rtt 20, offset 4000: best sample, will be evicted
    for (let i = 0; i < 8; i++) c.addSample(i * 1000, i * 1000 + 5100, i * 1000 + 200); // rtt 200, offset 5000
    for (let i = 0; i < 20; i++) c.addSample(0, 5100, 200);
    expect(c.offset).toBeGreaterThan(4900);
  });

  it("rejects absurd samples and slows pings once stable", () => {
    const c = new ClockSync();
    expect(c.addSample(0, 0, 10_000)).toBe(false);
    expect(c.addSample(100, 0, 50)).toBe(false);
    expect(c.nextPingDelay()).toBe(2000);
    for (let i = 0; i < 6; i++) c.addSample(i, i + 1005, i + 10);
    expect(c.nextPingDelay()).toBe(30_000);
  });

  it("returns to fast pings when the offset jumps", () => {
    const c = new ClockSync();
    for (let i = 0; i < 6; i++) c.addSample(i, i + 1005, i + 10);
    expect(c.nextPingDelay()).toBe(30_000);
    for (let i = 0; i < 8; i++) c.addSample(0, 3005, 10);
    expect(c.nextPingDelay()).toBe(2000);
  });
});

describe("drift ladder", () => {
  it("ignores drift under 0.3 s", () => {
    expect(driftAction(10.2, 10, true, 0, 10_000)).toEqual({ kind: "none", rate: 1 });
    expect(driftAction(9.8, 10, true, 0, 10_000)).toEqual({ kind: "none", rate: 1 });
  });

  it("nudges between 0.3 and 2 s, capped at ±5%", () => {
    const behind = driftAction(9, 10, true, 0, 10_000);
    expect(behind.kind).toBe("nudge");
    expect((behind as { rate: number }).rate).toBeGreaterThan(1);
    expect((behind as { rate: number }).rate).toBeLessThanOrEqual(1.05);
    const ahead = driftAction(11.9, 10, true, 0, 10_000) as { rate: number };
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(0.95);
  });

  it("hard seeks past 2 s", () => {
    expect(driftAction(5, 10, true, 0, 10_000)).toEqual({ kind: "seek", to: 10 });
  });

  it("touch devices ignore up to 0.5 s and nudge by at most 3%", () => {
    const touch = { ignore: 0.5, maxRate: 0.03 };
    expect(driftAction(10.4, 10, true, 0, 10_000, touch)).toEqual({ kind: "none", rate: 1 });
    expect(driftAction(10.4, 10, true, 0, 10_000).kind).toBe("nudge"); // the default band still corrects it
    const behind = driftAction(8.5, 10, true, 0, 10_000, touch) as { rate: number };
    expect(behind.rate).toBeCloseTo(1.03);
  });

  it("does not thrash: a second seek inside the cooldown becomes a capped nudge", () => {
    const a = driftAction(5, 10, true, 9_000, 10_000) as { kind: string; rate: number };
    expect(a.kind).toBe("nudge");
    expect(a.rate).toBeCloseTo(1.05);
  });
});

describe("room codes", () => {
  it("uses 32 distinct look-alike-free characters", () => {
    expect(ROOM_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_ALPHABET).size).toBe(32);
    expect(ROOM_ALPHABET).not.toMatch(/[01OI]/);
  });
  it("generates 8-character codes from the alphabet", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(new RegExp(`^[${ROOM_ALPHABET}]{8}$`));
  });
});

describe("persistence", () => {
  it("restores chat and last position, and deletes rooms after 3 days", () => {
    const s = new Store(":memory:");
    const t = 1_000_000;
    const room = s.createRoom("movie1", "A Movie", t);
    s.addChat(room.code, "Yousuf", "hi", t + 1);
    s.touch(room.code, 321.5, t + 2);
    expect(s.getRoom(room.code, t + 3)?.position).toBe(321.5);
    expect(s.getChat(room.code).map((m) => m.text)).toEqual(["hi"]);
    expect(s.cleanup(t + RETENTION_MS - 1000)).toBe(0);
    expect(s.cleanup(t + RETENTION_MS + 1000)).toBe(1);
    expect(s.getRoom(room.code, t + RETENTION_MS + 1000)).toBeNull();
    expect(s.getChat(room.code)).toEqual([]);
  });
});

describe("stall policy", () => {
  let store: Store;
  let clock: number;
  let room: Room;
  let inbox: Record<string, ServerMessage[]>;

  const peer = (id: string, name: string): Peer => {
    inbox[id] = [];
    return { id, name, send: (m) => inbox[id].push(m) };
  };
  const last = (id: string, t: ServerMessage["t"]) => [...inbox[id]].reverse().find((m) => m.t === t);

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    store = new Store(":memory:");
    inbox = {};
    room = new Room(store.createRoom("m", "Movie", clock), store, () => clock);
    room.join(peer("a", "Yousuf"));
    room.join(peer("b", "Simra"));
    room.command("a", { kind: "play" });
    clock += 5000;
  });
  afterEach(() => {
    room.dispose();
    vi.useRealTimers();
  });

  it("pauses everyone, names the buffering viewer, and resumes together when they recover", () => {
    room.markStalled("b");
    const stall = last("a", "stall") as Extract<ServerMessage, { t: "stall" }>;
    expect(stall.stall?.names).toEqual(["Simra"]);
    expect(stall.stall?.deadline).toBe(clock + STALL_WAIT_MS);
    expect(room.timeline.playing).toBe(false);

    clock += 4000;
    room.markReady("b");
    expect((last("a", "stall") as Extract<ServerMessage, { t: "stall" }>).stall).toBeNull();
    expect(room.timeline.playing).toBe(true);
    expect(room.timeline.effectiveAt).toBe(clock + 1000);
  });

  it("continues without them after 10 s", () => {
    room.markStalled("b");
    clock += STALL_WAIT_MS;
    vi.advanceTimersByTime(STALL_WAIT_MS);
    expect(room.timeline.playing).toBe(true);
    expect((last("a", "stall") as Extract<ServerMessage, { t: "stall" }>).stall).toBeNull();
    // late recovery just hands the viewer the current timeline
    room.markReady("b");
    expect(last("b", "timeline")).toBeTruthy();
  });

  it("does not resume if someone pauses during the wait", () => {
    room.markStalled("b");
    room.command("a", { kind: "pause" });
    room.markReady("b");
    expect(room.timeline.playing).toBe(false);
  });

  it("waits for every stalled viewer", () => {
    room.join(peer("c", "Guest"));
    room.markStalled("b");
    room.markStalled("c");
    room.markReady("b");
    expect(room.timeline.playing).toBe(false);
    room.markReady("c");
    expect(room.timeline.playing).toBe(true);
  });

  it("any member can control, and the room survives the creator leaving", () => {
    room.leave("a");
    room.command("b", { kind: "seek", position: 50 });
    expect(room.timeline.anchorPos).toBe(50);
    expect(room.peers.size).toBe(1);
  });

  it("a seek during a stall keeps the wait and still resumes afterwards", () => {
    room.markStalled("b");
    room.command("a", { kind: "seek", position: 300 });
    expect(room.timeline.playing).toBe(false);
    expect(room.stallInfo).not.toBeNull();
    clock += 2000;
    room.markReady("b");
    expect(room.stallInfo).toBeNull();
    expect(room.timeline.playing).toBe(true);
    expect(room.timeline.anchorPos).toBe(300);
  });

  it("an explicit play during a stall plays at once and ends the wait", () => {
    room.markStalled("b");
    room.command("a", { kind: "play" });
    expect(room.stallInfo).toBeNull();
    expect(room.timeline.playing).toBe(true);
  });

  it("an empty room pauses after the grace period, but not if someone comes back in time", () => {
    room.leave("a");
    room.leave("b");
    clock += EMPTY_GRACE_MS - 1000;
    room.join(peer("c", "Back"));
    vi.advanceTimersByTime(EMPTY_GRACE_MS + 1000);
    expect(room.timeline.playing).toBe(true); // someone returned: it never paused
    room.leave("c");
    clock += EMPTY_GRACE_MS;
    vi.advanceTimersByTime(EMPTY_GRACE_MS);
    expect(room.timeline.playing).toBe(false);
    expect(store.getRoom(room.row.code, clock)!.position).toBeGreaterThan(0);
  });

  it("reactions reach everyone including the sender, and spam inside 150 ms is dropped", () => {
    room.react("a", "heart");
    expect(last("a", "react")).toMatchObject({ kind: "heart", by: "Yousuf" });
    expect(last("b", "react")).toMatchObject({ kind: "heart", by: "Yousuf" });
    const before = inbox["b"].length;
    clock += 50;
    room.react("a", "fire");
    expect(inbox["b"].length).toBe(before); // too soon
    clock += 200;
    room.react("a", "fire");
    expect(last("b", "react")).toMatchObject({ kind: "fire" });
    room.react("nobody", "heart"); // not in the room: ignored
  });

  it("lets only the host pick the audio language, and tells new joiners", () => {
    room.setAudio("b", "ita"); // Simra is not the host: ignored
    expect(room.audioLang).toBeNull();
    room.setAudio("a", "../x"); // not a language code: ignored
    expect(room.audioLang).toBeNull();
    room.setAudio("a", "ita");
    expect(room.audioLang).toBe("ita");
    expect(last("b", "audio")).toMatchObject({ lang: "ita", by: "Yousuf" });
    room.join(peer("c", "Late"));
    expect(last("c", "welcome")).toMatchObject({ audioLang: "ita" });
    room.leave("a"); // the next-longest viewer becomes host
    expect(room.members.find((m) => m.id === "b")?.host).toBe(true);
    room.setAudio("b", "eng");
    expect(room.audioLang).toBe("eng");
  });

  it("moves the whole room to the next episode once, back at the start and paused", () => {
    expect(room.setItem("ep2", "Show: Two", "wrong")).toBe(false); // the caller was looking at a different episode
    expect(room.setItem("ep2", "Show: Two", "m")).toBe(true);
    expect(room.setItem("ep3", "Show: Three", "m")).toBe(false); // a second press at the same moment is ignored
    expect(room.row.title).toBe("Show: Two");
    const msg = last("b", "item") as Extract<ServerMessage, { t: "item" }>;
    expect(msg).toMatchObject({ itemId: "ep2", title: "Show: Two" });
    expect(msg.timeline).toMatchObject({ itemId: "ep2", anchorPos: 0, playing: false });
    expect(msg.timeline.version).toBeGreaterThan(room.timeline.version - 1);
    expect(store.getRoom(room.row.code, clock)?.itemId).toBe("ep2");
    room.join(peer("c", "Late"));
    expect(last("c", "welcome")).toMatchObject({ title: "Show: Two" });
  });

  it("logs when a stall starts, and how it ended", () => {
    const lines: string[] = [];
    const r2 = new Room(store.createRoom("m2", "Movie 2", clock), store, () => clock, (m) => lines.push(m));
    const send = () => {};
    r2.join({ id: "x", name: "Yousuf", send });
    r2.join({ id: "y", name: "Simra", send });
    r2.command("x", { kind: "play" });
    clock += 5000;
    r2.markStalled("y");
    expect(lines.some((l) => /started by "Simra"/.test(l))).toBe(true);
    clock += 4000;
    r2.markReady("y");
    expect(lines.some((l) => /recovered after 4\.0s/.test(l))).toBe(true);
    r2.markStalled("y");
    clock += STALL_WAIT_MS;
    vi.advanceTimersByTime(STALL_WAIT_MS);
    expect(lines.some((l) => /gave up after 10s waiting for "Simra"/.test(l))).toBe(true);
    r2.dispose();
  });
});

describe("audio track list", () => {
  const src = {
    Id: "x",
    MediaStreams: [
      { Type: "Video", Codec: "hevc", Index: 0 },
      { Type: "Audio", Codec: "eac3", Index: 1, Language: "ita", Channels: 6, DisplayTitle: "Italian - Dolby Digital+ - 5.1 - Default" },
      { Type: "Audio", Codec: "eac3", Index: 2, Language: "eng", Channels: 6 },
      { Type: "Audio", Codec: "aac", Index: 3, Language: "eng", Channels: 2, DisplayTitle: "English - Commentary" },
      { Type: "Subtitle", Codec: "subrip", Index: 4 },
    ],
  };

  it("lists only audio tracks, with plain-words labels", () => {
    process.env.ALLOW_AUDIO_CONVERT = "false";
    const t = audioTracks(src);
    expect(t.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(t[0].label).toBe("Italian · Dolby Digital+ 5.1");
    expect(t[1].label).toBe("English · Dolby Digital+ 5.1");
    expect(t[2].label).toBe("English (commentary) · AAC stereo");
  });

  it("marks tracks that would need converting as unplayable unless conversion is on", () => {
    process.env.ALLOW_AUDIO_CONVERT = "false";
    expect(audioTracks(src).map((x) => x.playable)).toEqual([false, false, true]);
    process.env.ALLOW_AUDIO_CONVERT = "true";
    expect(audioTracks(src).map((x) => x.playable)).toEqual([true, true, true]);
    delete process.env.ALLOW_AUDIO_CONVERT;
  });

  it("handles a file with no audio or an unknown language", () => {
    expect(audioTracks(undefined)).toEqual([]);
    expect(audioTracks({ Id: "y", MediaStreams: [{ Type: "Audio", Codec: "aac", Index: 0, Language: "und", Channels: 2 }] })[0].label).toBe("Unknown language · AAC stereo");
  });
});


describe("next episode", () => {
  it("follows season and episode order, skips what cannot play, and stops at the end", () => {
    expect(nextInSeries(MOCK_ITEMS, "mock-ep-1")).toMatchObject({ id: "mock-ep-2", label: "S1E2 · The Second One" });
    expect(nextInSeries(MOCK_ITEMS, "mock-ep-2")).toMatchObject({ id: "mock-ep-3", title: "Test Show: Season Two Opens" });
    expect(nextInSeries(MOCK_ITEMS, "mock-ep-3")).toBeNull();
    expect(nextInSeries(MOCK_ITEMS, "mock-1")).toBeNull(); // a movie
    const greyed = MOCK_ITEMS.map((i) => (i.id === "mock-ep-2" ? { ...i, playable: false } : i));
    expect(nextInSeries(greyed, "mock-ep-1")?.id).toBe("mock-ep-3");
  });
});
