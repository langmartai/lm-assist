/**
 * Controller lineage tracking — the mission controller is a DURABLE IDENTITY.
 *
 * Every lifecycle event (launched / resumed / adopted / teardown) is appended
 * to a plain node-local JSONL in the controller workspace. At every start path
 * — core boot, restart, teardown-relaunch, failover — the launcher consults
 * this history and RESUMES the most recent usable controller session (full
 * transcript + context preserved) instead of minting a fresh one. A fresh
 * session happens only when no usable history exists.
 *
 * Deliberately a LOCAL FILE, not a data-service dataset: the whole
 * controller-recycled-at-boot incident traced back to fleet state being
 * unreadable during early boot. The lineage must be readable at any point in
 * the process lifecycle with nothing warmed up.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ControllerHistoryEntry {
  at: number;
  event: 'launched' | 'resumed' | 'adopted' | 'teardown' | 'resume-failed';
  sessionId?: string | null;
  tmux?: string | null;
  cse?: string | null;
  node?: string | null;
  reason?: string;
}

const FILE = 'controller-history.jsonl';
const MAX_LINES = 500;
const TRIM_TO = 250;

function historyPath(dir: string): string { return path.join(dir, FILE); }

/** Append an event — best-effort, never throws (lineage is advisory). */
export function recordControllerEvent(dir: string, entry: ControllerHistoryEntry): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = historyPath(dir);
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
    // Bound the file: rewrite the newest TRIM_TO lines once it grows past MAX_LINES.
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(p, lines.slice(-TRIM_TO).join('\n') + '\n');
  } catch { /* advisory */ }
}

export function readControllerHistory(dir: string, limit = 200): ControllerHistoryEntry[] {
  try {
    const lines = fs.readFileSync(historyPath(dir), 'utf-8').split('\n').filter(Boolean).slice(-limit);
    const out: ControllerHistoryEntry[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
    return out;
  } catch {
    return [];
  }
}

/**
 * Pure: candidate sessionIds to resume, NEWEST first, deduped. An entry
 * counts when it put a session IN CHARGE (launched/resumed/adopted). A
 * 'resume-failed' newer than a candidate's last in-charge event disqualifies
 * it (broken transcript / repeated failure — fall through to older or fresh).
 */
export function pickResumeCandidates(history: ControllerHistoryEntry[]): string[] {
  const failedAfter = new Map<string, number>();
  const lastInCharge = new Map<string, number>();
  for (const e of history) {
    if (!e.sessionId) continue;
    if (e.event === 'resume-failed') failedAfter.set(e.sessionId, Math.max(failedAfter.get(e.sessionId) ?? 0, e.at));
    if (e.event === 'launched' || e.event === 'resumed' || e.event === 'adopted') {
      lastInCharge.set(e.sessionId, Math.max(lastInCharge.get(e.sessionId) ?? 0, e.at));
    }
  }
  return [...lastInCharge.entries()]
    .filter(([sid, at]) => (failedAfter.get(sid) ?? 0) <= at)
    .sort((a, b) => b[1] - a[1])
    .map(([sid]) => sid);
}

/**
 * IO: the sessionId the launcher should `claude --resume`, or null for a
 * fresh session. `verdict` reports whether a session's transcript exists and
 * is safe to resume as sole writer (sessionVerdict-shaped).
 */
export function latestResumableController(
  dir: string,
  verdict: (sid: string) => { jsonl?: string | null; live: boolean; safeToCreateTmux: boolean },
): string | null {
  for (const sid of pickResumeCandidates(readControllerHistory(dir))) {
    try {
      const v = verdict(sid);
      // Dead with an existing transcript and no other writer → resumable.
      if (v.jsonl && !v.live && v.safeToCreateTmux) return sid;
    } catch { /* try the next candidate */ }
  }
  return null;
}
