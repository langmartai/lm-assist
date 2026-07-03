/**
 * Best-path restoration + anti-flap (spec T7.4). Downgrade is instant/per-attempt
 * (handled by the retry ladder). UPGRADE back to a better path is deliberate:
 * it needs consecutive probe confirmations, a minimum dwell time between
 * switches, and — for links that have flapped — exponentially more confirmations.
 * Pure decision (decideSwitch) + a fold (applyProbe) + a thin supervisor loop.
 */
export interface FlapState { consecutiveOk: number; lastSwitchAt: number; flapCount: number; }
export interface SwitchOpts { minConfirms?: number; minIntervalMs?: number; now: number; }

const MAX_FLAP_EXP = 5; // cap the exponential confirmation window

export function requiredConfirms(state: FlapState, minConfirms: number): number {
  return minConfirms * 2 ** Math.min(state.flapCount, MAX_FLAP_EXP);
}

export function decideSwitch(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { switch: boolean; reason: string } {
  const minConfirms = opts.minConfirms ?? 2;
  const minIntervalMs = opts.minIntervalMs ?? 30_000;
  if (!betterAvailable) return { switch: false, reason: 'no better path' };
  if (opts.now - state.lastSwitchAt < minIntervalMs) return { switch: false, reason: 'min interval not elapsed' };
  const need = requiredConfirms(state, minConfirms);
  if (state.consecutiveOk < need) return { switch: false, reason: `need ${need} confirms, have ${state.consecutiveOk}` };
  return { switch: true, reason: 'confirmed' };
}

export function applyProbe(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { state: FlapState; switched: boolean } {
  const next: FlapState = { ...state, consecutiveOk: betterAvailable ? state.consecutiveOk + 1 : 0 };
  const d = decideSwitch(next, betterAvailable, opts);
  if (!d.switch) return { state: next, switched: false };
  return { state: { consecutiveOk: 0, lastSwitchAt: opts.now, flapCount: state.flapCount + 1 }, switched: true };
}

export class PathSupervisor {
  private state: FlapState = { consecutiveOk: 0, lastSwitchAt: 0, flapCount: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private stats = { upgrades: 0, downgrades: 0, flaps: 0 };
  constructor(private deps: { probeBetter: () => Promise<boolean>; onSwitch: () => void; now?: () => number; intervalMs?: number }) {}

  async tick(): Promise<void> {
    let better: boolean;
    try { better = await this.deps.probeBetter(); } catch { return; }
    const now = (this.deps.now ?? (() => Date.now()))();
    const r = applyProbe(this.state, better, { now });
    this.state = r.state;
    if (r.switched) { this.stats.upgrades++; this.stats.flaps = this.state.flapCount; this.deps.onSwitch(); }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? 30_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  counters(): { upgrades: number; downgrades: number; flaps: number } { return { ...this.stats }; }
}
