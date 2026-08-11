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

  // A human working in this session must never look idle to the reaper.
  //
  // 🔴 CURRENTLY A NO-OP. This function has exactly one production caller —
  // mission-controller.ts's `readSignal`, gated on `m.origin === 'onboarded'` — and
  // the reaper only ever tracks a sid via `trackResumedNative`, which
  // `handleSessionResume` (mission.routes.ts) calls ONLY on the NON-onboarded path
  // ("user session: never enrolled for auto-close" — it returns before
  // `trackResumedNative` for an onboarded mission). So every sid reaching this call
  // is, by construction, never in the reaper's `tracked` map: `touchActivity`'s own
  // `if (entry)` guard makes it a guaranteed no-op today. Left in place — call is
  // harmless and becomes correct for free if onboarded sessions are ever enrolled —
  // but do not read this as working coverage. The reachable half of this fix lives
  // in `assertDriveable` (`manual-probe.ts`), which runs for the non-onboarded
  // population the reaper actually tracks. Best-effort either way: must never break
  // the latch itself if the reaper module is unavailable or throws.
  const sid = m.binding?.sessionId;
  if (sid) {
    try {
      const { touchActivity } = require('./mission-session-reaper') as typeof import('./mission-session-reaper');
      touchActivity(sid, now);
    } catch { /* best-effort */ }
  }

  const already = isStandby(m);
  if (!already) m.manageMode = 'standby';

  // Strip the output so this tick cannot classify as material.
  const quiet: HumanSignal = { ...sig, newLines: [] };
  return { latched: !already, reason: 'human-input', signal: quiet };
}

/**
 * Expire the ACTIVITY of a long-quiet standby mission — not its latch.
 *
 * A latch is sticky by design, so without this every session anyone ever touched
 * accumulates as a permanently "active" mission. Pausing drops it from
 * `selectActive` for free.
 *
 * 🔴 `manageMode` is deliberately left at 'standby'. An idle timer must never be
 * the thing that hands a session back to the controller: someone who stepped away
 * for a day would return to find it had been driven in their absence. Waking a
 * mission stays a human action.
 */
export function expireIdleStandby(missions: Mission[], now: number, idleMin: number): Mission[] {
  const idleMs = idleMin * 60_000;
  const changed: Mission[] = [];
  for (const m of missions) {
    if (!isStandby(m)) continue;
    if (m.status !== 'active' && m.status !== 'waiting') continue;
    const last = m.control?.lastHumanInputAt;
    if (last === undefined) continue;          // never observed a human — do not guess
    if (now - last <= idleMs) continue;
    m.status = 'paused';
    changed.push(m);
  }
  return changed;
}
