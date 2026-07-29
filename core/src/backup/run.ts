/**
 * Run orchestration and the status report.
 *
 * A RUN IS ASYNCHRONOUS ON PURPOSE. A full pass re-pulls a ~2 GB snapshot from
 * 117 and takes minutes; the MCP transport gives a call 30–120 s. Blocking would
 * turn a healthy backup into a timeout error and leave the caller unable to tell
 * a slow run from a failed one. So `backup_run` starts a run, returns a runId,
 * and `backup_status` reports progress — which is also what makes a run
 * observable from a different session, or after a reconnect.
 *
 * Only one run at a time. Two concurrent passes would race on the same mirror,
 * the same snapshot names and the same index.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { BackupConfig, TargetName } from './config';
import { ALL_TARGETS, REMOTE_TARGETS, storePaths } from './config';
import {
  captureClaudeAi, captureLocal, captureMemoryRules, captureRemote, dryRunLocal,
  type CaptureResult,
} from './capture';
import { BackupIndex, openForRead, type IndexMeta } from './search-index';
import { findLegacySecrets } from './remove';
import {
  appendHistory, readRemovals, readStatus, runInFlight, staleness, stamp,
  tailHistory, writeRun, writeStatus, type RunState, type StatusMap,
} from './store';

export interface StartOptions {
  targets: TargetName[];
  dryRun: boolean;
  skipBlobs: boolean;
  reindex: boolean;
}

export interface DryRunReport {
  dryRun: true;
  localFiles: number;
  localExcluded: number;
  excludedSample: string[];
  targets: TargetName[];
}

/** Enumerate without writing — the safe way to see what a policy change does. */
export function dryRun(cfg: BackupConfig, targets: TargetName[]): DryRunReport {
  const local = dryRunLocal(cfg);
  return {
    dryRun: true,
    localFiles: local.files,
    localExcluded: local.excluded,
    excludedSample: local.sample,
    targets,
  };
}

/**
 * Start a run in the background. Returns immediately with the run state.
 * Throws if a run is already in flight — never silently queues.
 */
export function startRun(cfg: BackupConfig, opts: StartOptions): RunState {
  const inFlight = runInFlight(cfg);
  if (inFlight) {
    throw new Error(
      `a backup run is already in flight (runId ${inFlight.runId}, started ${inFlight.startedAt}` +
      `${inFlight.current ? `, currently on ${inFlight.current}` : ''}) — poll backup_status`,
    );
  }
  const run: RunState = {
    runId: crypto.randomBytes(6).toString('hex'),
    startedAt: stamp(),
    targets: opts.targets,
    done: [],
    failed: [],
    dryRun: opts.dryRun,
  };
  writeRun(cfg, run);

  void execute(cfg, run, opts).catch((e) => {
    run.error = e instanceof Error ? e.message : String(e);
    run.finishedAt = stamp();
    try { writeRun(cfg, run); } catch { /* store unwritable — nothing left to do */ }
  });

  return run;
}

