"use client";

import { motion } from "framer-motion";
import { useRoom, type ReactionEvent } from "../lib/client/store";
import { REACTION_ICONS } from "./reactions";

function Floating({ r }: { r: ReactionEvent }) {
  const { Icon, className } = REACTION_ICONS[r.kind];
  // Spread them along the right edge without needing randomness (so it renders the same on server and client).
  const lane = (r.id * 37) % 22;
  const sway = ((r.id * 53) % 40) - 20;
  const rise = 220 + ((r.id * 29) % 120);
  return (
    <motion.div
      data-testid="reaction"
      data-kind={r.kind}
      className="absolute bottom-24 flex flex-col items-center"
      style={{ right: `${3 + lane}%` }}
      initial={{ y: 0, x: 0, opacity: 0, scale: 0.6 }}
      animate={{ y: -rise, x: sway, opacity: [0, 1, 1, 0], scale: [0.6, 1.15, 1, 1] }}
      transition={{ duration: 3, ease: "easeOut", times: [0, 0.1, 0.7, 1] }}
      onAnimationComplete={() => useRoom.setState((s) => ({ reactions: s.reactions.filter((x) => x.id !== r.id) }))}
    >
      <Icon size={40} strokeWidth={1.75} className={className} fill={r.kind === "heart" ? "currentColor" : "none"} />
      <span className="mt-1 rounded-sm bg-bg/70 px-2 text-small text-text">{r.by}</span>
    </motion.div>
  );
}

/** Reactions float up over the picture, in the page and in fullscreen alike, and never catch a tap. */
export function ReactionLayer() {
  const reactions = useRoom((s) => s.reactions);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {reactions.map((r) => (
        <Floating key={r.id} r={r} />
      ))}
    </div>
  );
}
