import { existsSync } from "node:fs";

// Server-only. The Jellyfin token never reaches client code; the browser only gets the stream URL
// for a room's item, after joining the room.

export interface LibraryItem {
  id: string;
  title: string;
  subtitle: string;
  kind: string;
  runtimeMin: number;
  bitrateMbps: number | null;
  playable: boolean;
  /** direct = the file plays as is; remux = Jellyfin repackages it live without re-encoding the video. */
  mode: "direct" | "remux" | null;
  reason: string | null;
  hasPoster: boolean;
}

const list = (v: string | undefined, fallback: string) =>
  (v?.trim() || fallback).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const containers = () => list(process.env.DIRECT_PLAY_CONTAINERS, "mp4,m4v,mov,webm");
const videoCodecs = () => list(process.env.DIRECT_PLAY_VIDEO, "h264,hevc");
const audioCodecs = () => list(process.env.DIRECT_PLAY_AUDIO, "aac,mp3,opus,vorbis,flac");
const IMAGE_SUBS = new Set(["pgssub", "pgs", "hdmv_pgs_subtitle", "dvdsub", "dvd_subtitle", "dvbsub", "dvb_subtitle", "xsub"]);

export const jellyfinConfigured = () => !!(process.env.JELLYFIN_TOKEN && process.env.JELLYFIN_USER_ID);

const internalBase = () => (process.env.JELLYFIN_URL || "http://127.0.0.1:8096").replace(/\/$/, "");
const publicBase = () => (process.env.JELLYFIN_PUBLIC_URL || process.env.JELLYFIN_URL || "http://127.0.0.1:8096").replace(/\/$/, "");
const token = () => process.env.JELLYFIN_TOKEN ?? "";
const userId = () => process.env.JELLYFIN_USER_ID ?? "";

