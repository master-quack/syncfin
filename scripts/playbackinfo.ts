// Prints a markdown table of container / codecs / subtitles / bitrate / browser direct play for 5 typical titles.
// Usage: npm run playbackinfo   (needs JELLYFIN_TOKEN and JELLYFIN_USER_ID in .env)
import { playability } from "../src/lib/backend/jellyfin";

const base = (process.env.JELLYFIN_URL || "http://127.0.0.1:8096").replace(/\/$/, "");
const token = process.env.JELLYFIN_TOKEN ?? "";
const uid = process.env.JELLYFIN_USER_ID ?? "";
if (!token || !uid) {
  console.error("JELLYFIN_TOKEN and JELLYFIN_USER_ID are not set in .env, so there is nothing to query yet.");
  process.exit(2);
}

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `MediaBrowser Client="Y-S Movie Night", Device="QuackBox", DeviceId="ys-movie-night", Version="0.1", Token="${token}"` },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json() as Promise<any>;
};

// Jellyfin lists entries whose files are gone, so only sample files that exist on this machine.
import { existsSync } from "node:fs";
const all: any[] = [];
for (let start = 0; ; start += 500) {
  const page = await get(`/Users/${uid}/Items?IncludeItemTypes=Movie,Episode&Recursive=true&Fields=MediaSources,MediaStreams,Path&StartIndex=${start}&Limit=500`);
  all.push(...page.Items);
  if (page.Items.length < 500) break;
}
const root = (process.env.LIBRARY_ROOT ?? "").replace(/\/$/, "");
const present = all.filter((i) => i.Path && (!root || i.Path.startsWith(`${root}/`)) && existsSync(i.Path));
const pickRandom = (arr: any[], n: number) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
console.log(`(${all.length} listed, ${present.length} under the library folder and on disk; sampling from those)\n`);
const items: any[] = [...pickRandom(present.filter((i) => i.Type === "Movie"), 3), ...pickRandom(present.filter((i) => i.Type === "Episode"), 2)];

console.log("| Title | Container | Video | Audio | Subtitles | Bitrate | Browser direct play |");
console.log("|---|---|---|---|---|---|---|");
for (const it of items) {
  const src = it.MediaSources?.[0];
  const streams: any[] = src?.MediaStreams ?? [];
  const v = streams.find((s) => s.Type === "Video");
  const a = streams.find((s) => s.Type === "Audio" && s.IsDefault) ?? streams.find((s) => s.Type === "Audio");
  const subs = [...new Set(streams.filter((s) => s.Type === "Subtitle").map((s) => s.Codec))].join(", ") || "none";
  const { mode, reason } = playability(src);
  const mbps = src?.Bitrate ? (src.Bitrate / 1e6).toFixed(1) : "?";
  console.log(
    `| ${it.Name} | ${src?.Container ?? "?"} | ${v?.Codec ?? "?"} | ${a?.Codec ?? "?"} ${a?.Channels ? `${a.Channels}ch` : ""} | ${subs} | ${mbps} Mbit/s | ${reason ? `No: ${reason}` : mode === "remux" ? "Yes, via live remux" : "Yes"} |`,
  );
}
console.log("\nUpload budget is about 13.4 Mbit/s, so two remote viewers get about 6.7 Mbit/s each.");
