"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./Button";

export function JoinForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length === 8) router.push(`/room/${clean}`);
      }}
      className="flex w-full max-w-md flex-col gap-3 sm:flex-row"
    >
      <label className="sr-only" htmlFor="code">
        Room code
      </label>
      <input
        id="code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={12}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        placeholder="Got a code?"
        className="min-w-0 flex-1 rounded border border-line bg-surface px-4 py-3 font-display text-d3 uppercase tracking-[0.12em] text-text placeholder:font-sans placeholder:text-body placeholder:normal-case placeholder:tracking-normal placeholder:text-dim"
      />
      <Button type="submit" disabled={clean.length !== 8}>
        Take a seat <ArrowRight size={18} />
      </Button>
    </form>
  );
}
