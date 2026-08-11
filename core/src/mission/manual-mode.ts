/**
 * Manual-operation mode: the flag that says "a human is running this session,
 * Mission Control must not write to it".
 *
 * `manageMode` was previously onboarded-only. It is now valid on every mission,
 * because any mission session can be taken over by a person. `undefined` means
 * 'handoff' so existing missions are unaffected.
 *
 * Writing it stays HUMAN-ONLY: the controller must never be able to hand a
 * session back to itself. That is the whole point of the flag.
 */
import { Mission, MissionActor, ManageMode } from './mission-model';
import { isControllerActor } from './workflow-model';

export type ApplyResult = { ok: true } | { ok: false; code: string; message: string };

/** True when Mission Control must not write to this mission's session. */
export function isStandby(m: Pick<Mission, 'manageMode'>): boolean {
  return m.manageMode === 'standby';
}

/** Validate + apply a manageMode change. Mutates `m` only on success. */
export function applyManageMode(m: Mission, value: string, who: MissionActor | undefined): ApplyResult {
  if (value !== 'handoff' && value !== 'standby') {
    return { ok: false, code: 'INVALID_INPUT', message: 'manageMode must be handoff|standby' };
  }
  // Fail CLOSED on an unidentifiable caller: a safety gate that only checks a
  // *known* controller and lets an absent/unresolved actor through would let anything
  // impersonating "no actor" bypass the human-only rule. Refuse it, same code as the
  // controller case, with a message naming the real reason (unknown, not "controller").
  if (!who) {
    return { ok: false, code: 'FORBIDDEN', message: 'manageMode is human-only — caller identity is unknown, refusing' };
  }
  if (isControllerActor(who)) {
    return { ok: false, code: 'FORBIDDEN', message: 'manageMode is human-only — ask the user to switch it' };
  }
  m.manageMode = value as ManageMode;
  return { ok: true };
}

export interface HumanSignal {
  alive: boolean;
  gated: boolean;
  cursor: number;
  newLines: string[];
  humanActive: boolean;
}

/**
 * Latch a mission to standby when a human is detected in its session.
 *
 * 🔴 POLARITY. Before 2026-08-11 this path did the opposite: it prepended a
 * '⟦WORKER-STATUS⟧ human-activity' line, which STATUS_MARKER_RE classifies as
 * MATERIAL — so a person typing DROVE the controller to inject on top of them.
 * The returned signal deliberately carries no marker and no newLines, so
 * classifyExecutorActivity sees nothing to act on.
 *
 * This writes `m.manageMode = 'standby'` directly rather than going through
 * `applyManageMode` — that function enforces human-only writes because its whole
 * point is to stop the controller handing a session back to ITSELF (standby →
 * handoff). This call is the opposite direction: the SYSTEM setting standby,
 * which only ever REDUCES the controller's power over the session. That
 * direction is safe for anyone (including the system) to take unilaterally;
 * only the reverse (standby → handoff) must stay gated to a human actor.
 */
export function latchOnHumanActivity(
  m: Mission,
  sig: HumanSignal,
  now: number,
): { latched: boolean; reason?: string; signal: HumanSignal } {
  if (!sig.humanActive) return { latched: false, signal: sig };

  // Advance the idle clock on EVERY human message, latched or not — Task 6 expires
  // the latch off this timestamp, and a person still typing must never expire.
  m.control.lastHumanInputAt = now;

  const already = isStandby(m);
  if (!already) m.manageMode = 'standby';

  // Strip the output so this tick cannot classify as material.
  const quiet: HumanSignal = { ...sig, newLines: [] };
  return { latched: !already, reason: 'human-input', signal: quiet };
}
