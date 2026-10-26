import {
  LIMITS,
  REACTION_MIN_GAP_MS,
  STALL_WAIT_MS,
  type ChatMessage,
  type Command,
  type Member,
  type ReactionKind,
  type ServerMessage,
  type StallInfo,
  type Timeline,
} from "../src/lib/sync/protocol";
import { applyCommand, initialTimeline, positionAt } from "../src/lib/sync/timeline";
import type { RoomRow, Store } from "./db";

/** An empty room keeps its place for this long (so a dropped connection can come straight back), then pauses. */
export const EMPTY_GRACE_MS = 30_000;

export interface Peer {
  id: string;
  name: string;
  send(msg: ServerMessage): void;
}

/**
 * One watch room. The server holds the timeline; no viewer's video element is ever the reference.
 * Anyone can play, pause or seek. Rooms outlive their creator.
 */
export class Room {
  readonly peers = new Map<string, Peer>();
  timeline: Timeline;
  private stalled = new Set<string>();
  private stall: { deadline: number; resumeAfter: boolean } | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReaction = new Map<string, number>();
  private stallStartedAt = 0;
  /** The room's audio language, set by the host; each viewer's own stream follows it. */
  audioLang: string | null = null;

  constructor(
    readonly row: RoomRow,
    private store: Store,
    private now: () => number = Date.now,
    private log: (message: string) => void = () => {},
  ) {
    // Reopening a code resumes the movie at the last position, paused.
    this.timeline = initialTimeline(row.itemId, row.position, this.now());
  }

  get members(): Member[] {
    return [...this.peers.values()].map((p, i) => ({ id: p.id, name: p.name, host: i === 0 }));
  }

  get stallInfo(): StallInfo | null {
    if (!this.stall) return null;
    return { names: this.stalledNames(), deadline: this.stall.deadline };
  }

