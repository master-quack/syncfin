"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { checkSupport, type Support, type VideoDto } from "../lib/client/capability";
import { Button } from "./Button";

const SAMPLES: { name: string; video: VideoDto }[] = [
  { name: "H.264 1080p, 2.6 Mbit/s (most MP4s)", video: { codec: "h264", profile: "High", level: 40, bitDepth: 8, width: 1920, height: 1080, fps: 24, bitrate: 2_600_000 } },
  { name: "HEVC 1080p 8-bit, 4.7 Mbit/s (heavier MKVs)", video: { codec: "hevc", profile: "Main", level: 123, bitDepth: 8, width: 1920, height: 1080, fps: 24, bitrate: 4_700_000 } },
  { name: "HEVC 1080p 10-bit, 2.7 Mbit/s (The Office)", video: { codec: "hevc", profile: "Main 10", level: 123, bitDepth: 10, width: 1920, height: 1080, fps: 24, bitrate: 2_700_000 } },
];

interface Row {
  name: string;
  support: Support;
}
interface StreamResult {
  title: string;
  needMbit: number;
  segments: number;
  videoSeconds: number;
  wallSeconds: number;
  speedX: number;
  mbit: number;
  firstByteMs: number[];
  totalMs: number[];
  verdict: string;
  error?: string;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

export function Diag() {
  const [env, setEnv] = useState<Record<string, string | number | boolean>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [ping, setPing] = useState<{ min: number; median: number; max: number } | null>(null);
  const [stream, setStream] = useState<StreamResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const [needAuth, setNeedAuth] = useState(false);

  useEffect(() => {
    const n = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } };
    setEnv({
      userAgent: n.userAgent,
      cores: n.hardwareConcurrency ?? 0,
      memoryGB: n.deviceMemory ?? 0,
      screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
      nativeHls: !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl"),
      mse: typeof (window as unknown as { MediaSource?: unknown }).MediaSource !== "undefined",
      netType: n.connection?.effectiveType ?? "n/a",
      netDownlinkMbit: n.connection?.downlink ?? 0,
      netRttMs: n.connection?.rtt ?? 0,
      saveData: n.connection?.saveData ?? false,
    });
    void Promise.all(SAMPLES.map(async (s) => ({ name: s.name, support: await checkSupport(s.video, true) }))).then(setRows);
  }, []);

  const send = async (payload: unknown) => {
    const r = await fetch("/api/check/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
    setSent(r?.ok ? "Results sent to the server log." : "Could not send the results (you can still read them here).");
  };

  const run = async () => {
    setBusy(true);
    setStream(null);
    setSent("");
    setNeedAuth(false);

    // 1) round trips to this site (through Cloudflare)
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = performance.now();
      await fetch("/api/check/echo", { cache: "no-store" }).catch(() => null);
      times.push(performance.now() - t);
    }
    const p = { min: Math.min(...times), median: median(times), max: Math.max(...times) };
    setPing(p);

    // 2) a real stream of typical heavy weight, fetched the way a player would
    const planRes = await fetch("/api/check/plan").catch(() => null);
    if (!planRes || planRes.status === 401) {
      setNeedAuth(true);
      setBusy(false);
      void send({ env, support: rows.map((r) => ({ name: r.name, level: r.support.level, mse: r.support.mse, decode: r.support.decode })), ping: p, stream: null });
      return;
    }
    const plan = await planRes.json();
    let result: StreamResult;
    try {
      if (!plan.hls) throw new Error("this title is direct play; nothing to time");
      const master = await (await fetch(plan.streamUrl)).text();
      const vu = new URL(master.split("\n").find((l: string) => l && !l.startsWith("#"))!, plan.streamUrl);
      const lines = (await (await fetch(vu)).text()).split("\n");
      const segs: { uri: string; dur: number }[] = [];
      for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("#EXTINF:")) segs.push({ dur: parseFloat(lines[i].slice(8)), uri: lines[i + 1] });
      const first: number[] = [];
      const total: number[] = [];
      let bytes = 0;
      let videoSeconds = 0;
      const t0 = performance.now();
      for (let i = 0; i < Math.min(12, segs.length); i++) {
        const t = performance.now();
        const res = await fetch(new URL(segs[i].uri, vu));
        first.push(performance.now() - t);
        bytes += (await res.arrayBuffer()).byteLength;
        total.push(performance.now() - t);
        videoSeconds += segs[i].dur;
      }
      const wall = (performance.now() - t0) / 1000;
      const speedX = videoSeconds / wall;
      const mbit = (bytes * 8) / wall / 1e6;
      const slowest = Math.max(...total) / 1000;
      const verdict =
        speedX < 1.2
          ? "TOO SLOW: this title's video arrives slower than it plays, so it will buffer."
          : speedX < 2
            ? "MARGINAL: it keeps up, but with little headroom, so any hiccup makes it buffer."
            : slowest > (videoSeconds / total.length) * 0.9
              ? "MOSTLY FINE, but some pieces are slow to arrive; expect occasional buffering."
              : "FINE: the video arrives comfortably faster than it plays.";
      result = { title: plan.title, needMbit: plan.bitrateMbps, segments: total.length, videoSeconds, wallSeconds: wall, speedX, mbit, firstByteMs: first.map(Math.round), totalMs: total.map(Math.round), verdict };
    } catch (e) {
      result = { title: plan.title ?? "?", needMbit: plan.bitrateMbps ?? 0, segments: 0, videoSeconds: 0, wallSeconds: 0, speedX: 0, mbit: 0, firstByteMs: [], totalMs: [], verdict: "Could not run the stream test.", error: String(e) };
    }
    setStream(result);
    setBusy(false);
    void send({
      env,
      support: rows.map((r) => ({ name: r.name, level: r.support.level, mse: r.support.mse, decode: r.support.decode })),
      ping: p,
      stream: { ...result, title: undefined },
    });
  };

  const badge = (s: Support) => (s.level === "ok" ? "plays smoothly" : s.level === "warn" ? "plays but may stutter" : "cannot play");

  return (
    <section className="flex max-w-2xl flex-col gap-6 pt-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-d2 leading-none">Playback check</h1>
        <p className="text-body text-muted">Tests what this browser can decode and how fast a real stream arrives over your connection. Results are also sent to the server so they can be read without copying.</p>
      </div>

      <div className="rounded bg-surface p-4">
        <h2 className="mb-2 font-display text-d3 leading-none">Can this browser play it?</h2>
        <ul className="flex flex-col gap-2" data-testid="diag-support">
          {rows.map((r) => (
            <li key={r.name} className="text-body">
              <span className={r.support.level === "ok" ? "text-text" : r.support.level === "warn" ? "text-muted" : "text-danger"}>{badge(r.support)}</span>
              <span className="text-muted"> · {r.name}</span>
            </li>
          ))}
          {rows.length === 0 && <li className="text-small text-muted">Checking.</li>}
        </ul>
      </div>

      <div className="flex flex-col items-start gap-3">
        <Button onClick={run} disabled={busy} data-testid="diag-run">
          {busy ? "Testing, about 30 seconds" : "Run the stream test"}
        </Button>
        {needAuth && (
          <p className="text-small text-danger" role="alert">
            The stream test needs the passcode. Open the <Link href="/library" className="underline underline-offset-4">library</Link> once, enter it, then come back and run this again. The browser check above was still sent.
          </p>
        )}
      </div>

      {ping && (
        <div className="rounded bg-surface p-4 text-body">
          <h2 className="mb-1 font-display text-d3 leading-none">Round trip to this site</h2>
          <p>fastest {Math.round(ping.min)} ms · typical {Math.round(ping.median)} ms · slowest {Math.round(ping.max)} ms</p>
        </div>
      )}

      {stream && (
        <div className="rounded bg-surface p-4 text-body" data-testid="diag-stream">
          <h2 className="mb-1 font-display text-d3 leading-none">Stream test</h2>
          <p className={stream.speedX >= 2 ? "text-text" : "text-danger"}>{stream.verdict}</p>
          {!stream.error && (
            <p className="mt-2 text-small text-muted">
              {stream.videoSeconds.toFixed(0)} s of video ({stream.needMbit} Mbit/s title) fetched in {stream.wallSeconds.toFixed(1)} s, which is {stream.speedX.toFixed(1)}x real time and {stream.mbit.toFixed(1)} Mbit/s. Slowest piece took {Math.max(...stream.totalMs)} ms. Time to first byte per piece: {stream.firstByteMs.join(", ")} ms.
            </p>
          )}
          {stream.error && <p className="mt-2 text-small text-muted">{stream.error}</p>}
        </div>
      )}

      {sent && <p className="text-small text-muted">{sent}</p>}
    </section>
  );
}
