/**
 * Backup store bookkeeping: status, history, exclusions, removals, run state.
 *
 * The `status.json` SHAPE IS INHERITED, not redesigned. The PowerShell engine
 * wrote `{ method, source, target, lastRun, result, detail, sizeMB, items }`
 * per target and pushed `STATUS.md` to a private GitHub repo. Keeping that
 * shape means the adopted store stays readable by both engines and the existing
 * history on GitHub stays continuous. New fields are additive and optional.
 *
 * WHAT IS ADDED. The PowerShell status showed a last-run timestamp and nothing
 * else — a target that silently stopped running looked identical to one that
 * ran ten minutes ago, because the reader had to do the date arithmetic. So
 * this module computes a STALENESS VERDICT and reports it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BackupConfig, TargetName } from './config';
import { storePaths } from './config';

export interface TargetStatus {
  method: string;
  source: string;
  target: string;
  /** 'yyyy-MM-dd HH:mm:ss' — the inherited format. */
  lastRun: string;
  result: string;
  detail: string;
  sizeMB: number;
  items: number;
  /** Added by this engine: files refused by the capture-time deny-list. */
  secretsExcluded?: number;
  /** Added by this engine: rows written to the search index. */
  indexedRows?: number;
}

export type StatusMap = Partial<Record<TargetName, TargetStatus>>;

export type Staleness = 'fresh' | 'aging' | 'stale' | 'never';

export interface RunState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  targets: TargetName[];
  /** Target currently being captured, for progress reporting. */
  current?: TargetName;
  done: TargetName[];
  failed: TargetName[];
  error?: string;
  dryRun: boolean;
}

export interface Removal {
  at: string;
  id: string;
  kind: string;
  source: string;
  path: string;
  container?: string;
  reason: string;
  excluded: boolean;
  repacked?: boolean;
}

// ---------------------------------------------------------------- timestamps

/** The inherited 'yyyy-MM-dd HH:mm:ss' local-time stamp. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Snapshot filename stamp: 'yyyy-MM-dd_HHmmss'. */
export function runStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * How stale a target is. The thresholds encode intent rather than taste: a
 * daily-ish backup is 'fresh' inside two days, 'aging' inside a week, and
 * 'stale' after that — the point at which "we have a backup" stops being true
 * in any useful sense.
 */
export function staleness(lastRun: string | undefined, now = Date.now()): { verdict: Staleness; ageDays: number } {
  if (!lastRun) return { verdict: 'never', ageDays: -1 };
  const t = Date.parse(lastRun.replace(' ', 'T'));
  if (!Number.isFinite(t)) return { verdict: 'never', ageDays: -1 };
  const ageDays = (now - t) / 86_400_000;
  if (ageDays <= 2) return { verdict: 'fresh', ageDays };
  if (ageDays <= 7) return { verdict: 'aging', ageDays };
  return { verdict: 'stale', ageDays };
}

// ------------------------------------------------------------------- status

export function readStatus(cfg: BackupConfig): StatusMap {
  try {
    const raw = fs.readFileSync(storePaths(cfg).statusJson, 'utf-8');
    // PowerShell's Set-Content -Encoding utf8 writes a BOM; JSON.parse rejects it.
    return JSON.parse(raw.replace(/^﻿/, '')) as StatusMap;
  } catch {
    return {};
  }
}

export function writeStatus(cfg: BackupConfig, status: StatusMap): void {
  const p = storePaths(cfg);
  fs.mkdirSync(path.dirname(p.statusJson), { recursive: true });
  fs.writeFileSync(p.statusJson, JSON.stringify(status, null, 2), 'utf-8');
  fs.writeFileSync(p.statusMd, renderStatusMd(cfg, status), 'utf-8');
}

