/** Audit journal for third-party tool calls (contract §8; design §Security 7).
 *
 *  Records WHAT ran, not WHAT WITH: arguments are reduced to a digest so the journal
 *  can be read freely without becoming a secondary leak of whatever a caller passed
 *  (API keys, instrument names, prompts). */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pluginAuditFile } from './paths';

export type PluginCallOutcome = 'ok' | 'error' | 'timeout' | 'refused' | 'truncated' | 'spawn_failed';

export interface PluginAuditEntry {
  ts: string;
  plugin: string;
  tool: string;
  /** sha256 of the canonicalised arguments, truncated — identity without content. */
  argDigest: string;
  durationMs: number;
  outcome: PluginCallOutcome;
  truncated?: boolean;
  timedOut?: boolean;
  resultBytes?: number;
  /** Short reason for a non-ok outcome. Never contains argument values. */
  reason?: string;
}

const MAX_AUDIT_BYTES = 4 * 1024 * 1024;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Stable identity for a call's arguments — never reversible to their values. */
export function argDigest(args: unknown): string {
  return crypto.createHash('sha256').update(canonical(args ?? {}), 'utf8').digest('hex').slice(0, 16);
}

export function appendPluginAudit(entry: PluginAuditEntry, opts: { auditFile?: string } = {}): void {
  const file = opts.auditFile ?? pluginAuditFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Coarse rotation: the journal is an operational tail, not an archive.
    try {
      if (fs.statSync(file).size > MAX_AUDIT_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* absent => nothing to rotate */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    /* auditing must never break a call */
  }
}

export function readPluginAudit(
  opts: { auditFile?: string; plugin?: string; limit?: number } = {},
): PluginAuditEntry[] {
  const file = opts.auditFile ?? pluginAuditFile();
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out: PluginAuditEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as PluginAuditEntry;
      if (opts.plugin && e.plugin !== opts.plugin) continue;
      out.push(e);
    } catch { /* skip a torn line */ }
  }
  const limit = opts.limit ?? 200;
  return out.slice(-limit);
}
