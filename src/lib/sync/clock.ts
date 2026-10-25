// Simplified NTP, as in OpenWatchParty: keep the last 8 samples, trust the lowest RTT, smooth with an EMA.

const MAX_SAMPLES = 8;
const EMA_ALPHA = 0.4;
const FAST_INTERVAL_MS = 2000;
const SLOW_INTERVAL_MS = 30_000;
const FAST_SAMPLE_COUNT = 5;
const RESTART_FAST_DELTA_MS = 50;
const MAX_RTT_MS = 5000;

interface Sample {
  rtt: number;
  offset: number;
}

export class ClockSync {
  private samples: Sample[] = [];
  private _offset = 0;
  private synced = false;
  private fast = true;

  /** server time ≈ client time + offset */
  get offset(): number {
    return this._offset;
  }

  get hasSync(): boolean {
    return this.synced;
  }

  serverNow(clientNow: number): number {
    return clientNow + this._offset;
  }

  /** t1: client send time, t2: server time in the pong, t3: client receive time. */
  addSample(t1: number, t2: number, t3: number): boolean {
    const rtt = t3 - t1;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_RTT_MS) return false;
    this.samples.push({ rtt, offset: t2 + rtt / 2 - t3 });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    const next = this.synced ? this._offset * (1 - EMA_ALPHA) + best.offset * EMA_ALPHA : best.offset;
    if (this.synced && Math.abs(next - this._offset) > RESTART_FAST_DELTA_MS) this.fast = true;
    this._offset = next;
    this.synced = true;
    if (this.samples.length >= FAST_SAMPLE_COUNT && Math.abs(best.offset - next) <= RESTART_FAST_DELTA_MS) this.fast = false;
    return true;
  }

  /** Ping often at first, less often once stable. */
  nextPingDelay(): number {
    return this.fast || this.samples.length < FAST_SAMPLE_COUNT ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
  }
}