async function execute(cfg: BackupConfig, run: RunState, opts: StartOptions): Promise<void> {
  const status: StatusMap = readStatus(cfg);
  let index: BackupIndex | null = null;
  try {
    index = new BackupIndex(cfg);
  } catch (e) {
    // Search is a feature of the backup, not a precondition for it.
    appendHistory(cfg, `index unavailable, capturing without it — ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    for (const target of run.targets) {
      run.current = target;
      writeRun(cfg, run);
      let res: CaptureResult;
      try {
        if (target === 'windows-desk') res = captureLocal(cfg, index);
        else if (target === 'claudeai') res = await captureClaudeAi(cfg, index, opts.skipBlobs);
        else if (target === 'memory-rules') res = await captureMemoryRules(cfg, index);
        else {
          const r = REMOTE_TARGETS.find((x) => x.name === target);
          if (!r) throw new Error(`unknown target ${target}`);
          res = await captureRemote(cfg, r, index);
        }
      } catch (e) {
        res = {
          method: 'n/a', source: target, target: '', lastRun: stamp(),
          result: 'FAILED', detail: e instanceof Error ? e.message : String(e),
          sizeMB: 0, items: 0, secretsExcluded: 0, indexedRows: 0,
        };
      }
      status[target] = res;
      writeStatus(cfg, status);
      appendHistory(cfg,
        `${target} ${res.result} size=${res.sizeMB}MB items=${res.items} ` +
        `excluded=${res.secretsExcluded} indexed=${res.indexedRows} -> ${res.target}`);
      (res.result.startsWith('FAILED') ? run.failed : run.done).push(target);
      run.current = undefined;
      writeRun(cfg, run);
    }
    if (index) index.setIndexedAt();
  } finally {
    if (index) index.close();
    run.finishedAt = stamp();
    writeRun(cfg, run);
  }

  await pushStatus(cfg);
}

/**
 * Commit and push STATUS.md/status.json.
 *
 * Only these two files are versioned — the payload is gitignored, which is why
 * removal never needs a history rewrite. A push failure is logged, not raised:
 * the backup itself succeeded, and the next run retries.
 */
export function pushStatus(cfg: BackupConfig): Promise<void> {
  const git = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile('git', args, { cwd: cfg.root, windowsHide: true, maxBuffer: 512 * 1024 },
        (err, stdout, stderr) => resolve({
          code: err ? ((err as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0,
          out: `${stdout}${stderr}`,
        }));
    });

  return (async () => {
    if (!fs.existsSync(`${cfg.root}/.git`)) return;
    await git(['add', 'STATUS.md', 'status.json']);
    const diff = await git(['diff', '--cached', '--quiet']);
    if (diff.code === 0) return;                       // nothing changed
    await git(['commit', '-m', `backup status ${stamp()}`]);
    const push = await git(['push', 'origin', 'HEAD']);
    if (push.code !== 0) {
      appendHistory(cfg, 'status push FAILED (offline?) — will retry next run');
    }
  })();
}

// -------------------------------------------------------------------- status

export interface StatusReport {
  root: string;
  targets: {
    name: string; method: string; lastRun: string; result: string;
    sizeMB: number; items: number; secretsExcluded?: number;
    staleness: string; ageDays: number;
  }[];
  missing: string[];
  run: RunState | null;
  index: IndexMeta;
  legacySecrets: { path: string; reason: string; bytes: number; isDir: boolean }[];
  recentRemovals: ReturnType<typeof readRemovals>;
  history: string[];
  diskFreeGB: number | null;
}

export async function buildStatusReport(cfg: BackupConfig): Promise<StatusReport> {
  const status = readStatus(cfg);
  const targets = Object.keys(status).sort().map((name) => {
    const s = status[name as TargetName]!;
    const { verdict, ageDays } = staleness(s.lastRun);
    return {
      name, method: s.method, lastRun: s.lastRun, result: s.result,
      sizeMB: s.sizeMB, items: s.items, secretsExcluded: s.secretsExcluded,
      staleness: verdict, ageDays: Math.round(ageDays * 10) / 10,
    };
  });

  const { index, meta } = openForRead(cfg);
  index?.close();

  // Free space matters here more than usual: a backup that silently stops for
  // want of disk looks identical to one that is up to date.
  let diskFreeGB: number | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('check-disk-space');
    const cds = (mod.default ?? mod) as (p: string) => Promise<{ free: number }>;
    diskFreeGB = Math.round(((await cds(cfg.root)).free / 1073741824) * 10) / 10;
  } catch { /* optional dependency / unsupported platform */ }

  return {
    root: cfg.root,
    targets,
    missing: ALL_TARGETS.filter((t) => !(t in status)),
    run: runInFlight(cfg) ?? null,
    index: meta,
    legacySecrets: findLegacySecrets(cfg),
    recentRemovals: readRemovals(cfg, 5),
    history: tailHistory(cfg, 8),
    diskFreeGB,
  };
}