  join(peer: Peer): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.peers.set(peer.id, peer);
    peer.send({
      t: "welcome",
      id: peer.id,
      serverTs: this.now(),
      title: this.row.title,
      timeline: this.timeline,
      members: this.members,
      chat: this.store.getChat(this.row.code),
      stall: this.stallInfo,
      audioLang: this.audioLang,
    });
    this.broadcast({ t: "members", members: this.members }, peer.id);
    this.store.touch(this.row.code, null, this.now());
  }

  leave(id: string): void {
    const gone = this.peers.get(id);
    if (!gone) return;
    this.peers.delete(id);
    this.lastReaction.delete(id);
    this.dropStalled(id);
    if (this.peers.size === 0) {
      this.clearStall();
      this.persist();
      // Nobody is watching: after a short grace period stop the clock so the film is where they left it.
      this.emptyTimer = setTimeout(() => this.pauseIfEmpty(), EMPTY_GRACE_MS);
      return;
    }
    this.broadcast({ t: "members", members: this.members });
  }

  command(from: string, cmd: Command): void {
    const peer = this.peers.get(from);
    if (!peer) return;
    // A manual play or pause while the room is waiting on someone overrides the wait. A seek does not:
    // the room still waits for the buffering viewer and then resumes from the new position.
    if (this.stall && (cmd.kind === "play" || cmd.kind === "pause")) {
      this.clearStall();
    }
    const next = applyCommand(this.timeline, cmd, this.now());
    if (next === this.timeline) {
      peer.send({ t: "timeline", timeline: this.timeline, by: peer.name });
      return;
    }
    this.timeline = next;
    this.persist();
    this.broadcast({ t: "timeline", timeline: next, by: peer.name, act: cmd });
  }

  /** A viewer's player is waiting for data. Pause everyone and wait up to 10 s. */
  markStalled(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    const at = this.now();
    if (!this.stall) {
      if (!this.timeline.playing) return; // nothing to hold
      this.stall = { deadline: at + STALL_WAIT_MS, resumeAfter: true };
      this.stallStartedAt = at;
      this.log(`stall ${this.row.code.slice(0, 3)}… started by ${JSON.stringify(peer.name)} at ${Math.round(positionAt(this.timeline, at))}s`);
      this.stallTimer = setTimeout(() => this.giveUp(), STALL_WAIT_MS);
      this.pauseFor("stall");
    }
    this.stalled.add(id);
    this.broadcast({ t: "stall", stall: this.stallInfo });
  }

  /** The stalled viewer recovered. */
  markReady(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (!this.stalled.has(id)) {
      // Rejoining after the room moved on: hand them the current timeline.
      peer.send({ t: "timeline", timeline: this.timeline, by: peer.name });
      return;
    }
    this.stalled.delete(id);
    if (this.stalled.size > 0) {
      this.broadcast({ t: "stall", stall: this.stallInfo });
      return;
    }
    this.log(`stall ${this.row.code.slice(0, 3)}… recovered after ${((this.now() - this.stallStartedAt) / 1000).toFixed(1)}s`);
    this.finishStall(true);
  }

  chat(from: string, text: string): ChatMessage | null {
    const peer = this.peers.get(from);
    const clean = text.trim().slice(0, LIMITS.MAX_CHAT);
    if (!peer || !clean) return null;
    const msg = this.store.addChat(this.row.code, peer.name, clean, this.now());
    this.broadcast({ t: "chat", msg });
    return msg;
  }

  /** A short-lived reaction shown to everyone, the sender included. Not stored. Spam is dropped quietly. */
  react(from: string, kind: ReactionKind): void {
    const peer = this.peers.get(from);
    if (!peer) return;
    const at = this.now();
    if (at - (this.lastReaction.get(from) ?? 0) < REACTION_MIN_GAP_MS) return;
    this.lastReaction.set(from, at);
    this.broadcast({ t: "react", kind, by: peer.name });
  }

  /** The host picks the language for everyone. Anyone else is ignored quietly. */
  setAudio(from: string, lang: string): void {
    const peer = this.peers.get(from);
    if (!peer || this.members.find((m) => m.id === from)?.host !== true) return;
    if (!/^[\w-]{1,12}$/.test(lang)) return;
    this.audioLang = lang;
    this.broadcast({ t: "audio", lang, by: peer.name });
  }

  /**
   * Move the whole room to another title, paused at the start. `from` is the title the caller saw, so two people
   * pressing "next episode" together move the room once, not twice.
   */
  setItem(itemId: string, title: string, from: string): boolean {
    if (this.row.itemId !== from || itemId === from) return false;
    const at = this.now();
    this.clearStall();
    this.row.itemId = itemId;
    this.row.title = title;
    this.store.setItem(this.row.code, itemId, title, at);
    this.timeline = { ...initialTimeline(itemId, 0, at), version: this.timeline.version + 1 };
    this.broadcast({ t: "item", itemId, title, timeline: this.timeline });
    return true;
  }

  sync(id: string): void {
    this.peers.get(id)?.send({ t: "timeline", timeline: this.timeline, by: "" });
  }

  persist(): void {
    this.store.touch(this.row.code, positionAt(this.timeline, this.now()), this.now());
  }

  dispose(): void {
    this.clearStall();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  private pauseIfEmpty(): void {
    this.emptyTimer = null;
    if (this.peers.size > 0) return;
    const next = applyCommand(this.timeline, { kind: "pause" }, this.now());
    if (next === this.timeline) return;
    this.timeline = next;
    this.persist();
  }

  private giveUp(): void {
    // The room continues without them; they rejoin by syncing to the timeline when ready.
    this.log(`stall ${this.row.code.slice(0, 3)}… gave up after ${STALL_WAIT_MS / 1000}s waiting for ${this.stalledNames().map((n) => JSON.stringify(n)).join(", ")}`);
    this.stalled.clear();
    this.finishStall(true);
  }

  private finishStall(resume: boolean): void {
    const shouldResume = resume && this.stall?.resumeAfter;
    this.clearStall();
    if (shouldResume) {
      const next = applyCommand(this.timeline, { kind: "play" }, this.now());
      if (next !== this.timeline) {
        this.timeline = next;
        this.broadcast({ t: "timeline", timeline: next, by: "" });
      }
    }
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const had = this.stall !== null;
    this.stall = null;
    this.stalled.clear();
    if (had) this.broadcast({ t: "stall", stall: null });
  }

  private dropStalled(id: string): void {
    if (!this.stalled.delete(id)) return;
    if (this.stalled.size === 0 && this.stall) this.finishStall(true);
    else if (this.stall) this.broadcast({ t: "stall", stall: this.stallInfo });
  }

  private pauseFor(by: string): void {
    const next = applyCommand(this.timeline, { kind: "pause" }, this.now());
    if (next === this.timeline) return;
    this.timeline = next;
    this.persist();
    this.broadcast({ t: "timeline", timeline: next, by });
  }

  private stalledNames(): string[] {
    return [...this.stalled].map((id) => this.peers.get(id)?.name).filter((n): n is string => !!n);
  }

  private broadcast(msg: ServerMessage, except?: string): void {
    for (const p of this.peers.values()) if (p.id !== except) p.send(msg);
  }
}
