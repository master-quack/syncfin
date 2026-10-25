"use client";

import { motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** The room code as a ticket: big letters on a surface strip, a dotted tear line, accent on the code only. */
export function Ticket({ code, animate = true }: { code: string; animate?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked; the code is on screen anyway */
    }
  };

  return (
    <motion.div
      initial={animate ? { y: 12, opacity: 0, rotate: -1 } : false}
      animate={{ y: 0, opacity: 1, rotate: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="relative flex w-full max-w-md items-stretch rounded bg-surface"
      aria-label={`Room code ${code.split("").join(" ")}`}
    >
      <div className="flex-1 px-4 py-3">
        <p className="text-small text-muted">Room code</p>
        <p className="font-display text-d1 leading-none tracking-[0.08em] text-accent" data-testid="room-code">
          {code}
        </p>
      </div>
      <div className="relative flex items-center border-l-2 border-dotted border-line px-3">
        <span className="absolute -left-[9px] -top-[9px] h-4 w-4 rounded-full bg-bg" aria-hidden />
        <span className="absolute -bottom-[9px] -left-[9px] h-4 w-4 rounded-full bg-bg" aria-hidden />
        <button
          onClick={copy}
          className="flex items-center gap-2 rounded px-2 py-2 text-small text-text hover:bg-raised"
          aria-label="Copy room code"
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </motion.div>
  );
}
