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
  /**
   * Timestamp of the last write lm-assist itself made to this session.
   *
   * 🔴 This must be stamped on EVERY Mission Control write route (drive/answer/control/
   * resume — anywhere lm-assist sends input to the session), not just the obvious ones.
   * A route that writes without stamping this leaves signal 5 (`classifyManualControl`
   * rule 5, attribution) with no `lastSelfDriveAt` to compare against — the very next
   * transcript append from OUR OWN drive then reads as `lastUserMessageAt` with nothing
   * "ours" to attribute it to, so the classifier free-fires 'foreign-driver' and
   * misclassifies our own drive as a human's. As of Task 6, `gatherProbeSignals` leaves
   * this undefined (see its comment) — signal 5 is not wired to production yet, so this
   * is prospective: whichever task wires it MUST stamp every write path, not a subset.
   */
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

// ---------------------------------------------------------------------------
// assertDriveable — the single choke point every session WRITE calls first
// ---------------------------------------------------------------------------
import { Mission } from './mission-model';
import { isStandby } from './manual-mode';

export interface GuardDeps {
  now: number;
  findMission: (sid: string) => Promise<Mission | null>;
  gather: (sid: string, m: Mission) => Promise<ProbeSignals>;
  latch: (m: Mission, reason: ManualReason, now: number) => Promise<void>;
}

export type GuardResult = { ok: true } | { ok: false; code: 'STANDBY_MODE'; message: string };

function refuse(reason: string): GuardResult {
  return {
    ok: false,
    code: 'STANDBY_MODE',
    message: `session is manually operated (${reason}) — switch manageMode to handoff to drive`,
  };
}

/**
 * The single gate every session WRITE passes through.
 *
 * Order matters: the flag is checked first because it is free and authoritative.
 * The probe only runs for a mission that is not already latched.
 *
 * 🔴 Fails OPEN. A probe that throws must never make every mission session
 * permanently undriveable — that would convert a transient tmux error into a
 * fleet-wide outage.
 */
export async function assertDriveable(sid: string, deps: GuardDeps): Promise<GuardResult> {
  let m: Mission | null = null;
  try {
    m = await deps.findMission(sid);
  } catch {
    return { ok: true };            // unknown ownership → not ours to refuse
  }
  if (!m) return { ok: true };      // no mission owns this session
  if (isStandby(m)) return refuse('standby');

  let verdict: { manual: boolean; reason?: ManualReason };
  try {
    verdict = classifyManualControl(await deps.gather(sid, m), deps.now);
  } catch {
    return { ok: true };            // fail open
  }
  if (!verdict.manual || !verdict.reason) return { ok: true };

  try { await deps.latch(m, verdict.reason, deps.now); } catch { /* best-effort */ }
  return refuse(verdict.reason);
}

// ---------------------------------------------------------------------------
// gatherProbeSignals — the IO that feeds the classifier for a live session
// ---------------------------------------------------------------------------

/**
 * Collect the live signals for one session. Native/tmux only.
 *
 * 🔴 Cloud sessions (sid matching /^(cse_|session_)/) have no tmux and no local
 * transcript, so this returns {} for them and the classifier says "not manual".
 * Cloud protection is the explicit-flag path only — see the spec's Risks section.
 *
 * `lastUserMessageAt` / `lastSelfDriveAt` (signal 5, attribution) are deliberately
 * left undefined here: the passive layer already parses the transcript, and parsing
 * it a second time here would be wasteful. That means signal 5 does NOT fire in
 * production yet — `classifyManualControl` treats an all-undefined pair as "no
 * evidence" and falls through, so this is a silent gap, not a crash. It stays open
 * until a future task wires the passive layer's parsed timestamps in here (and, per
 * the warning on `lastSelfDriveAt` above, stamps it on every write route first).
 */
export async function gatherProbeSignals(sid: string): Promise<ProbeSignals> {
  if (/^(cse_|session_)/.test(sid)) return {};

  const { sessionVerdict } = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
  const v = sessionVerdict(sid);
  if (!v.tmuxSession) return {};

  const out: ProbeSignals = {};

  const tmuxMod = require('../terminal/tmux') as typeof import('../terminal/tmux');
  try { out.attached = tmuxMod.getState(v.tmuxSession).attached; } catch { /* leave undefined */ }

  try {
    const { getProcessStatusStore } = require('../process-status-store') as typeof import('../process-status-store');
    const proc = getProcessStatusStore().getCachedProcesses().find((p) => p.tmuxSessionName === v.tmuxSession);
    if (proc) { out.hasAttachedTtyd = proc.hasAttachedTtyd; out.managedBy = proc.managedBy; out.source = proc.source; }
  } catch { /* leave undefined */ }

  try {
    const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
    out.pane = (await backend.tmuxTerminalBackend.capture(v.tmuxSession)).text;
  } catch { /* leave undefined */ }

  return out;
}
