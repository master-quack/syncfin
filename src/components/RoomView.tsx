"use client";

import { Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { checkSupport, type Support } from "../lib/client/capability";
import { RoomEngine } from "../lib/client/engine";
import { useRoom } from "../lib/client/store";
import { Button } from "./Button";
import { Chat } from "./Chat";
import { Player, type AudioTrackInfo, type SubtitleTrackInfo } from "./Player";
import { Ticket } from "./Ticket";

const NAME_KEY = "ys-name";
const AUDIO_PREF_KEY = "ys-audio-lang";

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function RoomView({ code, title, wsUrl }: { code: string; title: string; wsUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<RoomEngine | null>(null);
  const [name, setName] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [streamError, setStreamError] = useState("");
  const [hls, setHls] = useState(false);
  const [ready, setReady] = useState(false);
  const [joining, setJoining] = useState(false);
  const [started, setStarted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [tracks, setTracks] = useState<SubtitleTrackInfo[]>([]);
  const [support, setSupport] = useState<Support | null>(null);
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [audioIndex, setAudioIndex] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [audioError, setAudioError] = useState("");
  const resumeAtRef = useRef<number | null>(null);
  const switchingRef = useRef(false);
  const streamUrlRef = useRef("");
  const switchTimer = useRef<number>();
  const conn = useRoom((s) => s.conn);
  const members = useRoom((s) => s.members);
  const selfId = useRoom((s) => s.selfId);
  // Once this viewer has taken a seat the picture stays up, whatever the connection does (drops and retries included).
  const dead = conn === "missing" || conn === "full" || conn === "limited";
  const reconnecting = started && !dead && conn !== "open";

  type Loaded = { ok: true; url: string } | { ok: false; error: string };

  /** Fetches a stream plan. `audio` asks for a particular audio track; `quiet` keeps failures out of the big error banner. */
  const loadStream = async (isReload: boolean, audio?: number, quiet = false): Promise<Loaded> => {
    const fetchPlan = async (a?: number) => {
      const r = await fetch(`/api/rooms/${code}/stream${a !== undefined ? `?audio=${a}` : ""}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error === "no room" ? "That room does not exist (anymore)." : (body.error ?? "Could not get the stream."));
      return body;
    };
    try {
      let body = await fetchPlan(audio);
      // First load: if this device chose a language before and this title offers it, start in it.
      const offered: AudioTrackInfo[] = Array.isArray(body.audio?.tracks) ? body.audio.tracks : [];
      if (!isReload && audio === undefined && offered.length > 1) {
        const pref = readPref(AUDIO_PREF_KEY);
        const current = offered.find((t) => t.index === body.audio.index);
        const want = pref ? offered.find((t) => t.lang === pref && t.playable) : undefined;
        if (pref && want && current?.lang !== pref && want.index !== body.audio.index) body = await fetchPlan(want.index).catch(() => body);
      }
      if (!quiet) setStreamError("");
      setHls(!!body.hls);
      setReady(!body.hls);
      streamUrlRef.current = body.streamUrl;
      setStreamUrl(body.streamUrl);
      setTracks(Array.isArray(body.subtitles) ? body.subtitles : []);
      setAudioTracks(Array.isArray(body.audio?.tracks) ? body.audio.tracks : []);
      setAudioIndex(typeof body.audio?.index === "number" ? body.audio.index : null);
      // Can this browser actually play the picture? Say so now, instead of leaving it to "just buffers".
      if (body.video) {
        const nativeHls = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
        void checkSupport(body.video, !!body.hls && !nativeHls).then(setSupport);
      }
      if (isReload) setReloadKey((k) => k + 1);
      return { ok: true, url: body.streamUrl as string };
    } catch (e) {
      const error = (e as Error).message;
      if (!quiet) setStreamError(error);
      return { ok: false, error };
    }
  };

  const finishSwitch = () => {
    window.clearTimeout(switchTimer.current);
    if (!switchingRef.current) return;
    switchingRef.current = false;
    resumeAtRef.current = null;
    setSwitching(false);
    engineRef.current?.resync();
  };

  /** While a deliberate stream switch is loading: start where the room is, and resume the moment there is picture. */
  const armSwitch = (v: HTMLVideoElement, seekOnMeta: boolean) => {
    if (!switchingRef.current) return () => {};
    const at = resumeAtRef.current;
    const onMeta = () => {
      if (seekOnMeta && at && at > 1) v.currentTime = at;
    };
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    v.addEventListener("canplay", finishSwitch, { once: true });
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("canplay", finishSwitch);
    };
  };

  /** Switch this viewer's audio track. Only their own stream changes; the room's shared timeline is untouched. */
  const switchAudio = async (index: number) => {
    if (switchingRef.current || index === audioIndex) return;
    const engine = engineRef.current;
    setAudioError("");
    switchingRef.current = true;
    setSwitching(true);
    resumeAtRef.current = engine?.expectedPosition(true) ?? videoRef.current?.currentTime ?? 0;
    engine?.noteSourceChange();
    const before = streamUrlRef.current;
    const res = await loadStream(true, index, true);
    if (!res.ok) {
      setAudioError(res.error);
      switchingRef.current = false;
      resumeAtRef.current = null;
      setSwitching(false);
      engine?.resync();
      return;
    }
    const lang = audioTracks.find((t) => t.index === index)?.lang;
    if (lang) writePref(AUDIO_PREF_KEY, lang);
    if (res.url === before) finishSwitch(); // same address: nothing needs reloading
    else switchTimer.current = window.setTimeout(finishSwitch, 30_000); // never leave the viewer stuck waiting
  };

  useEffect(() => {
    setName(readName());
    useRoom.getState().set({ conn: "idle", chat: [], members: [], stall: null, timeline: null, reactions: [] });
    // The stream URL is fetched up front so the tap below can unlock playback on iPhone.
    void loadStream(false);
    return () => {
      window.clearTimeout(switchTimer.current);
      engineRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Live-remuxed titles arrive as HLS: Safari plays it natively, everything else goes through hls.js.
  useEffect(() => {
    const v = videoRef.current;
    if (!hls || !streamUrl || !v) return;
    if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = streamUrl;
      setReady(true);
      return armSwitch(v, true);
    }
    let player: { destroy(): void } | null = null;
    let disarm: () => void = () => {};
    let cancelled = false;
    import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) return setStreamError("This browser cannot play this title.");
      // The path to the stream can be slow and uneven for a few seconds at a time, so hold more picture ahead, wait
      // longer before giving up on a piece, and retry failed pieces instead of stopping.
      const h = new Hls({
        enableWorker: true,
        // After a deliberate switch, begin at the room's position instead of 0:00.
        startPosition: resumeAtRef.current ?? -1,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1000 * 1000,
        startFragPrefetch: true,
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 30_000,
            maxLoadTimeMs: 90_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 5, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
      });
      player = h;
      let netRetries = 0;
      let mediaRetries = 0;
      h.on(Hls.Events.MANIFEST_PARSED, () => setReady(true));
      h.on(Hls.Events.FRAG_BUFFERED, () => {
        netRetries = 0;
        mediaRetries = 0;
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // A restarted ffmpeg or a network blip is normal for live remux: retry before giving up.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return h.startLoad();
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 3) return h.recoverMediaError();
        setStreamError("The stream stopped working.");
      });
      h.loadSource(streamUrl);
      h.attachMedia(v);
      disarm = armSwitch(v, false);
    });
    return () => {
      cancelled = true;
      disarm();
      player?.destroy();
    };
  }, [hls, streamUrl, reloadKey]);

  // A plain (non-HLS) source after a deliberate switch, e.g. back to the file's own track: same resume handling.
  useEffect(() => {
    const v = videoRef.current;
    if (hls || !streamUrl || !v) return;
    return armSwitch(v, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hls, streamUrl, reloadKey]);

  const join = async () => {
    const v = videoRef.current;
    const clean = name.trim().slice(0, 24);
    // One seat per tap: a second tap while connecting must not create a second connection.
    if (!v || !clean || !ready || engineRef.current) return;
    setJoining(true);
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      /* private mode */
    }
    // Inside the tap: let the element play once so later scripted play() calls are allowed on iOS.
    v.muted = false;
    // The play() call itself is what the browser counts as the unlock; pause straight away so nothing is heard.
    v.play().catch(() => {});
    v.pause();
    const url = wsUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const engine = new RoomEngine(code, clean, url);
    engine.setSeekLatencyHint(hls ? 3000 : 0);
    engineRef.current = engine;
    engine.attachVideo(v);
    engine.connect();
    setStarted(true);
    setJoining(false);
  };

  const deadMessage = dead ? { missing: "That room does not exist (anymore).", full: "That room is full.", limited: "Too many tries. Retrying shortly." }[conn as "missing" | "full" | "limited"] : "";
  const blocked = streamError || deadMessage;

  const gate = blocked ? (
    <>
      <p className="font-display text-d3" role="alert">
        {blocked}
      </p>
      <Link href="/" className="text-small text-muted underline underline-offset-4">
        Back to the foyer
      </Link>
    </>
  ) : (
    <>
      {support && support.level !== "ok" && (
        <p role="note" data-testid="support-note" className={`max-w-sm text-small ${support.level === "bad" ? "text-danger" : "text-muted"}`}>
          {support.message}
        </p>
      )}
      <label htmlFor="name" className="text-small text-muted">
        What should the others call you?
      </label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={24}
        autoComplete="nickname"
        className="w-full max-w-xs rounded border border-line bg-surface px-4 py-3 text-center text-body text-text"
      />
      <Button onClick={join} disabled={!name.trim() || !ready || joining} data-testid="join">
        {!ready ? "Warming the projector" : joining ? "Finding your seat" : "Tap to take a seat"}
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-small text-muted">Now showing</p>
          <h1 className="font-display text-d2 leading-none" data-testid="room-title">
            {title}
          </h1>
        </div>
        <Ticket code={code} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-3">
          <Player
            videoRef={videoRef}
            src={!hls && streamUrl ? streamUrl : undefined}
            started={started}
            engineRef={engineRef}
            title={title}
            code={code}
            tracks={tracks}
            audioTracks={audioTracks}
            audioIndex={audioIndex}
            audioBusy={switching}
            audioError={audioError}
            onAudioChange={(i) => void switchAudio(i)}
            gate={gate}
            onVideoError={() => started && setStreamError("The picture stopped working.")}
            onSendChat={(t) => engineRef.current?.chat(t)}
          />

          {started && blocked && (
            <div className="flex flex-wrap items-center gap-3 rounded border border-line bg-surface px-4 py-3" role="alert" data-testid="stream-problem">
              <span className="text-body text-danger">{blocked}</span>
              {streamError && (
                <Button variant="ghost" className="px-4 py-2" onClick={() => void loadStream(true)}>
                  Reload the stream
                </Button>
              )}
            </div>
          )}

          {started && support && support.level !== "ok" && (
            <p role="note" className={`rounded border border-line bg-surface px-4 py-3 text-body ${support.level === "bad" ? "text-danger" : "text-muted"}`}>
              {support.message}
            </p>
          )}

          {reconnecting && <p className="text-small text-muted">Reconnecting to the room.</p>}
        </div>

        <aside className="flex min-h-0 flex-col gap-3 lg:h-[calc(100vh-14rem)]">
          <div className="rounded bg-surface p-3">
            <p className="mb-1 flex items-center gap-2 text-small text-muted">
              <Users size={18} /> In the room ({members.length})
            </p>
            <ul className="flex flex-wrap gap-2" data-testid="members">
              {members.map((m) => (
                <li key={m.id} className="rounded-sm bg-raised px-2 py-1 text-small">
                  {m.name}
                  {m.id === selfId ? " (you)" : ""}
                </li>
              ))}
              {members.length === 0 && <li className="text-small text-dim">Just the seats, so far.</li>}
            </ul>
          </div>
          <div className="h-72 min-h-0 lg:h-auto lg:flex-1">
            <Chat onSend={(t) => engineRef.current?.chat(t)} />
          </div>
        </aside>
      </div>
    </div>
  );
}
