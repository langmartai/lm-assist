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
