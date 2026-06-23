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
  maxAttempts: number; // cap before giving up (default 6)
}

export type StallAction = 'nudge' | 'wait' | 'giveup' | 'reset';

/** Widening schedule: 5,5,10,10,15,15,… minutes. */
export function backoffMinutes(step: number, intervalMin: number): number {
  return (Math.floor(step / 2) + 1) * intervalMin;
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

  if (rec.attempts >= cfg.maxAttempts) {
    return { action: 'giveup', next: { ...rec, gaveUp: true } };
  }

  const dueAt = rec.lastNudgeAt + backoffMinutes(rec.backoffStep, cfg.intervalMin) * 60_000;
  if (now < dueAt) return { action: 'wait', next: rec };

  return {
    action: 'nudge',
    next: { ...rec, attempts: rec.attempts + 1, lastNudgeAt: now, backoffStep: rec.backoffStep + 1 },
  };
}
