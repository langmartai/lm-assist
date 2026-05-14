/**
 * Append-only audit log for terminal mutations.
 *
 * Why: every mutation (createTab, sendKeys, ccLaunch, ccPivot, deleteTab) gets
 * a JSONL line. Forensic trail for "what did the API do at 13:42:17" without
 * relying on memory or process logs.
 *
 * Format: one JSON object per line. Schema is intentionally simple — the
 * fields are universal (op, session, outcome, elapsedMs, error?).
 *
 * Storage: ~/.cache/lm-assist/terminal-audit-{YYYY-MM-DD}.jsonl
 *   Date-rolled by UTC day. Old files stay around (no automatic rotation
 *   here; if you want it, rotate via cron).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AUDIT_DIR = path.join(os.homedir(), '.cache', 'lm-assist');

export interface AuditEvent {
  ts: string;                 // ISO timestamp
  op: string;                 // 'createTab' | 'sendKeys' | 'ccLaunch' | ...
  session?: string | null;    // tmux session name or null
  outcome: 'ok' | 'error';
  elapsedMs: number;
  /** Caller-provided context (e.g. 'engine-v6:NAS100', 'manual'). */
  caller?: string;
  /** Op-specific fields. Keep small — avoid logging full screens or prompts. */
  details?: Record<string, unknown>;
  /** Error code for the typed TerminalError union, if outcome=error. */
  errorCode?: string;
  errorMessage?: string;
}

function fileForDate(d: Date = new Date()): string {
  const day = d.toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `terminal-audit-${day}.jsonl`);
}

function ensureDir(): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

export function audit(ev: AuditEvent): void {
  // Fire-and-forget but synchronous to disk — appending one short line is
  // cheap, and we want the line on disk before the API returns.
  try {
    ensureDir();
    fs.appendFileSync(fileForDate(), JSON.stringify(ev) + '\n');
  } catch {
    // Audit failures must not break the API. Last-resort: drop the event.
  }
}

/**
 * Wrap a mutation in an audit envelope. Auto-times, auto-categorizes.
 * Re-throws after logging so callers see the original error.
 */
export async function withAudit<T>(
  partial: Pick<AuditEvent, 'op' | 'session' | 'caller' | 'details'>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    audit({
      ts: new Date().toISOString(),
      ...partial,
      outcome: 'ok',
      elapsedMs: Date.now() - start,
    });
    return result;
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    audit({
      ts: new Date().toISOString(),
      ...partial,
      outcome: 'error',
      elapsedMs: Date.now() - start,
      errorCode: err.code,
      errorMessage: err.message,
    });
    throw e;
  }
}
