import { Flame, Frown, Heart, Laugh, PartyPopper, ThumbsUp, type LucideIcon } from "lucide-react";
import type { ReactionKind } from "../lib/sync/protocol";

// Line icons rather than emoji: the design system has no emoji, and they look the same on every device.
export const REACTION_ICONS: Record<ReactionKind, { Icon: LucideIcon; label: string; className: string }> = {
  heart: { Icon: Heart, label: "Love", className: "text-danger" },
  laugh: { Icon: Laugh, label: "Haha", className: "text-text" },
  thumbsup: { Icon: ThumbsUp, label: "Like", className: "text-text" },
  fire: { Icon: Flame, label: "Fire", className: "text-text" },
  party: { Icon: PartyPopper, label: "Cheers", className: "text-text" },
  sad: { Icon: Frown, label: "Sad", className: "text-text" },
};
