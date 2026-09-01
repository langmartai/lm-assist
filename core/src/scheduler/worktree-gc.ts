/**
 * Worktree GC — reclaim the disk that mission/feature worktrees hold after
 * their work has landed.
 *
 * Born from the 2026-07-21 disk-full incident on 117 (root FS 99%): mission
 * worktrees cost 1–2.2 GB EACH (own node_modules + .next) and nothing ever
 * removed them. This job walks each repo's linked worktrees and:
 *
 *   REMOVES a worktree only when ALL of:
 *     - its tree is CLEAN (git status --porcelain empty — dirty is sacred),
 *     - its HEAD is fully MERGED into the repo's main,
 *     - its mission (mission-<id> naming) is done/failed/archived — or it has
 *       no mission and its last commit is older than `staleNoMissionDays`.
 *   Missions still active/waiting keep their worktree even when merged.
 *   `git worktree remove` is used WITHOUT --force, so git itself re-checks
 *   cleanliness — a second, independent safety.
 *
 *   TRIMS `.next/cache` (Turbopack build cache, often hundreds of MB) inside
 *   KEPT worktrees whose cache hasn't been touched for `idleCacheHours`.
 *
 * `dryRun` reports decisions without acting. The builtin job runs every 6h.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface WorktreeGcConfig {
  /** Repo roots to scan. Defaults cover the local lm-assist checkout + any distinct mission env.repo. */
  roots?: string[];
  dryRun?: boolean;
  /** Trim a kept worktree's .next/cache when idle this long. */
  idleCacheHours?: number;
  /** A mission-less worktree must be merged+clean AND idle this long to be removed. */
  staleNoMissionDays?: number;
}

export interface WorktreeDecision {
  path: string;
  repo: string;
  branch: string;
  missionId: string | null;
  missionStatus: string | null;
  dirty: boolean;
  merged: boolean;
  action: 'removed' | 'kept' | 'cache-trimmed' | 'would-remove';
  reason: string;
  freedBytesApprox?: number;
}

export interface WorktreeGcResult {
  scanned: number;
  removed: number;
  cacheTrimmed: number;
  kept: number;
  decisions: WorktreeDecision[];
}

export interface WorktreeGcDeps {
  git(repoOrWorktree: string, args: string[]): string;
  missionStatus(missionId: string): Promise<string | null>;
  now(): number;
  dirSizeApprox(p: string): number;
  rmrf(p: string): void;
  exists(p: string): boolean;
  cacheMtimeMs(p: string): number | null;
}

const DEFAULT_ROOTS = [path.join(os.homedir(), 'lm-assist')];

function defaultDeps(): WorktreeGcDeps {
  return {
    git: (cwd, args) => {
      try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();
      } catch (e) {
        throw new Error(`git ${args[0]} failed in ${cwd}: ${(e as Error).message.split('\n')[0]}`);
      }
    },
    missionStatus: async (id) => {
      try {
        // Lazy require: the scheduler must not force the mission store up at import time.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const store = require('../mission/mission-store');
        const m = store.getMission ? await store.getMission(id) : null;
        return m ? String(m.status || '') : null;
      } catch {
        return null; // store unavailable → treat as unknown (conservative: keep)
      }
    },
    now: () => Date.now(),
    dirSizeApprox: (p) => {
      // Cheap heuristic: du would be exact but slow; approximate from a shallow walk.
      let total = 0;
      const walk = (d: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const fp = path.join(d, e.name);
          try {
            if (e.isFile()) total += fs.statSync(fp).size;
            else if (e.isDirectory()) walk(fp, depth + 1);
          } catch { /* races fine */ }
        }
      };
      walk(p, 0);
      return total;
    },
    rmrf: (p) => fs.rmSync(p, { recursive: true, force: true }),
    exists: (p) => fs.existsSync(p),
    cacheMtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
  };
}

function parseWorktreeList(porcelain: string): Array<{ path: string; branch: string }> {
  const out: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim() };
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.trim() === '' && cur.path) {
      out.push({ path: cur.path, branch: cur.branch || '(detached)' });
      cur = {};
    }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch || '(detached)' });
  return out;
}

const MISSION_DIR_RE = /mission-(mission_[a-z0-9]+)/;
const REMOVABLE_MISSION_STATUSES = new Set(['done', 'failed', 'archived', 'cancelled']);

