/** RFC 6298 RTT/RTO estimator with a LAN-appropriate low floor. Pure. */
export class RttEstimator {
  private srttMs: number | null = null;
  private rttvarMs = 0;
  private readonly minRtoMs: number;
  private readonly maxRtoMs: number;
  private readonly initialRtoMs = 300;
  constructor(opts: { minRtoMs?: number; maxRtoMs?: number } = {}) {
    this.minRtoMs = opts.minRtoMs ?? 40;
    this.maxRtoMs = opts.maxRtoMs ?? 4000;
  }
  sample(rttMs: number): void {
    const r = Math.max(0, rttMs);
    if (this.srttMs === null) { this.srttMs = r; this.rttvarMs = r / 2; }
    else {
      this.rttvarMs = 0.75 * this.rttvarMs + 0.25 * Math.abs(this.srttMs - r);
      this.srttMs = 0.875 * this.srttMs + 0.125 * r;
    }
  }
  srtt(): number | null { return this.srttMs; }
  rto(): number {
    if (this.srttMs === null) return this.initialRtoMs;
    const raw = this.srttMs + Math.max(1, 4 * this.rttvarMs);
    return Math.min(this.maxRtoMs, Math.max(this.minRtoMs, Math.round(raw)));
  }
}
