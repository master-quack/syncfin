/** What the picture is, as reported by the stream endpoint. */
export interface VideoDto {
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

export interface Support {
  level: "ok" | "warn" | "bad";
  message: string;
  /** For the diagnostic report: what the browser said. */
  mse: boolean | null;
  decode: { supported: boolean; smooth: boolean; powerEfficient: boolean } | null;
  codec: string;
}

const NAMES: Record<string, string> = { hevc: "HEVC (H.265)", h265: "HEVC (H.265)", h264: "H.264", av1: "AV1", vp9: "VP9" };

/** The codec string a browser wants, built from what Jellyfin knows about the stream. */
export function codecString(v: VideoDto): string | null {
  const level = v.level || 0;
  if (v.codec === "h264") {
    const profile = /high 10/i.test(v.profile) ? "6E" : /high/i.test(v.profile) ? "64" : /main/i.test(v.profile) ? "4D" : "42";
    return `avc1.${profile}00${(level || 40).toString(16).padStart(2, "0")}`;
  }
  if (v.codec === "hevc" || v.codec === "h265") return `hvc1.${v.bitDepth >= 10 ? "2.4" : "1.6"}.L${level || 120}.B0`;
  if (v.codec === "av1") return v.bitDepth >= 10 ? "av01.0.08M.10" : "av01.0.08M.08";
  if (v.codec === "vp9") return "vp09.00.40.08";
  return null;
}

/**
 * Can this browser play the video, and smoothly? Asked before anyone presses play, so "it just buffers"
 * becomes a clear message instead of a mystery. `viaMse` is true when hls.js feeds the picture (everything but Safari's own HLS).
 */
export async function checkSupport(v: VideoDto, viaMse: boolean): Promise<Support> {
  const name = NAMES[v.codec] ?? v.codec.toUpperCase();
  const cs = codecString(v);
  const blank: Support = { level: "ok", message: "", mse: null, decode: null, codec: name };
  if (!cs || typeof document === "undefined") return blank;
  const type = `video/mp4; codecs="${cs}"`;

  const MS = (window as unknown as { MediaSource?: { isTypeSupported(t: string): boolean }; ManagedMediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource
    ?? (window as unknown as { ManagedMediaSource?: { isTypeSupported(t: string): boolean } }).ManagedMediaSource;
  const mse = MS ? MS.isTypeSupported(type) : false;
  const native = document.createElement("video").canPlayType(type) !== "";
  const canPlay = viaMse ? mse : native || mse;
  if (!canPlay) {
    return {
      ...blank,
      level: "bad",
      mse,
      message: `This browser cannot play this title's video (${name}). Safari, or Chrome or Edge with hardware video decoding, can. Otherwise pick another title.`,
    };
  }

  const mc = (navigator as Navigator & { mediaCapabilities?: { decodingInfo(c: unknown): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }> } }).mediaCapabilities;
  if (!mc) return { ...blank, mse };
  try {
    const info = await mc.decodingInfo({
      type: viaMse ? "media-source" : "file",
      video: { contentType: type, width: v.width || 1920, height: v.height || 1080, bitrate: v.bitrate || 4_000_000, framerate: v.fps || 24 },
    });
    if (!info.supported) {
      return { ...blank, level: "bad", mse, decode: info, message: `This browser says it cannot decode this title's video (${name}). Try Safari, or pick another title.` };
    }
    if (!info.smooth) {
      return { ...blank, level: "warn", mse, decode: info, message: `This title's video (${name}, ${v.width}x${v.height}) may stutter on this device, because the browser expects to decode it in software.` };
    }
    return { ...blank, mse, decode: info };
  } catch {
    return { ...blank, mse };
  }
}
