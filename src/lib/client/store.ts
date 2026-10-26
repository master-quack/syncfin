import { create } from "zustand";
import type { ChatMessage, Member, ReactionKind, StallInfo, Timeline } from "../sync/protocol";

export interface ReactionEvent {
  id: number;
  kind: ReactionKind;
  by: string;
}

export type Conn = "idle" | "connecting" | "open" | "closed" | "missing" | "full" | "limited";

interface RoomState {
  conn: Conn;
  selfId: string;
  title: string;
  members: Member[];
  chat: ChatMessage[];
  timeline: Timeline | null;
  stall: StallInfo | null;
  /** Audio language the host chose for the room, if any. */
  audioLang: string | null;
  /** Reactions currently floating over the picture; each removes itself when its animation ends. */
  reactions: ReactionEvent[];
  /** server time ≈ Date.now() + clockOffset */
  clockOffset: number;
  set: (patch: Partial<Omit<RoomState, "set">>) => void;
}

export const useRoom = create<RoomState>((set) => ({
  conn: "idle",
  selfId: "",
  title: "",
  members: [],
  chat: [],
  timeline: null,
  stall: null,
  audioLang: null,
  reactions: [],
  clockOffset: 0,
  set: (patch) => set(patch),
}));