export async function runWorktreeGc(
  config: WorktreeGcConfig = {},
  deps: WorktreeGcDeps = defaultDeps(),
): Promise<WorktreeGcResult> {
  const roots = (config.roots && config.roots.length ? config.roots : DEFAULT_ROOTS)
    .filter((r) => deps.exists(r));
  const dryRun = config.dryRun === true;
  const idleCacheMs = Math.max(1, config.idleCacheHours ?? 24) * 3600 * 1000;
  const staleMs = Math.max(1, config.staleNoMissionDays ?? 7) * 24 * 3600 * 1000;

  const decisions: WorktreeDecision[] = [];

  for (const repo of roots) {
    let listed: Array<{ path: string; branch: string }> = [];
    try { listed = parseWorktreeList(deps.git(repo, ['worktree', 'list', '--porcelain'])); } catch { continue; }
    const mainPath = listed.length ? listed[0].path : repo; // first entry = the main checkout

    for (const wt of listed) {
      if (path.resolve(wt.path) === path.resolve(mainPath)) continue; // never the main checkout

      const mid = (wt.path.match(MISSION_DIR_RE) || [])[1] || null;
      const missionStatus = mid ? await deps.missionStatus(mid) : null;

      let dirty = true;
      try { dirty = deps.git(wt.path, ['status', '--porcelain']).length > 0; } catch { /* unreadable → treat dirty */ }

      let merged = false;
      try {
        const head = deps.git(wt.path, ['rev-parse', 'HEAD']);
        deps.git(repo, ['merge-base', '--is-ancestor', head, 'main']);
        merged = true;
      } catch { merged = false; }

      const base: Omit<WorktreeDecision, 'action' | 'reason'> = {
        path: wt.path, repo, branch: wt.branch, missionId: mid, missionStatus, dirty, merged,
      };

      let removable = false;
      let reason = '';
      if (dirty) reason = 'dirty tree — never removed';
      else if (!merged) reason = 'branch not merged into main';
      else if (mid) {
        if (missionStatus && REMOVABLE_MISSION_STATUSES.has(missionStatus)) {
          removable = true; reason = `mission ${missionStatus} + merged + clean`;
        } else {
          reason = `mission status ${missionStatus ?? 'unknown'} — kept`;
        }
      } else {
        let lastCommitMs = deps.now();
        try { lastCommitMs = parseInt(deps.git(wt.path, ['log', '-1', '--format=%ct']), 10) * 1000; } catch { /* keep now */ }
        if (deps.now() - lastCommitMs > staleMs) {
          removable = true; reason = `no mission, merged, clean, idle ${Math.round((deps.now() - lastCommitMs) / 86_400_000)}d`;
        } else {
          reason = 'no mission, but recently active — kept';
        }
      }

      if (removable) {
        const freed = deps.dirSizeApprox(wt.path);
        if (dryRun) {
          decisions.push({ ...base, action: 'would-remove', reason, freedBytesApprox: freed });
        } else {
          try {
            deps.git(repo, ['worktree', 'remove', wt.path]); // no --force: git re-verifies clean
            decisions.push({ ...base, action: 'removed', reason, freedBytesApprox: freed });
          } catch (e) {
            decisions.push({ ...base, action: 'kept', reason: `removal refused: ${(e as Error).message}` });
          }
        }
        continue;
      }

      // Kept: trim an idle build cache (the biggest passive cost of a parked worktree).
      let trimmed = false;
      for (const rel of ['web/.next/cache', '.next/cache']) {
        const cache = path.join(wt.path, rel);
        const m = deps.cacheMtimeMs(cache);
        if (m != null && deps.now() - m > idleCacheMs) {
          const freed = deps.dirSizeApprox(cache);
          if (!dryRun) deps.rmrf(cache);
          decisions.push({ ...base, action: 'cache-trimmed', reason: `${rel} idle > ${config.idleCacheHours ?? 24}h${dryRun ? ' (dry-run)' : ''}`, freedBytesApprox: freed });
          trimmed = true;
        }
      }
      if (!trimmed) decisions.push({ ...base, action: 'kept', reason });
    }

    if (!dryRun) { try { deps.git(repo, ['worktree', 'prune']); } catch { /* best effort */ } }
  }

  return {
    scanned: decisions.length,
    removed: decisions.filter((d) => d.action === 'removed').length,
    cacheTrimmed: decisions.filter((d) => d.action === 'cache-trimmed').length,
    kept: decisions.filter((d) => d.action === 'kept').length,
    decisions,
  };
}

const fmtMB = (b?: number) => (b == null ? '' : ` (~${Math.round(b / 1_048_576)}MB)`);

export function registerWorktreeGc(jobs: { registerHandler: (t: string, fn: (config: Record<string, unknown>, ctx: { dryRunForced?: boolean }) => Promise<{ result: string; status?: 'ok' | 'error' | 'skipped' }>) => void }): void {
  jobs.registerHandler('worktree-gc', async (config, ctx) => {
    const r = await runWorktreeGc({
      roots: Array.isArray(config.roots) ? (config.roots as string[]) : undefined,
      dryRun: ctx.dryRunForced === true || config.dryRun === true,
      idleCacheHours: typeof config.idleCacheHours === 'number' ? config.idleCacheHours : undefined,
      staleNoMissionDays: typeof config.staleNoMissionDays === 'number' ? config.staleNoMissionDays : undefined,
    });
    const acted = r.decisions.filter((d) => d.action !== 'kept');
    const lines = acted.slice(0, 8).map((d) => `${d.action}: ${path.basename(d.path)}${fmtMB(d.freedBytesApprox)} — ${d.reason}`);
    return {
      result: `scanned=${r.scanned} removed=${r.removed} cacheTrimmed=${r.cacheTrimmed} kept=${r.kept}${lines.length ? ' | ' + lines.join('; ') : ''}`,
      status: 'ok',
    };
  });
}
