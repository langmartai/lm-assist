// Resume a mission's bound worker session IN PLACE (same session, preserved context).
// Pure decision functions here; the I/O orchestrator (resumeWorker) is added in Task 2.

/** Terminal cloud session statuses (mirrors mission-controller.ts / mission.routes.ts). */
export const TERMINAL_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived'];

export type ResumeReason = 'ok' | 'alive' | 'gone' | 'conflict' | 'status-unknown';

export interface ResumeResult {
  resumed: boolean;
  transport: 'cloud' | 'native';
  sid: string;
  reason: ResumeReason;
  note?: string;
}

/**
 * Decide what to do with a CLOUD worker, from its cloudStatus.
 *  'gone'  — terminal status, unrecoverable (respawn is a separate explicit action).
 *  'noop'  — alive and actively running; nothing to do.
 *  'wake'  — alive but idle/disconnected; re-drive with reBootstrap to continue.
 */
export function decideCloudResume(s: { status: string; workerStatus?: string }): 'noop' | 'wake' | 'gone' {
  if (TERMINAL_CLOUD_STATUSES.includes(s.status)) return 'gone';
  return s.workerStatus === 'running' ? 'noop' : 'wake';
}

/**
 * Decide what to do with a NATIVE worker, from its sessionVerdict.
 *  'attach'  — already live in a tmux; just re-read/attach.
 *  'resume'  — process dead but transcript present + safe → `claude --resume` + re-bridge.
 *  'conflict'— live but not in a tmux; a `--resume` would double-write the jsonl → refuse.
 *  'gone'    — no transcript; unrecoverable.
 */
export function decideNativeResume(v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean }): 'attach' | 'resume' | 'conflict' | 'gone' {
  if (v.connectStrategy === 'attach-existing' || v.inTmux) return 'attach';
  if (v.connectStrategy === 'create-tmux' && v.safeToCreateTmux) return 'resume';
  if (v.connectStrategy === 'refuse') return 'conflict';
  return 'gone';
}