/** Rewrite STATUS.md — the file that is committed and visible on GitHub. */
export function renderStatusMd(cfg: BackupConfig, status: StatusMap): string {
  const lines: string[] = [
    '# Claude .claude Backup Status',
    '',
    `Updated: ${stamp()}`,
    `Backup root: ${cfg.root}`,
    '',
    '| Host | Method | Last Run | Age | Result | Size (MB) | Items | Secrets excluded |',
    '|------|--------|----------|-----|--------|-----------|-------|------------------|',
  ];
  for (const key of Object.keys(status).sort()) {
    const s = status[key as TargetName];
    if (!s) continue;
    const { verdict, ageDays } = staleness(s.lastRun);
    const age = verdict === 'never' ? 'never' : `${verdict} (${ageDays.toFixed(1)}d)`;
    lines.push(
      `| ${key} | ${s.method} | ${s.lastRun} | ${age} | ${s.result} | ${s.sizeMB} | ${s.items} | ${s.secretsExcluded ?? '—'} |`,
    );
  }
  lines.push(
    '',
    '## How to run',
    '',
    'MCP: `backup_run` (on the collector — `node:"DESKTOP-GDKLATG"`).',
    '',
    '## Secrets',
    '',
    'Credential files are excluded AT CAPTURE — Claude Code OAuth tokens, claude.ai session',
    'cookies, browser profiles, SSH keys and .env files never enter the store. Sessions,',
    'memory, rules and conversations are backed up in full.',
    '',
    '## Restore hints',
    '',
    `- windows-desk: copy ${path.join(cfg.root, 'windows-desk', '.claude')} back to ${cfg.localSource}`,
    '- linux-117 / linux-123: scp the tar.gz over, then: tar xzf claude-<stamp>.tar.gz -C $HOME',
    '',
    '## History',
    '',
    'Full run history: logs/history.log (last 10 below)',
    '',
  );
  for (const line of tailHistory(cfg, 10)) lines.push(`    ${line}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ history

export function appendHistory(cfg: BackupConfig, line: string): void {
  const p = storePaths(cfg).historyLog;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `[${stamp()}] ${line}\n`, 'utf-8');
}

export function tailHistory(cfg: BackupConfig, n: number): string[] {
  try {
    const all = fs.readFileSync(storePaths(cfg).historyLog, 'utf-8').split('\n').filter(Boolean);
    return all.slice(-n);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------- excludes

/**
 * Paths a removal asked never to be captured again.
 *
 * Without this, `backup_remove` on anything inside the `robocopy /MIR` mirror
 * is a no-op that reports success: the next run copies the file straight back
 * from the live `.claude`. The exclusion is what makes removal mean something.
 */
export function readExcludes(cfg: BackupConfig): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(storePaths(cfg).excludes, 'utf-8').replace(/^﻿/, ''));
    return Array.isArray(j?.paths) ? (j.paths as string[]) : [];
  } catch {
    return [];
  }
}

export function addExclude(cfg: BackupConfig, relPath: string): void {
  const cur = readExcludes(cfg);
  if (cur.includes(relPath)) return;
  cur.push(relPath);
  fs.writeFileSync(storePaths(cfg).excludes, JSON.stringify({ paths: cur }, null, 2), 'utf-8');
}

/** True when a user exclusion covers this store-relative path. */
export function isUserExcluded(excludes: string[], relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return excludes.some((e) => {
    const en = e.replace(/\\/g, '/');
    return norm === en || norm.startsWith(`${en}/`);
  });
}

// ----------------------------------------------------------------- removals

/** Append-only removal audit — a backup that can lose things quietly is not one. */
export function appendRemoval(cfg: BackupConfig, r: Removal): void {
  fs.appendFileSync(storePaths(cfg).removals, `${JSON.stringify(r)}\n`, 'utf-8');
}

export function readRemovals(cfg: BackupConfig, limit = 20): Removal[] {
  try {
    const lines = fs.readFileSync(storePaths(cfg).removals, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as Removal).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- run state

export function readRun(cfg: BackupConfig): RunState | null {
  try {
    return JSON.parse(fs.readFileSync(storePaths(cfg).currentRun, 'utf-8')) as RunState;
  } catch {
    return null;
  }
}

export function writeRun(cfg: BackupConfig, run: RunState): void {
  fs.writeFileSync(storePaths(cfg).currentRun, JSON.stringify(run, null, 2), 'utf-8');
}

/** True when a run is recorded as started and not finished. */
export function runInFlight(cfg: BackupConfig): RunState | null {
  const r = readRun(cfg);
  return r && !r.finishedAt ? r : null;
}
