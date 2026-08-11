/**
 * Active detection: is somebody OTHER than Mission Control on this session right now?
 *
 * Pure classifier over injected signals — the IO that gathers them lives in
 * `gatherProbeSignals` (Task 6) so this stays trivially testable.
 *
 * Ordered cheapest-first and short-circuits, because the caller runs it before
 * every session write.
 */
import { composerIsNonEmpty, paneShowsQueuedMessage } from '../terminal/cc';

export type ManualReason = 'human-attached' | 'human-terminal' | 'human-typing' | 'foreign-driver';

export interface ProbeSignals {
  /** tmux `#{session_attached}` for this session's tmux; undefined when not tmux-hosted. */
  attached?: boolean;
  /** true when one of OUR ttyd instances is bound to that tmux session. */
  hasAttachedTtyd?: boolean;
  managedBy?: string;
  source?: string;
  /** Captured pane text; undefined when the session is not capturable. */
  pane?: string;
  /** Timestamp of the last `user`-role message in the transcript. */
  lastUserMessageAt?: number;
  /** Timestamp of the last write lm-assist itself made to this session. */
  lastSelfDriveAt?: number;
}

/** How long after our own drive a user message still counts as ours. Covers the gap
 *  between the audit append and the transcript write. */
export const ATTRIBUTION_SKEW_MS = 10_000;

export function classifyManualControl(s: ProbeSignals, _now: number): { manual: boolean; reason?: ManualReason } {
  // 1 — a tmux client that is not our ttyd. Free: both values are already collected.
  //
  // 🔴 lm-assist's own ttyd attaches to tmux AS A CLIENT, so `attached === true` alone
  // would read every open web console tab as a human. This cross-reference is the
  // whole point — do not simplify it to `attached === true`.
  if (s.attached === true && s.hasAttachedTtyd !== true) {
    return { manual: true, reason: 'human-attached' };
  }
  // 2 — a tmux we did not create. Free: same warm store.
  if (s.managedBy === 'unmanaged-tmux' && s.source === 'external-terminal') {
    return { manual: true, reason: 'human-terminal' };
  }
  // 3+4 — someone has typed, or submitted while we were busy. One capture-pane.
  if (s.pane) {
    if (composerIsNonEmpty(s.pane)) return { manual: true, reason: 'human-typing' };
    if (paneShowsQueuedMessage(s.pane)) return { manual: true, reason: 'human-typing' };
  }
  // 5 — attribution: input exists that we did not send.
  //
  // 🔴 Deliberately keyed on the last USER-role message, NOT on jsonl mtime. A driven
  // turn keeps appending to the transcript for the whole assistant response — often
  // minutes — so mtime would read as a foreign driver during our own long turns.
  if (s.lastUserMessageAt !== undefined) {
    const ours = s.lastSelfDriveAt !== undefined
      && s.lastUserMessageAt <= s.lastSelfDriveAt + ATTRIBUTION_SKEW_MS;
    if (!ours) return { manual: true, reason: 'foreign-driver' };
  }
  // Absence of evidence is not evidence: all-undefined signals fall through to here.
  return { manual: false };
}
