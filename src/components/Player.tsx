"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Captions, Check, Languages, Loader2, Maximize, MessageCircle, Minimize, Pause, Play, RotateCcw, RotateCw, SmilePlus, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import type { RoomEngine } from "../lib/client/engine";
import { useRoom } from "../lib/client/store";
import { REACTIONS, SKIP_SECONDS } from "../lib/sync/protocol";
import { ChatOverlay } from "./ChatOverlay";
import { REACTION_ICONS } from "./reactions";
import { ReactionLayer } from "./ReactionLayer";
import { StallNote } from "./StallNote";

export interface SubtitleTrackInfo {
  index: number;
  lang: string;
  label: string;
}

export interface AudioTrackInfo {
  index: number;
  lang: string;
  label: string;
  playable: boolean;
}

type Fullscreen = "off" | "native" | "css";
type Menu = "none" | "subs" | "react" | "audio";

const SUB_PREF_KEY = "ys-sub-lang";
const IDLE_MS = 3000;
const DOUBLE_TAP_MS = 300;

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Safari (iPhone, iPad, Mac) blocks typing while an element is fullscreen, and chat needs typing, so on Safari
 * "fullscreen" fills the page instead of using the browser's fullscreen mode. Other browsers get the real thing.
 */
function needsPageFullscreen(): boolean {
  const ua = navigator.userAgent;
  const apple = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua);
  return apple || safari || !document.fullscreenEnabled;
}