async function jf(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${internalBase()}${path}`, {
    ...init,
    headers: {
      "X-Emby-Token": token(),
      Authorization: `MediaBrowser Client="Y-S Movie Night", Device="QuackBox", DeviceId="ys-movie-night", Version="0.1", Token="${token()}"`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
}

interface JfStream {
  Type: string;
  Codec?: string;
  Index?: number;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsForced?: boolean;
  IsTextSubtitleStream?: boolean;
  Profile?: string;
  Level?: number;
  BitDepth?: number;
  Width?: number;
  Height?: number;
  Channels?: number;
  BitRate?: number;
  RealFrameRate?: number;
  AverageFrameRate?: number;
}

/** What the picture is, so a browser can check it can decode it before anyone presses play. */
export interface VideoInfo {
  codec: string;
  profile: string;
  level: number;
  bitDepth: number;
  width: number;
  height: number;
  fps: number;
  /** bits per second */
  bitrate: number;
}

export function videoInfo(src: JfSource | undefined): VideoInfo | null {
  const v = (src?.MediaStreams ?? []).find((m) => m.Type === "Video" && m.Codec !== "mjpeg" && m.Codec !== "png");
  if (!v) return null;
  return {
    codec: (v.Codec ?? "").toLowerCase(),
    profile: v.Profile ?? "",
    level: v.Level ?? 0,
    bitDepth: v.BitDepth ?? 8,
    width: v.Width ?? 0,
    height: v.Height ?? 0,
    fps: Math.round((v.RealFrameRate ?? v.AverageFrameRate ?? 24) * 100) / 100,
    bitrate: v.BitRate ?? src?.Bitrate ?? 0,
  };
}

/** A text subtitle track a viewer can switch on. Picture subtitles (PGS and friends) cannot be shown by a browser. */
export interface SubtitleTrack {
  index: number;
  /** ISO 639-2 code from the file, e.g. "eng"; empty when unknown. */
  lang: string;
  /** Plain-words label for the picker, e.g. "English (hearing impaired)". */
  label: string;
}

let languageNames: Intl.DisplayNames | null = null;
function languageName(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    const name = code ? languageNames.of(code) : undefined;
    return name && name !== code ? name : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function subtitleTracks(src: JfSource | undefined): SubtitleTrack[] {
  const subs = (src?.MediaStreams ?? []).filter((m) => m.Type === "Subtitle" && m.IsTextSubtitleStream && typeof m.Index === "number");
  const seen = new Map<string, number>();
  return subs.map((m) => {
    const lang = (m.Language ?? "").toLowerCase();
    const title = m.DisplayTitle ?? "";
    let label = lang && lang !== "und" ? languageName(lang) : "Unknown language";
    if (/hearing impaired|sdh|\bcc\b/i.test(title)) label += " (hearing impaired)";
    if (m.IsForced || /forced/i.test(title)) label += " (forced)";
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return { index: m.Index as number, lang: lang === "und" ? "" : lang, label: n > 1 ? `${label} ${n}` : label };
  });
}

/** An audio track a viewer can switch to. Switching asks Jellyfin for a new stream with that track. */
export interface AudioTrack {
  index: number;
  lang: string;
  /** Plain-words label for the picker, e.g. "English · Dolby Digital+ 5.1". */
  label: string;
  /** False when this app is not allowed to play it (its format would need converting and conversion is off). */
  playable: boolean;
}

const AUDIO_NAMES: Record<string, string> = { aac: "AAC", ac3: "Dolby Digital", eac3: "Dolby Digital+", dts: "DTS", truehd: "Dolby TrueHD", flac: "FLAC", opus: "Opus", mp3: "MP3", vorbis: "Vorbis" };
const channelName = (n?: number) => (n === 1 ? "mono" : n === 2 ? "stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : n ? `${n} channels` : "");

export function audioTracks(src: JfSource | undefined): AudioTrack[] {
  const audio = (src?.MediaStreams ?? []).filter((m) => m.Type === "Audio" && typeof m.Index === "number");
  return audio.map((m) => {
    const lang = (m.Language ?? "").toLowerCase();
    const codec = (m.Codec ?? "").toLowerCase();
    const who = lang && lang !== "und" ? languageName(lang) : "Unknown language";
    const extra = /commentary/i.test(m.DisplayTitle ?? "") ? " (commentary)" : "";
    const how = [AUDIO_NAMES[codec] ?? codec.toUpperCase(), channelName(m.Channels)].filter(Boolean).join(" ");
    return { index: m.Index as number, lang: lang === "und" ? "" : lang, label: `${who}${extra} · ${how}`, playable: audioCodecs().includes(codec) || audioConvertEnabled() };
  });
}

const sourceIds = new Map<string, { id: string; at: number }>();

/** The media source whose subtitle tracks the app lists (the item's first one), cached briefly. */
async function mediaSourceIdFor(itemId: string): Promise<string | null> {
  const hit = sourceIds.get(itemId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
  const res = await jf(`/Users/${userId()}/Items/${encodeURIComponent(itemId)}`);
  if (!res.ok) return null;
  const id = ((await res.json()) as { MediaSources?: { Id: string }[] }).MediaSources?.[0]?.Id;
  if (!id) return null;
  sourceIds.set(itemId, { id, at: Date.now() });
  return id;
}

const vttCache = new Map<string, { at: number; text: string }>();
const vttInflight = new Map<string, Promise<string | null>>();
const VTT_TTL_MS = 60 * 60_000;
const VTT_CACHE_MAX = 40;

/**
 * One subtitle track as WebVTT. Fetched here with the app's own credentials and served to the browser by our
 * server: Jellyfin sends no CORS header on subtitles, and this keeps the token out of the page.
 *
 * Jellyfin has to extract an embedded track from the video file the first time (20 to 30 s for an MKV on a hard
 * disk), so results are cached and simultaneous requests for the same track share one extraction.
 */
export function fetchSubtitleVtt(itemId: string, index: number): Promise<string | null> {
  const key = `${itemId}:${index}`;
  const hit = vttCache.get(key);
  if (hit && Date.now() - hit.at < VTT_TTL_MS) return Promise.resolve(hit.text);
  const running = vttInflight.get(key);
  if (running) return running;

  const job = (async () => {
    const sourceId = await mediaSourceIdFor(itemId);
    if (!sourceId) return null;
    const res = await jf(`/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(sourceId)}/Subtitles/${index}/0/Stream.vtt`, {
      headers: { Accept: "text/vtt" },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.startsWith("WEBVTT") || text.length > 2_000_000) return null;
    if (vttCache.size >= VTT_CACHE_MAX) vttCache.delete(vttCache.keys().next().value as string);
    vttCache.set(key, { at: Date.now(), text });
    return text;
  })()
    .catch(() => null)
    .finally(() => vttInflight.delete(key));
  vttInflight.set(key, job);
  return job;
}

/** Start extracting the most likely subtitle (English) in the background so it is ready when someone asks for it. */
export function warmSubtitles(itemId: string, tracks: SubtitleTrack[]): void {
  const pick = tracks.find((t) => t.lang === "eng" && !/hearing|forced/i.test(t.label)) ?? tracks.find((t) => t.lang === "eng");
  if (pick) void fetchSubtitleVtt(itemId, pick.index);
}
interface JfSource {
  Id: string;
  Container?: string;
  Bitrate?: number;
  MediaStreams?: JfStream[];
  SupportsDirectPlay?: boolean;
  ETag?: string;
  Path?: string;
  DefaultAudioStreamIndex?: number;
}

const remuxEnabled = () => (process.env.ALLOW_REMUX ?? "true").toLowerCase() !== "false";
const audioConvertEnabled = () => (process.env.ALLOW_AUDIO_CONVERT ?? "false").toLowerCase() === "true";

/**
 * How a title can reach a browser without re-encoding its video.
 * direct: the file plays as is. remux: only the container differs (MKV), so Jellyfin repackages it live.
 * Text subtitles are declared as externally handled so Jellyfin never burns them in (burning forces a video
 * re-encode); titles whose default subtitles are pictures are refused for the same reason.
 */
export function playability(src: JfSource | undefined): { mode: "direct" | "remux" | null; reason: string | null } {
  if (!src) return { mode: null, reason: "Jellyfin has no playable file for this one." };
  const container = (src.Container ?? "").split(",")[0].toLowerCase();
  const streams = src.MediaStreams ?? [];
  const video = streams.find((s) => s.Type === "Video" && !(s as any).IsExternal && (s as any).Codec !== "mjpeg" && (s as any).Codec !== "png");
  if (video && !videoCodecs().includes((video.Codec ?? "").toLowerCase())) {
    return { mode: null, reason: `The video is ${(video.Codec ?? "unknown").toUpperCase()}, which not every browser can play directly.` };
  }
  const sub = streams.find((s) => s.Type === "Subtitle" && s.IsDefault);
  if (sub && (IMAGE_SUBS.has((sub.Codec ?? "").toLowerCase()) || sub.IsTextSubtitleStream === false)) {
    return { mode: null, reason: "The default subtitles are pictures, not text, and would need to be burned into the video." };
  }
  const audio = streams.find((s) => s.Type === "Audio" && s.IsDefault) ?? streams.find((s) => s.Type === "Audio");
  if (audio && !audioCodecs().includes((audio.Codec ?? "").toLowerCase()) && !audioConvertEnabled()) {
    return { mode: null, reason: `The sound is ${(audio.Codec ?? "unknown").toUpperCase()}, which browsers cannot play without converting it.` };
  }
  if (!containers().includes(container)) {
    if (remuxEnabled()) return { mode: "remux", reason: null };
    return { mode: null, reason: `The file is ${container ? container.toUpperCase() : "an unknown format"}, which browsers cannot play without converting it.` };
  }
  return { mode: "direct", reason: null };
}

const PAGE = 500;
const MAX_ITEMS = 50_000;
const CACHE_MS = 60_000;
let cache: { at: number; items: LibraryItem[] } | null = null;

/** Whole library, cached for a minute so the page does not hammer Jellyfin. */
export async function getLibrary(): Promise<LibraryItem[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = await fetchLibrary();
  cache = { at: Date.now(), items };
  return items;
}

export async function fetchLibrary(): Promise<LibraryItem[]> {
  const raw: Record<string, any>[] = [];
  for (let start = 0; start < MAX_ITEMS; start += PAGE) {
    const q = new URLSearchParams({
      IncludeItemTypes: "Movie,Episode",
      Recursive: "true",
      Fields: "MediaSources,MediaStreams,Path,ProductionYear,SeriesName,ParentIndexNumber,IndexNumber",
      SortBy: "SortName",
      SortOrder: "Ascending",
      StartIndex: String(start),
      Limit: String(PAGE),
    });
    const res = await jf(`/Users/${userId()}/Items?${q}`);
    if (!res.ok) throw new Error(`Jellyfin said ${res.status}`);
    const data = (await res.json()) as { Items: Record<string, any>[]; TotalRecordCount?: number };
    raw.push(...data.Items);
    if (data.Items.length < PAGE || raw.length >= (data.TotalRecordCount ?? Infinity)) break;
  }

  // Jellyfin also lists entries whose files are gone (the old /mnt/media location). The library is only
  // what sits under LIBRARY_ROOT (set in .env to the folder your media lives in; blank means no folder limit) and exists on disk.
  const root = (process.env.LIBRARY_ROOT ?? "").replace(/\/$/, "");
  const paths = raw.map((it) => (it.MediaSources as JfSource[] | undefined)?.[0]?.Path ?? it.Path ?? "");
  const keep = paths.map((p) => !!p && (!root || p.startsWith(`${root}/`)) && existsSync(p));

  // Entries whose files are gone (the old /mnt/media location) are left out of the library altogether.
  return raw.flatMap((it, i) => {
    const src = (it.MediaSources as JfSource[] | undefined)?.[0];
    if (!keep[i]) return [];
    const { mode, reason } = playability(src);
    const isEp = it.Type === "Episode";
    const ep = isEp ? `S${it.ParentIndexNumber ?? "?"}E${it.IndexNumber ?? "?"}` : "";
    return [{
      id: it.Id,
      title: it.Name,
      subtitle: isEp ? `${it.SeriesName ?? ""} ${ep}`.trim() : String(it.ProductionYear ?? ""),
      kind: it.Type,
      runtimeMin: Math.round((it.RunTimeTicks ?? 0) / 600_000_000),
      bitrateMbps: src?.Bitrate ? Math.round((src.Bitrate / 1e6) * 10) / 10 : null,
      playable: reason === null,
      mode,
      reason,
      hasPoster: !!it.ImageTags?.Primary,
    }];
  });
}

export async function itemTitle(id: string): Promise<string | null> {
  const res = await jf(`/Users/${userId()}/Items/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const it = await res.json();
  return it.Type === "Episode" && it.SeriesName ? `${it.SeriesName}: ${it.Name}` : it.Name;
}

