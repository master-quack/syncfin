"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Film, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./Button";

interface Item {
  id: string;
  title: string;
  subtitle: string;
  kind: string;
  runtimeMin: number;
  bitrateMbps: number | null;
  playable: boolean;
  mode: "direct" | "remux" | null;
  reason: string | null;
  hasPoster: boolean;
}

// Two remote viewers share about 13.4 Mbit/s of upload.
const HEAVY_MBPS = 6.5;
const PAGE_SIZE = 60;

export function Library() {
  const router = useRouter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    fetch("/api/library")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Could not load the library.");
        setItems(body.items);
        setMock(!!body.mock);
      })
      .catch((e) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => (showAll || i.playable) && (!q || `${i.title} ${i.subtitle}`.toLowerCase().includes(q)));
  }, [items, query, showAll]);
  const playableCount = (items ?? []).filter((i) => i.playable).length;

  const open = async (item: Item) => {
    setOpening(item.id);
    setError("");
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: item.id }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (res?.status === 401) return router.refresh();
    if (!res?.ok) {
      setOpening(null);
      return setError(body?.error ?? "Could not open a room.");
    }
    router.push(`/room/${body.code}`);
  };

  return (
    <section className="flex flex-col gap-6 pt-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-d2 leading-none">Pick something.</h1>
        <p className="text-body text-muted">Argue about it later. Choosing opens a room and gives you a code to send.</p>
      </div>

      {mock && (
        <p className="rounded border border-line px-4 py-3 text-small text-muted">
          Jellyfin is not connected yet, so this is the pretend library. Everything here is a test card.
        </p>
      )}

      <div className="relative max-w-md">
        <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
        <label htmlFor="q" className="sr-only">
          Search the library
        </label>
        <input
          id="q"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); }}
          placeholder="Search"
          className="w-full rounded border border-line bg-surface py-3 pl-10 pr-4 text-body text-text placeholder:text-dim"
        />
      </div>

      {items && (
        <label className="flex items-center gap-2 text-small text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); setLimit(PAGE_SIZE); }} />
          Show greyed-out titles too ({playableCount} playable of {items.length})
        </label>
      )}

      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {!items && !error && <p className="text-body text-muted">Fetching the shelves.</p>}
      {items && shown.length === 0 && <p className="text-body text-muted">Nothing by that name.</p>}

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <AnimatePresence>
          {shown.slice(0, limit).map((item, i) => (
            <motion.li
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 8) * 0.03, duration: 0.25 }}
              className={`flex gap-4 rounded bg-surface p-3 ${item.playable ? "" : "opacity-60"}`}
              data-testid="library-item"
              data-playable={item.playable}
            >
              <div className="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-raised">
                {item.hasPoster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/poster/${item.id}`} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <Film size={28} className="text-dim" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h2 className="font-display text-d3 leading-none">{item.title}</h2>
                <p className="text-small text-muted">
                  {[item.subtitle, item.runtimeMin ? `${item.runtimeMin} min` : ""].filter(Boolean).join(" · ")}
                </p>
                {item.playable && item.bitrateMbps !== null && item.bitrateMbps > HEAVY_MBPS && (
                  <p className="text-small text-dim">Heavy file ({item.bitrateMbps} Mbit/s). May buffer for remote viewers.</p>
                )}
                {item.playable && item.mode === "remux" && <p className="text-small text-dim">Repackaged live. Seeks may take a moment.</p>}
                {item.reason && <p className="text-small text-dim">{item.reason}</p>}
                {item.playable && (
                  <Button className="mt-auto self-start px-4 py-2" onClick={() => open(item)} disabled={opening !== null}>
                    {opening === item.id ? "Opening" : "Open a room"}
                  </Button>
                )}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {shown.length > limit && (
        <Button variant="ghost" className="self-start" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
          Show more ({shown.length - limit} left)
        </Button>
      )}
    </section>
  );
}
