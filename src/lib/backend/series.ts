import type { LibraryItem } from "./jellyfin";

export interface NextEpisode {
  id: string;
  /** What the room is called once it moves on, e.g. "Sterling Point: Pilot". */
  title: string;
  /** Short line for a button, e.g. "S1E3 · Pilot". */
  label: string;
}

const order = (a: LibraryItem, b: LibraryItem) =>
  (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title);

/** The playable episode that follows `id` in its show, or null for a movie or the last episode. */
export function nextInSeries(items: LibraryItem[], id: string): NextEpisode | null {
  const cur = items.find((i) => i.id === id);
  if (!cur?.seriesId) return null;
  const eps = items.filter((i) => i.seriesId === cur.seriesId).sort(order);
  const at = eps.findIndex((i) => i.id === id);
  const next = eps.slice(at + 1).find((i) => i.playable);
  if (!next) return null;
  return {
    id: next.id,
    title: next.seriesName ? `${next.seriesName}: ${next.title}` : next.title,
    label: `S${next.season ?? "?"}E${next.episode ?? "?"} · ${next.title}`,
  };
}
