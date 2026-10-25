// Ported in spirit from OpenWatchParty (MIT, see NOTICE): limits, scheduling delays, message names.

export const LIMITS = {
  MAX_CLIENTS: 20,
  RATE_PER_SEC: 30,
  MAX_MSG_BYTES: 64 * 1024,
  MAX_CHAT: 500,
  MAX_NAME: 24,
} as const;

export const SCHEDULE = {
  PLAY_MS: 1000,
  PAUSE_MS: 300,
  SEEK_MS: 300,
} as const;

export const STALL_WAIT_MS = 10_000;
export const ECHO_GUARD_MS = 2000;
export const BACK_SECONDS = 15;
export const SKIP_SECONDS = 15;

/** Reactions are fixed, so a client cannot make the others render anything it likes. */
export const REACTIONS = ["heart", "laugh", "thumbsup", "fire", "party", "sad"] as const;
export type ReactionKind = (typeof REACTIONS)[number];
export const REACTION_MIN_GAP_MS = 150;

/** Playback numbers a viewer's player may report to the server log (to diagnose stutter on a real device). Nothing else is accepted. */
export const STATS_KEYS = ["drift", "rate", "buffered", "readyState", "dropped", "seekMs", "nudges", "hardSeeks", "stalls", "reconnects", "clockOffset", "playing", "device", "path"] as const;

// 32 characters, no 0/O/1/I look-alikes.
export const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 8;

export interface Timeline {
  version: number;
  itemId: string;
  /** Position in seconds at anchorAt. */
  anchorPos: number;
  /** Server time (ms) at which anchorPos is true. */
  anchorAt: number;
  playing: boolean;
  /** Server time (ms) at which this timeline takes over from the previous one. */
  effectiveAt: number;
}

export interface Member {
  id: string;
  name: string;
}

export interface ChatMessage {
  id: number;
  name: string;
  text: string;
  ts: number;
}

export type Command =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; position: number }
  | { kind: "back"; seconds: number };

export interface StallInfo {
  names: string[];
  /** Server time (ms) when the room gives up waiting. */
  deadline: number;
}

export type ClientMessage =
  | { t: "join"; code: string; name: string }
  | { t: "ping"; clientTs: number }
  | { t: "cmd"; cmd: Command }
  | { t: "stalled" }
  | { t: "ready" }
  | { t: "chat"; text: string }
  | { t: "react"; kind: ReactionKind }
  | { t: "stats"; s: Record<string, string | number> }
  | { t: "sync" };

export type ServerMessage =
  | {
      t: "welcome";
      id: string;
      serverTs: number;
      title: string;
      timeline: Timeline;
      members: Member[];
      chat: ChatMessage[];
      stall: StallInfo | null;
    }
  | { t: "pong"; clientTs: number; serverTs: number }
  | { t: "timeline"; timeline: Timeline; by: string }
  | { t: "members"; members: Member[] }
  | { t: "chat"; msg: ChatMessage }
  | { t: "react"; kind: ReactionKind; by: string }
  | { t: "stall"; stall: StallInfo | null }
  | { t: "error"; code: string; message: string };
