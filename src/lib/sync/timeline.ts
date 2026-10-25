import { SCHEDULE, type Command, type Timeline } from "./protocol";

/** Where the shared timeline says the video should be at a given server time. */
export function positionAt(tl: Timeline, serverNow: number): number {
  if (!tl.playing) return tl.anchorPos;
  return tl.anchorPos + Math.max(0, serverNow - tl.anchorAt) / 1000;
}

export function initialTimeline(itemId: string, position: number, now: number): Timeline {
  return { version: 1, itemId, anchorPos: Math.max(0, position), anchorAt: now, playing: false, effectiveAt: now };
}

/**
 * Apply a command from any member. Returns the same object when nothing changes
 * (so the caller can skip a broadcast), otherwise a new timeline with version + 1.
 */
export function applyCommand(tl: Timeline, cmd: Command, now: number): Timeline {
  switch (cmd.kind) {
    case "play": {
      if (tl.playing) return tl;
      const at = now + SCHEDULE.PLAY_MS;
      return { ...tl, version: tl.version + 1, anchorAt: at, effectiveAt: at, playing: true };
    }
    case "pause": {
      if (!tl.playing) return tl;
      const at = now + SCHEDULE.PAUSE_MS;
      return { ...tl, version: tl.version + 1, anchorPos: positionAt(tl, at), anchorAt: at, effectiveAt: at, playing: false };
    }
    case "seek":
      return seekTo(tl, cmd.position, now);
    case "back": {
      const at = now + SCHEDULE.SEEK_MS;
      return seekTo(tl, positionAt(tl, at) - cmd.seconds, now);
    }
  }
}

function seekTo(tl: Timeline, position: number, now: number): Timeline {
  const at = now + SCHEDULE.SEEK_MS;
  const target = Number.isFinite(position) ? Math.max(0, position) : 0;
  return { ...tl, version: tl.version + 1, anchorPos: target, anchorAt: at, effectiveAt: at };
}

/** Late or out-of-order timelines are dropped. */
export function shouldAccept(currentVersion: number, incomingVersion: number): boolean {
  return incomingVersion > currentVersion;
}

/**
 * The client holds the active timeline and at most one pending (scheduled) one.
 * Promote the pending timeline once its effective time has arrived.
 */
export function promote(
  active: Timeline,
  pending: Timeline | null,
  serverNow: number,
): { active: Timeline; pending: Timeline | null } {
  if (pending && pending.version > active.version && serverNow >= pending.effectiveAt) {
    return { active: pending, pending: null };
  }
  return { active, pending };
}
