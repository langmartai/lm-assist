/** Pure retry/backoff state machine for one stalled session. No IO. */

export interface StallRecord {
  attempts: number;
  lastNudgeAt: number; // epoch ms of the last `continue` sent
  category: string; // the classified ScreenState at last detection
  backoffStep: number; // index into the widening schedule
  gaveUp: boolean;
}

export interface StallConfig {
  intervalMin: number; // base interval (default 5)
  maxAttempts: number; // cap before giving up (only used when neverGiveUp is false)
  maxIntervalMin?: number; // cap the widening backoff at this many minutes (default: uncapped)
  neverGiveUp?: boolean; // keep retrying forever at the capped interval (default: true)
}

export type StallAction = 'nudge' | 'wait' | 'giveup' | 'reset';

/** Widening schedule: 5,5,10,10,15,15,… minutes, optionally capped at maxIntervalMin
 *  so waits grow (don't hammer) but stay responsive when the outage clears. */
export function backoffMinutes(step: number, intervalMin: number, maxIntervalMin?: number): number {
  const mins = (Math.floor(step / 2) + 1) * intervalMin;
  return maxIntervalMin && maxIntervalMin > 0 ? Math.min(mins, maxIntervalMin) : mins;
}

export function planStallAction(
  rec: StallRecord | undefined,
  opts: { now: number; stillStalled: boolean; seenProgress: boolean; cfg: StallConfig },
): { action: StallAction; next: StallRecord | null } {
  const { now, stillStalled, seenProgress, cfg } = opts;

  // It recovered (a new turn appeared / left the stall after a nudge) → forget it.
  if (seenProgress) return { action: 'reset', next: null };

  // Not currently stalled and no record yet → nothing to do.
  if (!stillStalled) return { action: 'wait', next: rec ?? null };

  // Stalled, no record → first nudge.
  if (!rec) {
    return { action: 'nudge', next: { attempts: 1, lastNudgeAt: now, category: 'unknown', backoffStep: 0, gaveUp: false } };
  }

  if (rec.gaveUp) return { action: 'wait', next: rec };

  // Default policy: never permanently give up — keep retrying at the capped, widened
  // interval so a long outage (internet down for hours) still recovers the moment it
  // clears. Only bounded by maxAttempts when neverGiveUp is explicitly turned off.
  const neverGiveUp = cfg.neverGiveUp ?? true;
  if (!neverGiveUp && rec.attempts >= cfg.maxAttempts) {
    return { action: 'giveup', next: { ...rec, gaveUp: true } };
  }

  const dueAt = rec.lastNudgeAt + backoffMinutes(rec.backoffStep, cfg.intervalMin, cfg.maxIntervalMin) * 60_000;
  if (now < dueAt) return { action: 'wait', next: rec };

  return {
    action: 'nudge',
    next: { ...rec, attempts: rec.attempts + 1, lastNudgeAt: now, backoffStep: rec.backoffStep + 1 },
  };
}
