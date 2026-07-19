/**
 * Mission-control CONTROL JOURNAL — the tractability layer.
 *
 * The controller lineage (controller-history.jsonl) answers "WHICH session is
 * the controller"; this journal answers "WHAT has the control process been
 * doing and WHY": every material supervisor decision with its full inputs
 * (election verdict + flags, streak, liveness, cadence), every drive with its
 * transport and outcome, lifecycle events, election flips, and a boot marker.
 *
 * When anything goes wrong, this is the trace you diagnose and recover from —
 * previously that reconstruction took grepping core-prod.log for bare
 * "supervisor action=x" lines with no timestamps, inputs, or reasons.
 *
 * Same storage discipline as the lineage: a plain node-local bounded JSONL in
 * the controller workspace, readable at any point of boot with nothing warmed.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ControlJournalEntry {
  at: number;
  kind: 'boot' | 'tick' | 'drive' | 'lifecycle' | 'election';
  [k: string]: unknown;
}

const FILE = 'control-journal.jsonl';
const MAX_LINES = 1000;
const TRIM_TO = 500;

function journalPath(dir: string): string { return path.join(dir, FILE); }

/** Append — best-effort, never throws (the journal is advisory). */
export function recordControl(dir: string, entry: ControlJournalEntry): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = journalPath(dir);
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(p, lines.slice(-TRIM_TO).join('\n') + '\n');
  } catch { /* advisory */ }
}

export function readControlJournal(dir: string, limit = 200): ControlJournalEntry[] {
  try {
    const lines = fs.readFileSync(journalPath(dir), 'utf-8').split('\n').filter(Boolean).slice(-limit);
    const out: ControlJournalEntry[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
    return out;
  } catch {
    return [];
  }
}

// ── Journal CONSUMERS — the control loop reads its own traces ────────────────
// (runSupervisorTick pulls these each tick via the recentJournal dep.)

/**
 * Pure: consecutive FAILED drives to `sid` counting back from the most recent
 * drive event (any successful drive resets the streak). A live-looking
 * controller that stops accepting drives is wedged — the loop treats a streak
 * ≥ threshold as not-live and relaunches (lossless: resume-first lineage).
 */
export function driveFailureStreak(entries: ControlJournalEntry[], sid: string): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind !== 'drive' || e.sid !== sid) continue;
    if (e.ok === true) break;
    streak += 1;
  }
  return streak;
}

/**
 * Pure: lifecycle launches/resumes recorded within the window. A high count
 * means the loop is churning (launch → die → launch …) — back off instead of
 * feeding the loop (the "9 controllers in 18 minutes" class of runaway).
 */
export function recentLaunchCount(entries: ControlJournalEntry[], now: number, windowMs = 10 * 60_000): number {
  return entries.filter((e) => e.kind === 'lifecycle' && (e.event === 'launched' || e.event === 'resumed') && now - e.at <= windowMs).length;
}
