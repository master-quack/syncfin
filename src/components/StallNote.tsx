"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useRoom } from "../lib/client/store";

function who(names: string[]): string {
  if (names.length === 0) return "Someone is";
  if (names.length === 1) return `${names[0]} is`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are`;
}

export function StallNote() {
  const stall = useRoom((s) => s.stall);
  const offset = useRoom((s) => s.clockOffset);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!stall) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [stall]);

  const left = stall ? Math.max(0, Math.ceil((stall.deadline - (Date.now() + offset)) / 1000)) : 0;

  return (
    <AnimatePresence>
      {stall && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            role="status"
            data-testid="stall-note"
            className="max-w-full rounded border border-line bg-bg/85 px-4 py-2 text-center text-body"
          >
            {who(stall.names)} buffering. Continuing in {left}.
          </motion.p>
        </div>
      )}
    </AnimatePresence>
  );
}
