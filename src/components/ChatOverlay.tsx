"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MessageCircle, Pin, PinOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRoom } from "../lib/client/store";
import { Chat } from "./Chat";

const POPUP_MS = 6000;
const MAX_POPUPS = 4;
// Older popups recede: a little fainter and smaller for each message that has arrived since.
const RECEDE_OPACITY_STEP = 0.18;
const RECEDE_SCALE_STEP = 0.05;
const MIN_RECEDE_OPACITY = 0.35;
const MIN_RECEDE_SCALE = 0.85;
const ENTER_OFFSET = 14;
const SPRING = { type: "spring" as const, bounce: 0.1, duration: 0.25 };
const AUTO_CLOSE_MS = 8000;

interface Popup {
  id: number;
  name: string;
  text: string;
}

/**
 * Chat for fullscreen. New messages float up briefly over the picture; a small tab on the right edge slides the
 * chat over the video, and a pin keeps it there. Everything is an overlay: the video is never resized.
 */
export function ChatOverlay({
  visible,
  open,
  pinned,
  onOpenChange,
  onPinnedChange,
  onSend,
}: {
  /** Whether the controls are showing; the edge tab hides with them unless something needs attention. */
  visible: boolean;
  open: boolean;
  pinned: boolean;
  onOpenChange: (open: boolean) => void;
  onPinnedChange: (pinned: boolean) => void;
  onSend: (text: string) => void;
}) {
  const chat = useRoom((s) => s.chat);
  const members = useRoom((s) => s.members);
  const selfId = useRoom((s) => s.selfId);
  const me = members.find((m) => m.id === selfId)?.name;
  const [popups, setPopups] = useState<Popup[]>([]);
  const [unread, setUnread] = useState(0);
  const seen = useRef(chat.length ? chat[chat.length - 1].id : 0);
  const closeTimer = useRef<number>();
  const reduceMotion = useReducedMotion();

  // New messages from others: pop up (panel closed) or just mark seen (panel open).
  useEffect(() => {
    const fresh = chat.filter((m) => m.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    const others = fresh.filter((m) => m.name !== me);
    if (others.length === 0 || open) return;
    setUnread((n) => n + others.length);
    setPopups((p) => [...p, ...others.map((m) => ({ id: m.id, name: m.name, text: m.text }))].slice(-MAX_POPUPS));
    for (const m of others) setTimeout(() => setPopups((p) => p.filter((x) => x.id !== m.id)), POPUP_MS);
  }, [chat, me, open]);

  useEffect(() => {
    if (open) {
      setUnread(0);
      setPopups([]);
    }
  }, [open]);

  // An unpinned panel tucks itself away when nobody is using it.
  const keepAlive = () => {
    window.clearTimeout(closeTimer.current);
    if (open && !pinned) closeTimer.current = window.setTimeout(() => onOpenChange(false), AUTO_CLOSE_MS);
  };
  useEffect(() => {
    keepAlive();
    return () => window.clearTimeout(closeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pinned]);

  return (
    <>
      {/* new-message popups: only while the chat panel is closed; opening it clears them */}
      <ul className="pointer-events-none absolute bottom-28 left-3 z-20 flex w-[min(320px,70%)] flex-col gap-2 pl-[env(safe-area-inset-left)]" aria-live="polite">
        <AnimatePresence mode="popLayout">
          {!open &&
            popups.map((p, i) => {
              const age = popups.length - 1 - i; // 0 = newest, at the bottom
              const opacity = Math.max(MIN_RECEDE_OPACITY, 1 - age * RECEDE_OPACITY_STEP);
              const scale = Math.max(MIN_RECEDE_SCALE, 1 - age * RECEDE_SCALE_STEP);
              return (
                <motion.li
                  key={p.id}
                  layout={!reduceMotion}
                  data-testid="chat-popup"
                  className="list-none break-words rounded border border-line bg-bg/75 px-3 py-2 text-small text-text"
                  style={{ transformOrigin: "left bottom" }}
                  initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.95, y: ENTER_OFFSET }}
                  animate={reduceMotion ? { opacity: 1, scale: 1, y: 0 } : { opacity, scale, y: 0 }}
                  exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9 }}
                  transition={reduceMotion ? { duration: 0 } : SPRING}
                >
                  <span className="font-semibold text-muted">{p.name}</span> {p.text}
                </motion.li>
              );
            })}
        </AnimatePresence>
      </ul>

      {/* edge tab */}
      <AnimatePresence>
        {!open && (visible || unread > 0) && (
          <motion.button
            key="tab"
            type="button"
            data-testid="chat-tab"
            aria-label={unread > 0 ? `Open chat, ${unread} new` : "Open chat"}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            onClick={() => onOpenChange(true)}
            className="absolute right-0 top-1/2 z-30 flex h-14 w-11 -translate-y-1/2 items-center justify-center rounded-l border border-r-0 border-line bg-bg/75 text-text hover:bg-raised"
          >
            <MessageCircle size={22} />
            {unread > 0 && (
              <span className="absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-text px-1 text-small font-semibold text-bg">{unread}</span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* slide-over panel: overlays the picture, and stops above the control bar so those buttons stay reachable */}
      <AnimatePresence>
        {open && (
          <motion.aside
            key="panel"
            data-testid="chat-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.2 }}
            onPointerDown={keepAlive}
            onKeyDown={keepAlive}
            className="absolute right-0 top-0 bottom-[calc(6.75rem+env(safe-area-inset-bottom))] z-30 flex w-[min(340px,85vw)] flex-col border-b border-l border-line bg-bg/80 pr-[env(safe-area-inset-right)]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="font-display text-d3 leading-none">Chat</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="chat-pin"
                  aria-pressed={pinned}
                  aria-label={pinned ? "Unpin chat" : "Keep chat open"}
                  onClick={() => onPinnedChange(!pinned)}
                  className={`flex h-10 w-10 items-center justify-center rounded hover:bg-raised ${pinned ? "bg-raised text-text" : "text-muted"}`}
                >
                  {pinned ? <PinOff size={20} /> : <Pin size={20} />}
                </button>
                <button type="button" aria-label="Close chat" onClick={() => onOpenChange(false)} className="flex h-10 w-10 items-center justify-center rounded text-muted hover:bg-raised">
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <Chat onSend={onSend} overlay />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
