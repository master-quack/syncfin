export const DRIFT_IGNORE_S = 0.3;
export const DRIFT_SEEK_S = 2;
export const MAX_RATE_DELTA = 0.05;
export const SEEK_COOLDOWN_MS = 3000;

export interface DriftOptions {
  /** Drift below this is ignored. Touch devices use a wider band: constant rate changes can glitch audio there. */
  ignore?: number;
  /** Largest rate change used to nudge (0.05 = plus or minus 5%). */
  maxRate?: number;
}

export type DriftAction =
  | { kind: "none"; rate: 1 }
  | { kind: "nudge"; rate: number }
  | { kind: "seek"; to: number };

/**
 * Drift ladder against the timeline's expected position.
 * drift > 0 means this viewer is ahead.
 *  - under 0.3 s: ignore
 *  - 0.3 to 2 s: nudge playbackRate by at most ±5%
 *  - over 2 s: hard seek, with a cooldown so it cannot thrash (nudge at the cap meanwhile)
 */
export function driftAction(
  actual: number,
  expected: number,
  playing: boolean,
  lastSeekAt: number,
  now: number,
  opts: DriftOptions = {},
): DriftAction {
  const drift = actual - expected;
  const abs = Math.abs(drift);
  const maxRate = opts.maxRate ?? MAX_RATE_DELTA;
  if (abs < (opts.ignore ?? DRIFT_IGNORE_S)) return { kind: "none", rate: 1 };

  const cooledDown = now - lastSeekAt >= SEEK_COOLDOWN_MS;
  if (abs > DRIFT_SEEK_S || !playing) {
    if (cooledDown) return { kind: "seek", to: expected };
    return { kind: "nudge", rate: nudgeRate(drift, maxRate) };
  }
  return { kind: "nudge", rate: nudgeRate(drift, maxRate) };
}

function nudgeRate(drift: number, maxRate: number): number {
  const delta = Math.min(maxRate, Math.abs(drift) * 0.1);
  return drift > 0 ? 1 - delta : 1 + delta;
}