export async function posterResponse(id: string): Promise<Response> {
  return jf(`/Items/${encodeURIComponent(id)}/Images/Primary?maxWidth=300&quality=80`, { headers: { Accept: "image/*" } });
}

// The only reasons Jellyfin may give for leaving direct play. Anything else (video codec, profile, level,
// subtitle burn-in, bitrate caps...) can mean re-encoding the video, so the stream is refused.
const SAFE_REASONS = /^ContainerNotSupported$/i;
const SAFE_AUDIO_REASONS = /^Audio(Codec|Channels|Profile|SampleRate|BitDepth)NotSupported$/i;
const TEXT_SUBS = ["srt", "subrip", "vtt", "webvtt", "ass", "ssa"].map((Format) => ({ Format, Method: "External" }));

export type StreamResult =
  | { url: string; hls: boolean; mode: "direct" | "remux"; subtitles: SubtitleTrack[]; video: VideoInfo | null; audio: { tracks: AudioTrack[]; index: number } }
  | { error: string };

/**
 * Ask Jellyfin itself how to play the item and return the URL it implies. Direct play when the file
 * allows it; otherwise Jellyfin's own remux URL, accepted only when the video is copied untouched.
 */
export async function playbackStream(id: string, audioIndex?: number): Promise<StreamResult> {
  const audio = audioCodecs().join(",");
  const profile = {
    Name: "Y-S Movie Night (no video re-encode)",
    MaxStreamingBitrate: 40_000_000,
    DirectPlayProfiles: [{ Type: "Video", Container: containers().join(","), VideoCodec: videoCodecs().join(","), AudioCodec: audio }],
    TranscodingProfiles: remuxEnabled()
      ? [{ Type: "Video", Context: "Streaming", Protocol: "hls", Container: "mp4", VideoCodec: videoCodecs().join(","), AudioCodec: audio, MaxAudioChannels: "6", MinSegments: 1, BreakOnNonKeyFrames: true }]
      : [],
    CodecProfiles: [],
    SubtitleProfiles: TEXT_SUBS,
  };
  const q = new URLSearchParams({
    UserId: userId(),
    StartTimeTicks: "0",
    IsPlayback: "true",
    AutoOpenLiveStream: "false",
    EnableDirectPlay: "true",
    EnableDirectStream: remuxEnabled() ? "true" : "false",
    EnableTranscoding: remuxEnabled() ? "true" : "false",
    AllowVideoStreamCopy: "true",
    AllowAudioStreamCopy: "true",
    SubtitleStreamIndex: "-1",
  });
  type Plan = { MediaSources?: (JfSource & { TranscodingUrl?: string; SupportsDirectStream?: boolean })[] };
  const ask = async (directPlay: boolean): Promise<Plan | string> => {
    const query = new URLSearchParams(q);
    if (!directPlay) query.set("EnableDirectPlay", "false");
    const res = await jf(`/Items/${encodeURIComponent(id)}/PlaybackInfo?${query}`, { method: "POST", body: JSON.stringify({ DeviceProfile: profile }) });
    return res.ok ? ((await res.json()) as Plan) : `Jellyfin said ${res.status}`;
  };
  let info = await ask(true);
  if (typeof info === "string") return { error: info };

  const tracks = audioTracks(info.MediaSources?.[0]);
  const defaultIndex = info.MediaSources?.[0]?.DefaultAudioStreamIndex ?? tracks[0]?.index ?? -1;
  const wantOther = audioIndex !== undefined && audioIndex !== defaultIndex;
  if (wantOther) {
    const t = tracks.find((x) => x.index === audioIndex);
    if (!t) return { error: "That audio track does not exist." };
    if (!t.playable) return { error: "That audio track would need converting, which is switched off." };
    // A plain file plays its default track only, so ask Jellyfin for the repackaged (remuxed) version instead.
    if (info.MediaSources?.some((s) => s.SupportsDirectPlay)) {
      const again = await ask(false);
      if (typeof again === "string") return { error: again };
      info = again;
    }
  }
  const audioInfo = { tracks, index: wantOther ? (audioIndex as number) : defaultIndex };

  const direct = wantOther ? undefined : info.MediaSources?.find((s) => s.SupportsDirectPlay);
  if (direct) {
    const p = new URLSearchParams({ static: "true", mediaSourceId: direct.Id, deviceId: "ys-movie-night", api_key: token() });
    if (direct.ETag) p.set("Tag", direct.ETag);
    return { url: `${publicBase()}/Videos/${encodeURIComponent(id)}/stream?${p}`, hls: false, mode: "direct", subtitles: subtitleTracks(direct), video: videoInfo(direct), audio: audioInfo };
  }

  const remux = info.MediaSources?.find((s) => s.TranscodingUrl);
  if (!remux?.TranscodingUrl) return { error: wantOther ? "Jellyfin cannot switch the audio track for this one." : "Jellyfin says this one cannot be played without converting it." };
  const tu = new URL(remux.TranscodingUrl, "http://x");
  const reasons = (tu.searchParams.get("TranscodeReasons") ?? "").split(",").filter(Boolean);
  const allowed = (r: string) => SAFE_REASONS.test(r) || (audioConvertEnabled() && SAFE_AUDIO_REASONS.test(r));
  // An empty list is only acceptable when we asked for the repackaged version of a file that could have played as is.
  if ((reasons.length === 0 && !wantOther) || !reasons.every(allowed) || tu.searchParams.get("SubtitleMethod") === "Encode" || tu.searchParams.get("AllowVideoStreamCopy") === "false") {
    return { error: "Playing this would mean re-encoding the video, which this app never asks for." };
  }
  const out = new URL(remux.TranscodingUrl, publicBase() + "/");
  if (!out.searchParams.has("api_key") && !out.searchParams.has("ApiKey")) out.searchParams.set("api_key", token());
  // The chosen track is set on the stream address itself; Jellyfin's ffmpeg then maps that track (checked against the real server).
  if (wantOther) out.searchParams.set("AudioStreamIndex", String(audioIndex));
  return { url: out.toString(), hls: true, mode: "remux", subtitles: subtitleTracks(remux), video: videoInfo(remux), audio: audioInfo };
}