/** Progress, buffered range and scrubbing. Kept separate so its few-times-a-second updates re-render only this. */
function TimeBar({ videoRef, onSeek, disabled }: { videoRef: RefObject<HTMLVideoElement>; onSeek: (s: number) => void; disabled: boolean }) {
  const [t, setT] = useState({ cur: 0, dur: 0, buf: 0 });
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      let buf = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > v.currentTime) buf = v.buffered.end(i);
      setT((p) => (Math.abs(p.cur - v.currentTime) < 0.2 && p.dur === dur && Math.abs(p.buf - buf) < 0.5 ? p : { cur: v.currentTime, dur, buf }));
    }, 250);
    return () => clearInterval(id);
  }, [videoRef]);

  const shown = drag ?? t.cur;
  const pct = (x: number) => (t.dur > 0 ? Math.min(100, (x / t.dur) * 100) : 0);
  const commit = () => {
    if (dragRef.current !== null) onSeek(dragRef.current);
    dragRef.current = null;
    setDrag(null);
  };

  return (
    <div className="flex w-full items-center gap-3">
      <span className="w-14 text-right text-small tabular-nums text-text">{fmt(shown)}</span>
      <div className="relative h-6 flex-1">
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line/60" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-dim" style={{ width: `${pct(t.buf)}%` }} />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-text" style={{ width: `${pct(shown)}%` }} />
        <input
          type="range"
          data-testid="seekbar"
          aria-label="Seek"
          min={0}
          max={t.dur || 1}
          step={1}
          value={Math.min(shown, t.dur || 1)}
          disabled={disabled || t.dur === 0}
          onChange={(e) => {
            const n = Number(e.target.value);
            dragRef.current = n;
            setDrag(n);
          }}
          onPointerUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className="ys-range absolute inset-0 h-6 w-full cursor-pointer appearance-none bg-transparent"
        />
      </div>
      <span className="w-14 text-small tabular-nums text-muted">{fmt(t.dur)}</span>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  testId,
  active = false,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-11 w-11 items-center justify-center rounded text-text hover:bg-raised ${active ? "bg-raised" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

export function Player({
  videoRef,
  src,
  started,
  engineRef,
  title,
  code,
  tracks,
  audioTracks,
  audioIndex,
  audioBusy,
  audioError,
  onAudioChange,
  gate,
  onVideoError,
  onSendChat,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  src: string | undefined;
  started: boolean;
  engineRef: MutableRefObject<RoomEngine | null>;
  title: string;
  code: string;
  tracks: SubtitleTrackInfo[];
  /** Audio tracks of this title (the picker shows when there is more than one). Each viewer chooses their own. */
  audioTracks: AudioTrackInfo[];
  audioIndex: number | null;
  audioBusy: boolean;
  audioError: string;
  onAudioChange: (index: number) => void;
  /** The "take a seat" step shown over the picture until this viewer has joined. */
  gate: ReactNode;
  onVideoError: () => void;
  onSendChat: (text: string) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState<Fullscreen>("off");
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<Menu>("none");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPinned, setChatPinned] = useState(false);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<{ key: number; text: string; side: "left" | "right" } | null>(null);
  const [stats, setStats] = useState<Record<string, string | number> | null>(null);
  const [subIndex, setSubIndex] = useState<number | null>(null);
  const [subState, setSubState] = useState<"idle" | "loading" | "error">("idle");
  const playing = useRoom((s) => s.timeline?.playing ?? false);

  // ---- showing and hiding the controls ---------------------------------------------------------------
  const idle = useRef<number>();
  const live = useRef({ playing, menu, visible });
  live.current = { playing, menu, visible };
  const poke = useCallback(() => {
    setVisible(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      if (live.current.playing && live.current.menu === "none") setVisible(false);
    }, IDLE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(idle.current);
  }, [playing, menu, poke]);

  // ---- fullscreen ------------------------------------------------------------------------------------
  const enterFs = async () => {
    const el = shellRef.current;
    if (!el) return;
    if (!needsPageFullscreen() && el.requestFullscreen) {
      try {
        await el.requestFullscreen();
        setFs("native");
        // Phones held upright waste the picture; ask for landscape where the browser allows it.
        const lock = (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock;
        void lock?.call(screen.orientation, "landscape").catch(() => {});
        return;
      } catch {
        /* fall through to the page-filling mode */
      }
    }
    setFs("css");
  };
  const exitFs = async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    setFs("off");
  };
  const toggleFs = () => void (fs === "off" ? enterFs() : exitFs());

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFs((f) => (f === "native" ? "off" : f));
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (fs !== "css") return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFs("off");
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [fs]);

  useEffect(() => {
    // Leaving fullscreen puts chat back in the side panel; a pinned chat comes back with the next fullscreen.
    setChatOpen(fs !== "off" && chatPinned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  // ---- subtitles (per viewer; the choice is remembered on this device) -------------------------------
  useEffect(() => {
    setSubIndex(null);
    if (tracks.length === 0) return;
    let pref: string | null = null;
    try {
      pref = localStorage.getItem(SUB_PREF_KEY);
    } catch {
      /* private mode */
    }
    if (!pref || pref === "off") return;
    const best = tracks.find((t) => t.lang === pref && !/hearing|forced/i.test(t.label)) ?? tracks.find((t) => t.lang === pref);
    if (best) setSubIndex(best.index);
  }, [tracks]);

  const chooseSub = (t: SubtitleTrackInfo | null) => {
    setSubIndex(t ? t.index : null);
    setMenu("none");
    try {
      if (!t) localStorage.setItem(SUB_PREF_KEY, "off");
      else if (t.lang) localStorage.setItem(SUB_PREF_KEY, t.lang);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.querySelectorAll("track[data-ys]").forEach((el) => {
      URL.revokeObjectURL((el as HTMLTrackElement).src);
      el.remove();
    });
    if (subIndex === null) {
      setSubState("idle");
      return;
    }
    let cancelled = false;
    setSubState("loading");
    fetch(`/api/rooms/${code}/subtitles/${subIndex}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (cancelled) return;
        // Served from our own origin as a blob, so the picture needs no cross-origin permissions.
        const el = document.createElement("track");
        el.kind = "subtitles";
        el.label = tracks.find((t) => t.index === subIndex)?.label ?? "Subtitles";
        el.src = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        el.default = true;
        el.setAttribute("data-ys", "1");
        v.appendChild(el);
        el.track.mode = "showing";
        setSubState("idle");
      })
      .catch(() => !cancelled && setSubState("error"));
    return () => {
      cancelled = true;
    };
  }, [subIndex, code, tracks, videoRef]);

  // ---- hidden stats readout (add ?stats=1 to the room address) ---------------------------------------
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("stats")) return;
    const id = setInterval(() => setStats(engineRef.current?.getStats() ?? null), 500);
    return () => clearInterval(id);
  }, [engineRef]);

  // ---- actions ---------------------------------------------------------------------------------------
  const showFlash = (text: string, side: "left" | "right") => {
    setFlash({ key: Date.now(), text, side });
    window.setTimeout(() => setFlash((f) => (f && Date.now() - f.key >= 550 ? null : f)), 600);
  };
  const skip = (delta: number) => {
    engineRef.current?.skip(delta);
    showFlash(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} s`, delta > 0 ? "right" : "left");
    poke();
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!started || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    const onButton = t instanceof HTMLButtonElement;
    switch (e.key) {
      case " ":
      case "k":
        if (onButton) return;
        e.preventDefault();
        engineRef.current?.togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        skip(-SKIP_SECONDS);
        break;
      case "ArrowRight":
        e.preventDefault();
        skip(SKIP_SECONDS);
        break;
      case "f":
        toggleFs();
        break;
      case "m":
        toggleMute();
        break;
      case "c":
        if (fs !== "off") setChatOpen((o) => !o);
        break;
    }
    poke();
  };

  // Tapping the picture: mouse click = play/pause, double-click = fullscreen. Touch: single tap shows or hides the
  // controls, double-tap on the left or right third skips back or forwards, in the middle it toggles fullscreen.
  const tap = useRef<{ t: number; timer?: number }>({ t: 0 });
  const onSurfacePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!started || (e.pointerType === "mouse" && e.button !== 0)) return;
    setMenu("none");
    if (chatOpen && !chatPinned) setChatOpen(false);
    const type = e.pointerType;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const now = Date.now();
    window.clearTimeout(tap.current.timer);
    if (now - tap.current.t < DOUBLE_TAP_MS) {
      tap.current = { t: 0 };
      if (type !== "mouse" && x < 0.33) skip(-SKIP_SECONDS);
      else if (type !== "mouse" && x > 0.67) skip(SKIP_SECONDS);
      else toggleFs();
      return;
    }
    tap.current = {
      t: now,
      timer: window.setTimeout(() => {
        tap.current.t = 0;
        if (type === "mouse") engineRef.current?.togglePlay();
        else if (live.current.visible) setVisible(false);
        else poke();
      }, DOUBLE_TAP_MS),
    };
  };

  const shellClass =
    fs === "css"
      ? "fixed inset-0 z-50 h-[100dvh] w-screen bg-bg"
      : fs === "native"
        ? "relative h-full w-full bg-bg"
        : "relative aspect-video w-full overflow-hidden rounded bg-bg";
  const full = fs !== "off";
  const hasSubs = tracks.length > 0;
  const hasAudioChoice = audioTracks.length > 1;

  return (
    <div
      ref={shellRef}
      tabIndex={0}
      data-testid="player"
      data-fs={fs}
      data-controls={visible ? "on" : "off"}
      onKeyDown={onKeyDown}
      onPointerMove={() => started && poke()}
      className={`${shellClass} touch-manipulation select-none outline-none ${!visible && full ? "cursor-none" : ""}`}
    >
      <video ref={videoRef} src={src} playsInline preload="auto" className="h-full w-full bg-bg object-contain" data-testid="video" onError={onVideoError} />

      {/* the picture surface: taps and clicks land here */}
      <div className="absolute inset-0" onPointerUp={onSurfacePointerUp} data-testid="surface" />

      <ReactionLayer />
      <StallNote />

      {/* audio switch notice */}
      <AnimatePresence>
        {(audioBusy || audioError) && (
          <motion.p
            key="audio-note"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="status"
            data-testid="audio-note"
            className={`pointer-events-none absolute left-1/2 top-14 z-20 max-w-[90%] -translate-x-1/2 rounded border border-line bg-bg/85 px-4 py-2 text-center text-body ${audioError && !audioBusy ? "text-danger" : "text-text"}`}
          >
            {audioBusy ? "Switching your audio. A few seconds." : audioError}
          </motion.p>
        )}
      </AnimatePresence>

      {/* skip feedback */}
      <AnimatePresence>
        {flash && (
          <motion.div
            key={flash.key}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded bg-bg/75 px-4 py-2 font-display text-d3 text-text ${flash.side === "left" ? "left-[12%]" : "right-[12%]"}`}
          >
            {flash.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* title while fullscreen */}
      {full && started && (
        <div className={`pointer-events-none absolute left-0 top-0 z-10 max-w-[70%] px-4 pt-[max(0.75rem,env(safe-area-inset-top))] transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}>
          <p className="font-display text-d3 leading-none text-text">{title}</p>
        </div>
      )}

      {stats && (
        <dl className="pointer-events-none absolute left-2 top-12 z-30 grid grid-cols-[auto_auto] gap-x-3 rounded bg-bg/85 p-2 text-small text-text" data-testid="stats">
          {Object.entries(stats).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="tabular-nums">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* controls */}
      {started && (
        <div
          className={`absolute inset-x-0 bottom-0 z-20 border-t border-line/50 bg-bg/80 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 transition-opacity duration-200 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
          onPointerDown={poke}
          data-testid="controls"
        >
          <TimeBar videoRef={videoRef} onSeek={(s) => engineRef.current?.seekTo(s)} disabled={!started} />

          <div className="relative mt-1 flex items-center justify-between">
            <div className="flex items-center">
              <IconButton label={playing ? "Pause for everyone" : "Play for everyone"} testId="play-toggle" onClick={() => engineRef.current?.togglePlay()}>
                {playing ? <Pause size={26} /> : <Play size={26} />}
              </IconButton>
              <IconButton label="Back 15 seconds for everyone" testId="rewind15" onClick={() => skip(-SKIP_SECONDS)}>
                <span className="relative flex h-8 w-8 items-center justify-center">
                  <RotateCcw size={32} strokeWidth={1.5} />
                  <span className="absolute text-small font-semibold">15</span>
                </span>
              </IconButton>
              <IconButton label="Forward 15 seconds for everyone" testId="skip15" onClick={() => skip(SKIP_SECONDS)}>
                <span className="relative flex h-8 w-8 items-center justify-center">
                  <RotateCw size={32} strokeWidth={1.5} />
                  <span className="absolute text-small font-semibold">15</span>
                </span>
              </IconButton>
              <IconButton label={muted ? "Unmute" : "Mute"} testId="mute" onClick={toggleMute} className="hidden sm:flex">
                {muted ? <VolumeX size={24} /> : <Volume2 size={24} />}
              </IconButton>
            </div>

            <div className="flex items-center">
              <IconButton label="Send a reaction" testId="react-btn" className="max-sm:w-10" active={menu === "react"} onClick={() => setMenu((m) => (m === "react" ? "none" : "react"))}>
                <SmilePlus size={24} />
              </IconButton>
              {hasAudioChoice && (
                <IconButton label="Audio track" testId="audio-btn" className="max-sm:w-10" active={menu === "audio"} onClick={() => setMenu((m) => (m === "audio" ? "none" : "audio"))}>
                  {audioBusy ? <Loader2 size={24} className="animate-spin" /> : <Languages size={24} />}
                </IconButton>
              )}
              {hasSubs && (
                <IconButton label="Subtitles" testId="subs-btn" className="max-sm:w-10" active={menu === "subs" || subIndex !== null} onClick={() => setMenu((m) => (m === "subs" ? "none" : "subs"))}>
                  {subState === "loading" ? <Loader2 size={24} className="animate-spin" /> : <Captions size={24} />}
                </IconButton>
              )}
              {full && (
                <IconButton label="Chat" testId="chat-btn" className="max-sm:w-10" active={chatOpen} onClick={() => setChatOpen((o) => !o)}>
                  <MessageCircle size={24} />
                </IconButton>
              )}
              <IconButton label={full ? "Leave fullscreen" : "Fullscreen"} testId="fs-btn" className="max-sm:w-10" onClick={toggleFs}>
                {full ? <Minimize size={24} /> : <Maximize size={24} />}
              </IconButton>
            </div>

            <AnimatePresence>
              {menu === "react" && (
                <motion.div
                  key="react"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  data-testid="react-picker"
                  className="absolute bottom-full right-0 mb-2 flex gap-1 rounded border border-line bg-bg/90 p-1"
                >
                  {REACTIONS.map((k) => {
                    const { Icon, label, className } = REACTION_ICONS[k];
                    return (
                      <button key={k} type="button" aria-label={label} data-testid={`react-${k}`} onClick={() => engineRef.current?.react(k)} className="flex h-11 w-11 items-center justify-center rounded hover:bg-raised">
                        <Icon size={26} className={className} />
                      </button>
                    );
                  })}
                </motion.div>
              )}
              {menu === "audio" && (
                <motion.div
                  key="audio"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  role="menu"
                  data-testid="audio-menu"
                  className="absolute bottom-full right-0 mb-2 max-h-64 w-72 overflow-y-auto rounded border border-line bg-bg/90 py-1"
                >
                  {audioTracks.map((t) => (
                    <button
                      key={t.index}
                      type="button"
                      role="menuitemradio"
                      aria-checked={audioIndex === t.index}
                      disabled={!t.playable || audioBusy}
                      data-testid="audio-item"
                      onClick={() => {
                        setMenu("none");
                        onAudioChange(t.index);
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-body hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{t.label}</span>
                        {!t.playable && <span className="block text-small text-muted">Needs converting, which is switched off</span>}
                      </span>
                      {audioIndex === t.index && <Check size={18} className="shrink-0" />}
                    </button>
                  ))}
                  <p className="px-3 py-2 text-small text-muted">Only changes your own sound. It restarts your stream for a few seconds.</p>
                </motion.div>
              )}
              {menu === "subs" && (
                <motion.div
                  key="subs"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  role="menu"
                  data-testid="subs-menu"
                  className="absolute bottom-full right-0 mb-2 max-h-64 w-64 overflow-y-auto rounded border border-line bg-bg/90 py-1"
                >
                  <button type="button" role="menuitemradio" aria-checked={subIndex === null} onClick={() => chooseSub(null)} className="flex min-h-11 w-full items-center justify-between px-3 text-left text-body hover:bg-raised">
                    Off {subIndex === null && <Check size={18} />}
                  </button>
                  {tracks.map((t) => (
                    <button key={t.index} type="button" role="menuitemradio" aria-checked={subIndex === t.index} data-testid="subs-item" onClick={() => chooseSub(t)} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-body hover:bg-raised">
                      <span className="truncate">{t.label}</span>
                      {subIndex === t.index && (subState === "loading" ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <Check size={18} className="shrink-0" />)}
                    </button>
                  ))}
                  {subState === "loading" && <p className="px-3 py-2 text-small text-muted">Fetching subtitles. The first one for a film can take half a minute.</p>}
                  {subState === "error" && <p className="px-3 py-2 text-small text-danger">Could not load those subtitles.</p>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* chat while fullscreen: popups, edge tab, slide-over panel */}
      {full && started && <ChatOverlay visible={visible} open={chatOpen} pinned={chatPinned} onOpenChange={setChatOpen} onPinnedChange={setChatPinned} onSend={onSendChat} />}

      {/* the take-a-seat step */}
      <AnimatePresence>
        {!started && (
          <motion.div exit={{ opacity: 0 }} className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-bg/95 p-4 text-center">
            {gate}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
