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
  if (who && isControllerActor(who)) {
    return { ok: false, code: 'FORBIDDEN', message: 'manageMode is human-only — ask the user to switch it' };
  }
  m.manageMode = value as ManageMode;
  return { ok: true };
}
