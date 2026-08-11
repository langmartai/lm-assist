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
import { Mission } from './mission-model';
import { isStandby } from './manual-mode';

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

export interface GuardDeps {
  now: number;
  findMission: (sid: string) => Promise<Mission | null>;
  gather: (sid: string, m: Mission) => Promise<ProbeSignals>;
  latch: (m: Mission, reason: ManualReason, now: number) => Promise<void>;
}

/**
 * `mission` on the ok branch is the (possibly null) mission `assertDriveable` already looked
 * up via `deps.findMission` — the caller may reuse it instead of calling `findMission` again
 * for its own post-guard logic (e.g. the onboarded-mission marker-prefix check in
 * `handleSessionDrive`). `null` covers both "no mission owns this session" and "the lookup
 * threw" (fail-open) — callers that need to distinguish those cases already have their own
 * try/catch around their OWN findMission call and don't need to here.
 */
export type GuardResult = { ok: true; mission: Mission | null } | { ok: false; code: 'STANDBY_MODE'; message: string };

function refuse(reason: string): GuardResult {
  return {
    ok: false,
    code: 'STANDBY_MODE',
    message: `session is manually operated (${reason}) — switch manageMode to handoff to drive`,
  };
}

/**
 * Refresh the reaper's idle timer, best-effort, when `assertDriveable` has just
 * observed confirmed human presence on `sid`.
 *
 * Why this is the REACHABLE half of the human-activity → reaper wiring (the other
 * half, `latchOnHumanActivity` in `manual-mode.ts`, is currently inert — see its
 * comment): the reaper only ever tracks sids via `trackResumedNative`, which is
 * called from `handleSessionResume` ONLY on the non-onboarded path (an onboarded
 * mission's session returns before that call — "never enrolled for auto-close").
 * So the population `mission-session-reaper` tracks and the population
 * `assertDriveable` guards for non-onboarded missions are the same population.
 * A standby refusal or a manual-control verdict here is exactly the human-presence
 * signal the reaper needs to not kill a session mid-use.
 *
 * Best-effort and silent: `touchActivity`'s own `if (entry)` guard makes this a
 * no-op for sids the reaper never tracked (onboarded, cloud, or already closed) —
 * that is expected, not an error. Must never affect the guard's verdict either way.
 */
function touchReaperActivity(sid: string, now: number): void {
  try {
    const { touchActivity } = require('./mission-session-reaper') as typeof import('./mission-session-reaper');
    touchActivity(sid, now);
  } catch { /* best-effort */ }
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
    return { ok: true, mission: null };            // unknown ownership → not ours to refuse
  }
  if (!m) return { ok: true, mission: null };      // no mission owns this session
  if (isStandby(m)) {
    // Already-latched standby, observed again: still a confirmed human-presence
    // signal for a possibly-tracked sid. See touchReaperActivity for why this is
    // the reachable path.
    touchReaperActivity(sid, deps.now);
    return refuse('standby');
  }

  let verdict: { manual: boolean; reason?: ManualReason };
  try {
    verdict = classifyManualControl(await deps.gather(sid, m), deps.now);
  } catch {
    return { ok: true, mission: m };            // fail open
  }
  if (!verdict.manual || !verdict.reason) return { ok: true, mission: m };

  // Confirmed human control detected right now — refresh the reaper timer before
  // the (best-effort, possibly-throwing) latch, so a latch failure can never
  // suppress the touch.
  touchReaperActivity(sid, deps.now);
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
  let tmuxAttached: boolean | undefined;
  try { tmuxAttached = tmuxMod.getState(v.tmuxSession).attached; } catch { /* leave undefined */ }

  // I3: `hasAttachedTtyd` comes from the process-status cache, which is EMPTY on first use
  // and periodically refreshed — a cold Core or a stale-cache window finds no record at all
  // (not "found, not ours": genuinely NO EVIDENCE either way). Classifier rule 1 fires on
  // `attached === true && hasAttachedTtyd !== true`, and `undefined !== true`, so leaving
  // `attached` populated from tmux while the process side stayed empty free-fires
  // 'human-attached' on a perfectly healthy managed session — and that latch (`manageMode:
  // 'standby'`) is reversible ONLY by a human. Half-evidence must never trigger a
  // human-only-reversible latch, so when no process record is found at all, withhold
  // `attached` too: the pair then reads as "no evidence" and rule 1 cannot fire, same as an
  // all-undefined ProbeSignals falls through to `{ manual: false }`.
  let procFound = false;
  try {
    const { getProcessStatusStore } = require('../process-status-store') as typeof import('../process-status-store');
    const proc = getProcessStatusStore().getCachedProcesses().find((p) => p.tmuxSessionName === v.tmuxSession);
    if (proc) { procFound = true; out.hasAttachedTtyd = proc.hasAttachedTtyd; out.managedBy = proc.managedBy; out.source = proc.source; }
  } catch { /* leave undefined */ }
  out.attached = procFound ? tmuxAttached : undefined;

  try {
    const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
    out.pane = (await backend.tmuxTerminalBackend.capture(v.tmuxSession)).text;
  } catch { /* leave undefined */ }

  return out;
}
