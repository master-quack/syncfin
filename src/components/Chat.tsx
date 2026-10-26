"use client";

import { motion } from "framer-motion";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LIMITS } from "../lib/sync/protocol";
import { useRoom } from "../lib/client/store";

export function Chat({ onSend, overlay = false }: { onSend: (text: string) => void; overlay?: boolean }) {
  const chat = useRoom((s) => s.chat);
  const members = useRoom((s) => s.members);
  const selfId = useRoom((s) => s.selfId);
  const me = members.find((m) => m.id === selfId)?.name;
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll the chat box itself: scrollIntoView would drag the whole page (and the video) with it on a phone.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.length]);

  return (
    <div className={`flex h-full min-h-0 flex-col ${overlay ? "" : "rounded bg-surface"}`}>
      <div ref={log} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite" data-testid="chat-log">
        {chat.length === 0 && <p className="text-small text-muted">Quiet so far. Say something before the trailers do.</p>}
        {chat.map((m) => (
          <motion.p
            key={`${m.note ? "n" : "c"}${m.id}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="break-words text-small"
            data-testid={m.note ? "chat-note" : undefined}
          >
            {m.note ? (
              <span className="italic text-dim">
                {m.name} {m.text}
              </span>
            ) : (
              <>
                <span className={m.name === me ? "font-semibold text-text" : "font-semibold text-muted"}>{m.name}</span>{" "}
                <span className="text-text">{m.text}</span>
              </>
            )}
          </motion.p>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onSend(text);
          setText("");
        }}
      >
        <label htmlFor="chat" className="sr-only">
          Message
        </label>
        <input
          id="chat"
          value={text}
          maxLength={LIMITS.MAX_CHAT}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message"
          autoComplete="off"
          className={`min-w-0 flex-1 rounded border border-line px-3 py-2 text-small text-text placeholder:text-dim ${overlay ? "bg-bg/70" : "bg-bg"}`}
        />
        <button type="submit" aria-label="Send" className="rounded bg-text px-3 text-bg hover:bg-muted">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
