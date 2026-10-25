import { ClockSync } from "../sync/clock";
import { driftAction, type DriftOptions } from "../sync/drift";
import {
  ECHO_GUARD_MS,
  type ClientMessage,
  type Command,
  type ReactionKind,
  type ServerMessage,
  type Timeline,
} from "../sync/protocol";
import { positionAt, promote } from "../sync/timeline";
import { useRoom } from "./store";

const TICK_MS = 250;
const DRIFT_EVERY_MS = 500;
const STALL_DEBOUNCE_MS = 700;
const USER_ACTION_HOLD_MS = 1500;
/** After a seek lands, give the picture this long to settle before judging drift or buffering. */
const SEEK_SETTLE_MS = 3000;
/** A seek that has not landed after this long counts as a real stall. */
const SEEK_GIVE_UP_MS = 12_000;
const MAX_SEEK_LEAD_S = 6;
const READY_BUFFER_S = 3;
/** Remuxed (HLS) pieces arrive unevenly, so recover with a bigger cushion before the room resumes. */
const READY_BUFFER_HLS_S = 6;
const FORCE_PLAY_EVERY_MS = 3000;
const RECONNECT_MS = 2000;
const RATE_LIMITED_RECONNECT_MS = 15_000;
const STATS_REPORT_MS = 20_000;

/**
 * Browser side of a room. The server owns the timeline; this class only follows it.
 * The <video> element is never the reference for anyone else.
 */
export class RoomEngine {
  private ws: WebSocket | null = null;
  private clock = new ClockSync();
  private video: HTMLVideoElement | null = null;
  private active: Timeline | null = null;
  private pending: Timeline | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private guardUntil = 0;
  private holdDriftUntil = 0;
  private lastSeekAt = 0;
  private lastDriftAt = 0;
  private lastUserCmdAt = 0;
  private lastForcePlayAt = 0;
  private buffering = false;
  private stalledSent = false;
  private dead = false;
  private detach: (() => void) | null = null;

  // Our own seeks. A remux seek can take several seconds to land, longer than the echo guard,
  // so the `seeked` event is matched against the target instead of a timer.
  private ownSeekTarget: number | null = null;
  private seekStartedAt = 0;
  private seekLatencyMs = 0;
  private counters = { nudges: 0, hardSeeks: 0, stalls: 0, reconnects: 0 };
  private lastReactionAt = 0;
  private lastStatsAt = 0;
  private sourceChangeUntil = 0;
  private path: "hls" | "direct" = "direct";
  /** Phones and tablets: a wider no-correction band and gentler nudges (constant rate changes can glitch audio). */
  private driftOptions: DriftOptions =
    typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches ? { ignore: 0.5, maxRate: 0.03 } : {};
  private nextReactionId = 0;

  constructor(
    private code: string,
    private name: string,
    private wsUrl: string,
  ) {}

  // ---- lifecycle -------------------------------------------------------------------------

  /** Live-remuxed (HLS) streams take seconds to seek; start from that estimate rather than learning it the hard way. */
  setSeekLatencyHint(ms: number): void {
    this.path = ms > 0 ? "hls" : "direct";
    if (!this.seekLatencyMs) this.seekLatencyMs = ms;
  }

