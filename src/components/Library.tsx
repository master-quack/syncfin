"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Film, Search } from "lucide-react";
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
  seriesId?: string;
  seriesName?: string;
  season?: number | null;
  episode?: number | null;
}

interface Show {
  id: string;
  name: string;
  episodes: Item[];
  seasons: number[];
}

type Entry = { kind: "movie"; key: string; sort: string; item: Item } | { kind: "show"; key: string; sort: string; show: Show };

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
  const [openShow, setOpenShow] = useState<string | null>(null);
  const [seasonOf, setSeasonOf] = useState<Record<string, number>>({});

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

  // Movies stand alone; every episode of a show folds into one entry that opens up to show its seasons.
  const shown = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const movies: Entry[] = [];
    const shows = new Map<string, Item[]>();
    for (const i of items ?? []) {
      if (!showAll && !i.playable) continue;
      if (i.seriesId) {
        const list = shows.get(i.seriesId) ?? [];
        list.push(i);
        shows.set(i.seriesId, list);
      } else if (!q || `${i.title} ${i.subtitle}`.toLowerCase().includes(q)) {
        movies.push({ kind: "movie", key: i.id, sort: i.title.toLowerCase(), item: i });
      }
    }
    const out: Entry[] = [...movies];
    for (const [id, eps] of shows) {
      const name = eps[0].seriesName || "Untitled show";
      // A search that names the show keeps every episode; one that names an episode keeps just those.
      const byName = !q || name.toLowerCase().includes(q);
      const kept = byName ? eps : eps.filter((e) => `${e.title} ${e.subtitle}`.toLowerCase().includes(q));
      if (kept.length === 0) continue;
      kept.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
      const seasons = [...new Set(kept.map((e) => e.season ?? 0))];
      out.push({ kind: "show", key: id, sort: name.toLowerCase(), show: { id, name, episodes: kept, seasons } });
    }
    return out.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
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
      {!items && !error && (
        // Same grid and card shapes as the real library, so the page does not jump when it fills in.
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading the library" data-testid="library-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex gap-4 rounded bg-surface p-3 motion-safe:animate-pulse" aria-hidden="true">
              <div className="h-24 w-16 shrink-0 rounded-sm bg-raised" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="h-7 w-3/4 rounded-sm bg-raised" />
                <div className="h-4 w-1/2 rounded-sm bg-raised" />
                <div className="mt-auto h-10 w-28 rounded bg-raised" />
              </div>
            </li>
          ))}
        </ul>
      )}
      {items && shown.length === 0 && <p className="text-body text-muted">Nothing by that name.</p>}

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <AnimatePresence>
          {shown.slice(0, limit).map((entry, i) => {
            const item = entry.kind === "movie" ? entry.item : null;
            const show = entry.kind === "show" ? entry.show : null;
            const expanded = !!show && openShow === show.id;
            const season = show ? (seasonOf[show.id] !== undefined && show.seasons.includes(seasonOf[show.id]) ? seasonOf[show.id] : show.seasons[0]) : 0;
            const poster = item ? (item.hasPoster ? item.id : null) : show!.id;
            return (
              <motion.li
                key={entry.key}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 8) * 0.03, duration: 0.25 }}
                className={`flex flex-col gap-3 rounded bg-surface p-3 ${item && !item.playable ? "opacity-60" : ""} ${expanded ? "sm:col-span-2 lg:col-span-3" : ""}`}
                data-testid={show ? "library-show" : "library-item"}
                data-playable={item ? item.playable : true}
              >
                <div className="flex gap-4">
                  <div className="flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-raised">
                    {poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/poster/${poster}`}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={(e) => (e.currentTarget.style.display = "none")}
                      />
                    ) : (
                      <Film size={28} className="text-dim" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h2 className="font-display text-d3 leading-none">{item ? item.title : show!.name}</h2>
                    {item ? (
                      <>
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
                      </>
                    ) : (
                      <>
                        <p className="text-small text-muted">
                          {show!.seasons.length} {show!.seasons.length === 1 ? "season" : "seasons"} · {show!.episodes.length}{" "}
                          {show!.episodes.length === 1 ? "episode" : "episodes"}
                        </p>
                        <Button
                          variant="ghost"
                          className="mt-auto self-start px-4 py-2"
                          aria-expanded={expanded}
                          data-testid="show-toggle"
                          onClick={() => setOpenShow(expanded ? null : show!.id)}
                        >
                          {expanded ? "Close" : "Browse"}
                          <ChevronDown size={18} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {show && expanded && (
                  <div className="flex flex-col gap-3 border-t border-line pt-3" data-testid="show-panel">
                    {show.seasons.length > 1 && (
                      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Season">
                        {show.seasons.map((n) => (
                          <button
                            key={n}
                            type="button"
                            role="tab"
                            aria-selected={n === season}
                            data-testid="season-tab"
                            onClick={() => setSeasonOf((m) => ({ ...m, [show.id]: n }))}
                            className={`min-h-11 rounded border px-4 text-small ${n === season ? "border-text bg-raised text-text" : "border-line text-muted hover:bg-raised"}`}
                          >
                            {n === 0 ? "Specials" : `Season ${n}`}
                          </button>
                        ))}
                      </div>
                    )}
                    <ul className="flex flex-col gap-2">
                      {show.episodes
                        .filter((e) => (e.season ?? 0) === season)
                        .map((ep) => (
                          <li key={ep.id} className={`flex flex-wrap items-center gap-3 rounded bg-raised px-3 py-2 ${ep.playable ? "" : "opacity-60"}`} data-testid="episode-row">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body">
                                {ep.episode !== null && ep.episode !== undefined ? `${ep.episode}. ` : ""}
                                {ep.title}
                              </span>
                              <span className="block text-small text-muted">
                                {[ep.runtimeMin ? `${ep.runtimeMin} min` : "", ep.playable && ep.mode === "remux" ? "Repackaged live" : "", ep.reason ?? ""].filter(Boolean).join(" · ")}
                              </span>
                            </span>
                            {ep.playable && (
                              <Button className="px-4 py-2" onClick={() => open(ep)} disabled={opening !== null}>
                                {opening === ep.id ? "Opening" : "Open a room"}
                              </Button>
                            )}
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </motion.li>
            );
          })}
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