  connect(): void {
    if (this.dead) return;
    // Keep showing the room while a dropped connection comes back; only the first connect is "connecting".
    if (useRoom.getState().conn === "idle") useRoom.getState().set({ conn: "connecting" });
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.ping();
      this.send({ t: "join", code: this.code, name: this.name });
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.dead || this.ws !== ws) return;
      const conn = useRoom.getState().conn;
      if (conn === "missing" || conn === "full") return;
      const wait = conn === "limited" ? RATE_LIMITED_RECONNECT_MS : RECONNECT_MS;
      this.counters.reconnects++;
      if (conn !== "limited") useRoom.getState().set({ conn: "closed" });
      setTimeout(() => !this.dead && this.connect(), wait);
    };
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  destroy(): void {
    this.dead = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.detach?.();
    this.ws?.close();
  }

  attachVideo(el: HTMLVideoElement | null): void {
    this.detach?.();
    this.detach = null;
    this.video = el;
    if (!el) return;
    const on = (target: EventTarget, type: string, fn: () => void) => {
      target.addEventListener(type, fn);
      return () => target.removeEventListener(type, fn);
    };
    const offs = [
      on(el, "play", () => this.onUserPlay()),
      on(el, "pause", () => this.onUserPause()),
      on(el, "seeked", () => this.onSeeked()),
      on(el, "waiting", () => this.onWaiting()),
      on(el, "playing", () => this.onResumed()),
      on(el, "canplay", () => this.onResumed()),
      on(document, "visibilitychange", () => this.onVisibility()),
    ];
    this.detach = () => offs.forEach((f) => f());
    if (this.active) this.applyActive();
  }

  // ---- outgoing --------------------------------------------------------------------------

  serverNow(): number {
    return this.clock.serverNow(Date.now());
  }

  command(cmd: Command): void {
    this.lastUserCmdAt = Date.now();
    this.send({ t: "cmd", cmd });
  }

  /** Play or pause for the whole room, from the room's latest known state (not this viewer's picture). */
  togglePlay(): void {
    const tl = this.pending ?? this.active;
    if (!tl) return;
    this.command({ kind: tl.playing ? "pause" : "play" });
  }

  /** Jump the whole room forwards or backwards, measured from where the room will be, so quick repeated presses add up. */
  skip(deltaSeconds: number): void {
    const tl = this.pending ?? this.active;
    if (!tl) return;
    const at = Math.max(this.serverNow(), tl.effectiveAt);
    this.seekTo(positionAt(tl, at) + deltaSeconds);
  }

  seekTo(seconds: number): void {
    const dur = this.video && Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
    this.command({ kind: "seek", position: Math.min(Math.max(0, seconds), Math.max(0, dur - 1)) });
  }

  react(kind: ReactionKind): void {
    const now = Date.now();
    if (now - this.lastReactionAt < 150) return;
    this.lastReactionAt = now;
    this.send({ t: "react", kind });
  }

  /** While playing, tell the server how this player is doing (logged there) so stutter can be diagnosed without a screenshot. */
  private reportStats(): void {
    const v = this.video;
    if (!v || !this.active?.playing || v.paused || Date.now() - this.lastStatsAt < STATS_REPORT_MS) return;
    this.lastStatsAt = Date.now();
    const ua = navigator.userAgent;
    const device = /iPhone|iPod/.test(ua) ? "iphone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ipad" : /Android/.test(ua) ? "android" : "desktop";
    this.send({ t: "stats", s: { ...this.getStats(), device, path: this.path } });
  }

  /** Where the room is right now. With `withLead`, aimed ahead by the measured seek time, for starting a fresh stream on the beat. */
  expectedPosition(withLead = false): number | null {
    const tl = this.active;
    if (!tl) return null;
    return positionAt(tl, this.serverNow()) + (withLead ? this.lead(tl) : 0);
  }

  /** This viewer is deliberately swapping their own stream (another audio track): the gap is not a stall and not drift. */
  noteSourceChange(ms = 20_000): void {
    this.sourceChangeUntil = Date.now() + ms;
    this.holdDriftUntil = Date.now() + ms;
    this.stalledSent = false;
    this.buffering = false;
    this.guard();
  }

  /** The new stream is ready: carry on with the room. The drift ladder fixes any small difference. */
  resync(): void {
    this.sourceChangeUntil = 0;
    this.holdDriftUntil = 0;
    this.guard();
    if (this.active?.playing) void this.video?.play().catch(() => {});
  }

  /** Numbers for the hidden stats readout (add ?stats=1 to the room address). */
  getStats(): Record<string, string | number> {
    const v = this.video;
    const tl = this.active;
    const expected = tl ? positionAt(tl, this.serverNow()) : 0;
    const q = v && "getVideoPlaybackQuality" in v ? v.getVideoPlaybackQuality() : null;
    return {
      drift: v && tl ? Number((v.currentTime - expected).toFixed(2)) : 0,
      rate: v ? Number(v.playbackRate.toFixed(3)) : 1,
      buffered: v ? Number(this.bufferedAhead(v).toFixed(1)) : 0,
      readyState: v?.readyState ?? 0,
      dropped: q ? `${q.droppedVideoFrames}/${q.totalVideoFrames}` : "n/a",
      seekMs: Math.round(this.seekLatencyMs),
      nudges: this.counters.nudges,
      hardSeeks: this.counters.hardSeeks,
      stalls: this.counters.stalls,
      reconnects: this.counters.reconnects,
      clockOffset: Math.round(this.clock.offset),
      playing: tl?.playing ? "yes" : "no",
    };
  }

  chat(text: string): void {
    this.send({ t: "chat", text });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping(): void {
    this.send({ t: "ping", clientTs: Date.now() });
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => !this.dead && this.ping(), this.clock.nextPingDelay());
  }

  // ---- incoming --------------------------------------------------------------------------

  private onMessage(msg: ServerMessage): void {
    const store = useRoom.getState();
    switch (msg.t) {
      case "pong":
        if (this.clock.addSample(msg.clientTs, msg.serverTs, Date.now())) store.set({ clockOffset: this.clock.offset });
        break;
      case "welcome":
        // Welcome carries server time too, which is a first offset estimate if pings have not landed.
        if (!this.clock.hasSync) this.clock.addSample(Date.now(), msg.serverTs, Date.now());
        this.active = msg.timeline;
        this.pending = null;
        this.stalledSent = false;
        store.set({
          conn: "open",
          selfId: msg.id,
          title: msg.title,
          members: msg.members,
          chat: msg.chat,
          timeline: msg.timeline,
          stall: msg.stall,
          clockOffset: this.clock.offset,
        });
        this.applyActive();
        break;
      case "timeline": {
        const have = Math.max(this.active?.version ?? 0, this.pending?.version ?? 0);
        // Late or out-of-order commands are dropped.
        if (msg.timeline.version <= have) {
          // Same timeline handed back (rejoin after a stall): the drift loop pulls us in.
          this.holdDriftUntil = 0;
          break;
        }
        this.pending = msg.timeline;
        this.holdDriftUntil = 0;
        this.tick();
        this.armPending();
        break;
      }
      case "members":
        store.set({ members: msg.members });
        break;
      case "chat":
        store.set({ chat: [...store.chat, msg.msg].slice(-300) });
        break;
      case "stall":
        store.set({ stall: msg.stall });
        break;
      case "react":
        useRoom.setState((s) => ({ reactions: [...s.reactions.slice(-39), { id: ++this.nextReactionId, kind: msg.kind, by: msg.by }] }));
        break;
      case "error":
        store.set({
          conn: msg.code === "NO_ROOM" ? "missing" : msg.code === "ROOM_FULL" ? "full" : msg.code === "RATE_LIMITED" ? "limited" : "closed",
        });
        break;
    }
  }

  // ---- applying the timeline -------------------------------------------------------------

  private guard(): void {
    this.guardUntil = Date.now() + ECHO_GUARD_MS;
  }

  private guarded(): boolean {
    return Date.now() < this.guardUntil;
  }

  private tick(): void {
    if (!this.active) return;
    const now = this.serverNow();
    const next = promote(this.active, this.pending, now);
    const changed = next.active !== this.active;
    this.active = next.active;
    this.pending = next.pending;
    if (changed) {
      useRoom.getState().set({ timeline: this.active });
      this.applyActive();
    }
    this.maybeReady();
    this.resumeIfStuckPaused(now);
    this.reportStats();
    if (Date.now() - this.lastDriftAt >= DRIFT_EVERY_MS) {
      this.lastDriftAt = Date.now();
      this.correctDrift(now);
    }
  }

  /** Fire at the scheduled time rather than on the next 250 ms tick; re-arm if the timer lands a hair early. */
  private armPending(): void {
    const pending = this.pending;
    if (!pending) return;
    setTimeout(() => {
      if (this.dead) return;
      this.tick();
      if (this.pending === pending) this.armPending();
    }, Math.max(1, pending.effectiveAt - this.serverNow() + 1));
  }

  private applyActive(): void {
    const v = this.video;
    const tl = this.active;
    if (!v || !tl) return;
    this.guard();
    const expected = positionAt(tl, this.serverNow());
    if (tl.playing) {
      if (Math.abs(v.currentTime - expected) > 0.3) this.seek(v, expected + this.lead(tl));
      if (v.playbackRate !== 1) v.playbackRate = 1;
      void v.play().catch(() => {
        /* needs a tap; the join step unlocks playback */
      });
    } else {
      v.pause();
      if (v.playbackRate !== 1) v.playbackRate = 1;
      if (Math.abs(v.currentTime - tl.anchorPos) > 0.05) this.seek(v, tl.anchorPos);
    }
  }

  /** How far ahead to aim when the picture is playing, so a slow seek lands on the beat instead of behind it. */
  private lead(tl: Timeline): number {
    if (!tl.playing) return 0;
    const s = this.seekLatencyMs / 1000;
    return s < 0.3 ? 0 : Math.min(MAX_SEEK_LEAD_S, s);
  }

  private seek(v: HTMLVideoElement, to: number): void {
    const target = Math.max(0, to);
    this.guard();
    this.lastSeekAt = Date.now();
    this.seekStartedAt = Date.now();
    this.ownSeekTarget = target;
    v.currentTime = target;
  }

  /** Drift ladder against the timeline's expected position. */
  private correctDrift(serverNow: number): void {
    const v = this.video;
    const tl = this.active;
    if (!v || !tl || v.seeking || Date.now() < this.holdDriftUntil) return;
    if (tl.playing && (v.paused || v.readyState < 3 || this.buffering)) return;
    const expected = positionAt(tl, serverNow);
    const act = driftAction(v.currentTime, expected, tl.playing, this.lastSeekAt, Date.now(), this.driftOptions);
    if (act.kind === "seek") {
      this.counters.hardSeeks++;
      this.seek(v, act.to + this.lead(tl));
    } else if (tl.playing && v.playbackRate !== act.rate) {
      // Only touch it when it changes: writing the same rate over and over can hiccup Safari.
      if (act.rate !== 1) this.counters.nudges++;
      v.playbackRate = act.rate;
    }
  }

  /**
   * The room is playing but this viewer's picture is paused and nothing explains it (an iPhone that
   * was locked, a pause swallowed while buffering): start it again instead of leaving them stuck.
   */
  private resumeIfStuckPaused(serverNow: number): void {
    const v = this.video;
    const tl = this.active;
    if (!v || !tl?.playing || !v.paused || v.ended) return;
    const nowMs = Date.now();
    if (this.guarded() || this.buffering || document.visibilityState !== "visible") return;
    if (serverNow < tl.effectiveAt || nowMs - this.lastUserCmdAt < USER_ACTION_HOLD_MS) return;
    if (nowMs - this.lastForcePlayAt < FORCE_PLAY_EVERY_MS) return;
    this.lastForcePlayAt = nowMs;
    this.applyActive();
  }

  // ---- the viewer's own actions ----------------------------------------------------------

  private onUserPlay(): void {
    if (this.guarded() || !this.active) return;
    if (this.active.playing) return;
    // Hold the picture until the scheduled start so everyone begins together.
    this.command({ kind: "play" });
    this.guard();
    this.video?.pause();
  }

  private onUserPause(): void {
    // The OS pauses video when a phone is locked or the tab is hidden; that is not a request to pause the room.
    if (this.guarded() || this.buffering || !this.active || document.visibilityState !== "visible") return;
    if (!this.active.playing) return;
    this.command({ kind: "pause" });
  }

  private onSeeked(): void {
    const v = this.video;
    if (!v) return;
    const nowMs = Date.now();
    // The cooldown and the settle window count from when a seek lands, not from when it was asked for.
    this.lastSeekAt = nowMs;

    if (this.ownSeekTarget !== null) {
      const ours = Math.abs(v.currentTime - this.ownSeekTarget) < 3 && nowMs - this.seekStartedAt < 30_000;
      if (ours) {
        const took = Math.min(8000, nowMs - this.seekStartedAt);
        this.seekLatencyMs = this.seekLatencyMs ? this.seekLatencyMs * 0.5 + took * 0.5 : took;
        this.ownSeekTarget = null;
        return;
      }
      this.ownSeekTarget = null; // the viewer moved it somewhere else while ours was in flight
    }

    if (this.guarded() || !this.active) return;
    // A seek that lands where the room already is changes nothing for anyone.
    if (Math.abs(v.currentTime - positionAt(this.active, this.serverNow())) < 0.75) return;
    this.holdDriftUntil = nowMs + USER_ACTION_HOLD_MS;
    this.command({ kind: "seek", position: v.currentTime });
  }

  private onVisibility(): void {
    if (document.visibilityState !== "visible" || !this.active) return;
    // Back from a locked screen or another tab: ask where the room is and catch up.
    this.send({ t: "sync" });
    this.holdDriftUntil = 0;
    this.applyActive();
  }

  private onWaiting(): void {
    if (!this.video || !this.active?.playing) return;
    this.buffering = true;
    this.armStallCheck(STALL_DEBOUNCE_MS);
  }

  private armStallCheck(delay: number): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.checkStall(), delay);
  }

  /** Short hiccups and our own seeks are not worth stopping the room for. */
  private checkStall(): void {
    const v = this.video;
    if (!v || !this.buffering || this.stalledSent || !this.active?.playing) return;
    if (Date.now() < this.sourceChangeUntil) return this.armStallCheck(500);
    const nowMs = Date.now();
    const seekBusy = (v.seeking && nowMs - this.seekStartedAt < SEEK_GIVE_UP_MS) || nowMs - this.lastSeekAt < SEEK_SETTLE_MS;
    if (seekBusy) return this.armStallCheck(400);
    if (v.readyState < 3) {
      this.stalledSent = true;
      this.counters.stalls++;
      this.send({ t: "stalled" });
    }
  }

  private onResumed(): void {
    this.buffering = false;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.maybeReady();
  }

  /** Enough picture buffered ahead to keep going, so the room does not resume only to stall again a second later. */
  private bufferedAhead(v: HTMLVideoElement): number {
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.1 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
    }
    return 0;
  }

  private maybeReady(): void {
    const v = this.video;
    if (!this.stalledSent || !v || v.readyState < 3) return;
    const want = this.path === "hls" ? READY_BUFFER_HLS_S : READY_BUFFER_S;
    const remaining = Number.isFinite(v.duration) ? Math.max(0, v.duration - v.currentTime) : want;
    const enough = v.readyState === 4 || this.bufferedAhead(v) >= Math.min(want, remaining);
    if (!enough) return;
    this.stalledSent = false;
    this.buffering = false;
    this.send({ t: "ready" });
  }
}
