/**
 * Scheduled Jobs — lm-assist's own internal job scheduler.
 *
 * A small, self-contained replacement for OS cron: periodic Node timers, a
 * JSON-persisted job store, and a handler registry — all inside the Core
 * process. We deliberately do NOT shell out to crontab/systemd-timers; jobs
 * live and die with the worker and are managed over the REST/MCP surface.
 *
 * Why poll instead of arming one long timer per job: Node timer delays are a
 * signed 32-bit int of ms (~24.8 days max); a raw 30-day delay overflows and
 * fires continuously (see auth/api-token.ts). So we tick once a minute and
 * compare timestamps — a long interval is just "elapsed >= interval", never a
 * single oversized setTimeout.
 *
 * SAFETY: destructive built-ins (e.g. `cleanup-test-conversations` deletes claude.ai
 * conversations, `executor-reaper` kills panes) ship DISARMED — disabled and/or
 * dryRun=true (see makeBuiltinJobs for the per-job policy). The user arms the
 * destructive action (set enabled + config.dryRun=false) themselves — the
 * scheduler only provides the mechanism. A dry-run sweep is non-destructive
 * (it just reports what WOULD be deleted) and the default selection matches
 * only expired-TTL markers + explicit ids (never a conversation without an
 * lm-autodel marker). See cleanupTestConversations / matchTestConversations.
 *
 * Singleton via getScheduledJobs().
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../utils/path-utils';

// ── Types ──────────────────────────────────────────

export type JobStatus = 'ok' | 'error' | 'skipped';

/** Why a run happened — gates conditions + scheduling effects. */
export type JobTrigger = 'schedule' | 'manual' | 'test';

/** A full capture of one execution (for display + history). */
export interface JobRunRecord {
  at: string;                 // ISO timestamp
  status: JobStatus;          // ok | error | skipped
  result: string;            // one-line summary
  trigger: JobTrigger;
  exitCode?: number | null;   // for shell jobs
  durationMs?: number;
  stdout?: string;            // captured (bounded)
  stderr?: string;            // captured (bounded)
  condition?: string;         // note about a runIf guard evaluation (when present)
}

export interface ScheduledJob {
  /** Stable id. Built-in ids are reserved (e.g. 'cleanup-test-conversations'). */
  id: string;
  /** Human-readable display name (falls back to id). */
  name?: string;
  /** What the job does — shown in the UI / MCP listing. */
  description?: string;
  /** Handler key in the registry (built-ins set this to their id). */
  type: string;
  /** Master on/off. Built-ins ship disabled. */
  enabled: boolean;
  /** Run cadence in minutes. <=0 means "paused" (never fires even if enabled). */
  intervalMinutes: number;
  /**
   * Handler-specific options + execution conditions:
   *   command/cwd/timeoutMs/dryRun (shell), ids/patterns/... (cleanup)
   *   runIf?: string  — a guard command; a SCHEDULED run only fires if it exits 0
   *   maxRuns?: number — stop auto-running after this many successful runs (0 = no cap)
   */
  config: Record<string, any>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: JobStatus | null;
  /** Full capture of the most recent run (stdout/stderr/exit/duration). */
  lastRun?: JobRunRecord | null;
  /** Bounded history of recent runs (newest first). */
  runLog?: JobRunRecord[];
  /** How many real (non-test, non-skipped) runs have executed — drives maxRuns. */
  runCount?: number;
  /** Built-in jobs cannot be deleted (only disabled/configured). */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobRunOutcome {
  result: string;
  status?: JobStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

/** A handler receives the job's config and a ctx flag, and returns an outcome. */
export type JobHandler = (
  config: Record<string, any>,
  ctx: { dryRunForced: boolean },
) => Promise<JobRunOutcome>;

export type ScheduledJobView = ScheduledJob & { nextRunAt: string | null; isRunning: boolean; disabledByEnv: boolean };

/**
 * Ids named by the `LM_DISABLE_JOBS` env kill switch (comma-separated, e.g.
 * `LM_DISABLE_JOBS=executor-reaper,worktree-gc`). Read at RUN TIME on every check — never
 * cached — so the override works regardless of what the persisted store says and survives a
 * dist-sync/upgrade/restart: an env-disabled job never executes until the env var is lifted.
 */
export function envDisabledJobIds(raw: string | undefined = process.env.LM_DISABLE_JOBS): Set<string> {
  const out = new Set<string>();
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (id) out.add(id);
    }
  }
  return out;
}

// ── Pure scheduling logic (unit-tested) ──────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

const RUN_LOG_MAX = 20;
const CAPTURE_MAX = 8_000; // per-stream stdout/stderr cap for storage

/** Cap a string for storage/display, noting how much was dropped. */
export function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} more)`;
}

/** Prepend the newest record and bound the ring (newest first). Pure. */
export function pushRunLog(log: JobRunRecord[] | undefined, rec: JobRunRecord, max = RUN_LOG_MAX): JobRunRecord[] {
  return [rec, ...(Array.isArray(log) ? log : [])].slice(0, max);
}

/** Has this job hit its run cap? Only when config.maxRuns is a positive number. */
export function reachedMaxRuns(job: ScheduledJob): boolean {
  const max = Number(job.config?.maxRuns);
  if (!Number.isFinite(max) || max <= 0) return false;
  return (job.runCount ?? 0) >= max;
}

/** Parse a `config.runAt` ISO time → ms, or null if absent/unparseable. */
export function parseRunAt(runAt: unknown): number | null {
  if (typeof runAt !== 'string' || !runAt.trim()) return null;
  const ms = Date.parse(runAt);
  return Number.isNaN(ms) ? null : ms;
}

/** A one-time job runs once then completes: it has a `runAt` time OR maxRuns===1. */
export function isOneTime(job: ScheduledJob): boolean {
  return parseRunAt(job.config?.runAt) != null || Number(job.config?.maxRuns) === 1;
}

/** Is this job due to run at nowMs? Disabled / capped / before-runAt / paused / not-yet-elapsed → false. */
export function isJobDue(job: ScheduledJob, nowMs: number): boolean {
  if (!job.enabled) return false;
  if (reachedMaxRuns(job)) return false; // hit its run cap
  const runAtMs = parseRunAt(job.config?.runAt);
  if (runAtMs != null) {
    // one-time scheduled run: due once at/after runAt, only if it hasn't run yet
    return !job.lastRunAt && nowMs >= runAtMs;
  }
  if (!job.intervalMinutes || job.intervalMinutes <= 0) return false;
  if (!job.lastRunAt) return true; // never run → due immediately
  const last = Date.parse(job.lastRunAt);
  if (Number.isNaN(last)) return true; // unparseable timestamp → treat as never-run
  return nowMs - last >= job.intervalMinutes * 60_000;
}

/** When will this job next fire (ms)? null if disabled/paused/done. A never-run interval job → now. */
export function nextRunAtMs(job: ScheduledJob, nowMs: number): number | null {
  if (!job.enabled) return null;
  if (reachedMaxRuns(job)) return null;
  const runAtMs = parseRunAt(job.config?.runAt);
  if (runAtMs != null) return job.lastRunAt ? null : runAtMs; // one-time: at runAt, or done
  if (!job.intervalMinutes || job.intervalMinutes <= 0) return null;
  if (!job.lastRunAt) return nowMs;
  const last = Date.parse(job.lastRunAt);
  if (Number.isNaN(last)) return nowMs;
  return last + job.intervalMinutes * 60_000;
}

/** Record the outcome of a run. Pure — returns a new job, never mutates the input. */
export function applyJobResult(job: ScheduledJob, outcome: JobRunOutcome, nowMs: number): ScheduledJob {
  return {
    ...job,
    lastRunAt: iso(nowMs),
    lastResult: outcome.result,
    lastStatus: outcome.status ?? 'ok',
    updatedAt: iso(nowMs),
  };
}

/**
 * Apply a full run record: capture it as lastRun, ring it into runLog, update the summary fields,
 * and count real runs. A 'test' run is a verification — it does NOT advance the schedule clock or
 * the run count (so it never disturbs scheduling or trips maxRuns). A 'skipped' run doesn't count
 * either. Pure — returns a new job.
 */
export function applyRun(job: ScheduledJob, record: JobRunRecord, nowMs: number): ScheduledJob {
  const isTest = record.trigger === 'test';
  const counts = !isTest && record.status !== 'skipped';
  return {
    ...job,
    lastRunAt: isTest ? job.lastRunAt : iso(nowMs),
    lastResult: record.result,
    lastStatus: record.status,
    lastRun: record,
    runLog: pushRunLog(job.runLog, record),
    runCount: (job.runCount ?? 0) + (counts ? 1 : 0),
    updatedAt: iso(nowMs),
  };
}

// ── Scripted ("shell") job helpers (unit-tested) ──────────────────────────────

const SHELL_TIMEOUT_DEFAULT_MS = 60_000;
const SHELL_TIMEOUT_MIN_MS = 1_000;
const SHELL_TIMEOUT_MAX_MS = 600_000;
const SHELL_RESULT_MAX = 400;

/** Clamp a configured timeout (number or numeric string — the connector stringifies) to a sane range. */
export function clampTimeoutMs(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return SHELL_TIMEOUT_DEFAULT_MS;
  return Math.min(SHELL_TIMEOUT_MAX_MS, Math.max(SHELL_TIMEOUT_MIN_MS, Math.round(n)));
}

/**
 * Substitute the `{{dryRun}}` placeholder in a command with the effective boolean, so a job can be
 * toggled dry-run⟷armed from a button (flipping `config.dryRun`) instead of hand-editing the script.
 * e.g. `... -d '{"dryRun":{{dryRun}}}'` → `... -d '{"dryRun":true}'` or `...false}'`.
 */
export function applyShellTemplate(command: string, dryRun: boolean): string {
  return command.replace(/\{\{\s*dryRun\s*\}\}/g, String(dryRun));
}

/** Render a finished shell command into a one-line job outcome (exit code + truncated output tail). */
export function formatShellResult(r: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): JobRunOutcome {
  if (r.timedOut) {
    return { result: `timed out after ${SHELL_TIMEOUT_MAX_MS / 1000}s max`, status: 'error' };
  }
  const code = r.code ?? 0;
  const body = (r.stdout || '').trim() || (r.stderr || '').trim();
  const tail = body.split('\n').slice(-3).join(' | ').slice(0, SHELL_RESULT_MAX);
  return {
    result: `exit ${code}${tail ? `: ${tail}` : ''}`,
    status: code === 0 ? 'ok' : 'error',
    exitCode: code,
    stdout: truncate(r.stdout || '', CAPTURE_MAX),
    stderr: truncate(r.stderr || '', CAPTURE_MAX),
  };
}

/**
 * The built-in jobs, seeded on FRESH stores only — an existing store's persisted values win
 * (see load()), so changing a seed here never flips a job on a node that already has a store.
 *
 * Seeding policy (the executor-reaper incident's lesson): a DESTRUCTIVE built-in — anything
 * that kills/reaps/deletes (executor-reaper, worktree-gc's delete action,
 * cleanup-test-conversations) — ships DISARMED (disabled and/or dryRun:true) and is armed by
 * a human. Observational/recovery monitors (stall-monitor, auth-monitor, mission-controller)
 * ship enabled, matching their prod reality.
 */
export function makeBuiltinJobs(nowMs: number): ScheduledJob[] {
  const at = iso(nowMs);
  return [
    {
      id: 'cleanup-test-conversations',
      name: 'Delete verified conversation IDs',
      description: 'Deletes ONLY the exact conversation ids in its verified list (config.ids), by direct id match. Does NO name/pattern/TTL matching. Empty list deletes nothing. Ships disabled + dry-run; arm with config.dryRun=false.',
      type: 'cleanup-test-conversations',
      enabled: false, // SAFE BY DEFAULT — the user arms it
      intervalMinutes: 1440, // daily, once armed
      config: {
        // dryRun TRUE → reports the count without deleting. The user sets dryRun:false to arm deletion.
        dryRun: true,
        // ids = the VERIFIED list. The ONLY delete mechanism is a direct uuid match against this list;
        // there is no pattern/TTL/name matching. Empty → nothing is ever deleted.
        ids: [] as string[],
      },
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'stall-monitor',
      name: 'Auto-resume stalled sessions',
      description: 'Resume sessions stalled on server errors (529/5xx/server-rate-limit) with `continue`; never user-usage-limits.',
      type: 'stall-monitor',
      enabled: true, // ON BY DEFAULT (deliberate deviation)
      intervalMinutes: 5,
      config: {},
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'mission-controller',
      name: 'Super Mission Controller',
      description: 'Fleet-elected loop: lifecycle check every ~1 min (prompt failover) + adapt-DRIVE every ~5 min (missionControllerIntervalMin). The 1-min tick only launches/tears down; the costly drive pass is gated internally by driveDue.',
      type: 'mission-controller',
      enabled: true,
      intervalMinutes: 1,
      config: {},
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    { id: 'auth-monitor', name: 'Auth monitor', description: 'Refresh Claude Code OAuth + track claude.ai cookie health into a per-node snapshot (browser-free).', type: 'auth-monitor', enabled: true, intervalMinutes: 15, config: {}, lastRunAt: null, lastResult: null, lastStatus: null, builtin: true, createdAt: at, updatedAt: at },
    {
      id: 'worktree-gc',
      name: 'Worktree GC',
      description: 'Reclaim disk from parked worktrees: remove CLEAN+MERGED worktrees of done/archived missions (dirty/unmerged/active are never touched; git re-verifies on remove), and trim idle .next build caches in kept ones. Born from the 2026-07-21 disk-full incident. Ships dry-run — arm with config.dryRun=false.',
      type: 'worktree-gc',
      enabled: true, // the sweep stays on so a fresh node still REPORTS reclaimable disk…
      intervalMinutes: 360,
      // …but the deleting action seeds dryRun:true (executor-reaper incident lesson: destructive
      // actions never self-arm on a fresh store). The human arms config.dryRun=false after
      // reviewing a dry-run report. Existing stores keep their persisted dryRun value.
      config: { dryRun: true, idleCacheHours: 24, staleNoMissionDays: 7 },
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'executor-reaper',
      name: 'Executor reaper',
      description:
        'Retire mission executor panes whose work is finished: mission done/failed + pane idle + context exhausted (or idle past the threshold). Harvests results from the merge commits BEFORE reaping so the record is never silently empty. Never touches an active/waiting mission, a mid-turn pane, an onboarded session, or a pane it cannot resolve to a mission. Ships DISABLED + dry-run — enable it, review the would-reap list, then arm with config.dryRun=false.',
      type: 'executor-reaper',
      // DISABLED BY DEFAULT — the executor-reaper incident: a built-in that KILLS panes must
      // never self-arm on a fresh store. A human enables it, reviews the dry-run reap list,
      // and only then arms config.dryRun=false. Existing stores keep their persisted value.
      enabled: false,
      intervalMinutes: 60,
      config: {
        // dryRun TRUE → reports the full would-reap list without killing anything.
        // The human arms it after reviewing that list.
        dryRun: true,
        ctxExhaustedPct: 95,
        idleMinutes: 120,
        graceMinutes: 30,
        maxReapsPerRun: 10,
      },
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

// ── Persistence ──────────────────────────────────────────

/** Dev/prod-separated so a dev (:3200) experiment can never arm prod's (:3100) deleting job. */
export function jobsFilePath(): string {
  return path.join(getDataDir(), isDevRepo() ? 'scheduled-jobs-dev.json' : 'scheduled-jobs.json');
}

// ── Scheduler ──────────────────────────────────────────

const TICK_MS = 60_000;

export class ScheduledJobs {
  private jobs: Map<string, ScheduledJob> = new Map();
  private handlers: Map<string, JobHandler> = new Map();
  private running: Set<string> = new Set();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private _started = false;
  private loaded = false;
  /** mtime of the store file at our last read/write — a newer mtime means a hand-edit. */
  private lastDiskMtimeMs = 0;
  /** Job ids THIS process mutated (upsert/delete) since the last disk sync — their values beat a hand-edit. */
  private mutatedSinceSync: Set<string> = new Set();
  /** Which env-disabled ids we already logged, so a due job doesn't log every tick. */
  private envDisabledLogged: Set<string> = new Set();

  /** Register a handler for a job `type`. Idempotent (last registration wins). */
  registerHandler(type: string, fn: JobHandler): void {
    this.handlers.set(type, fn);
  }

  private registerDefaults(): void {
    if (this.handlers.has('shell')) return;

    // Generic scripted job — runs a command on the schedule (a true cron replacement).
    //
    // SECURITY MODEL: `config.command` is OPERATOR input, set only through the api-token-gated
    // REST/MCP/UI surface — the same trust level as editing one's own crontab. It is NOT third-party
    // input and is never interpolated into a larger command (the operator's whole command IS what runs).
    // Two forms:
    //   - command as a STRING  → run via a shell (exec) so cron-style pipes/redirects/&&/globs work.
    //     This is the deliberate "I want shell features" path; the string is operator-trusted.
    //   - command as an ARRAY [bin, ...args] → run via execFile (NO shell) — injection-safe; metacharacters
    //     in args are literal. Prefer this when you don't need a shell.
    // Disabled by default like a fresh cron entry; bounded timeout + truncated output.
    //
    // DRY-RUN TOGGLE: if the command contains a `{{dryRun}}` placeholder, it's substituted with
    // `config.dryRun` (default true = safe) — so a UI/MCP toggle flips dry-run⟷armed without editing
    // the script. A forced preview always substitutes true. Such a job runs even in preview (the
    // placeholder makes it safe). A command WITHOUT the placeholder can't be safely previewed, so a
    // forced preview just reports what would run.
    this.registerHandler('shell', async (config, ctx) => {
      const argvRaw = Array.isArray(config.command) && config.command.every((x: unknown) => typeof x === 'string')
        ? (config.command as string[]).filter((s) => s.length > 0)
        : null;
      const cmdRaw = typeof config.command === 'string' ? config.command.trim() : '';
      if (!argvRaw?.length && !cmdRaw) return { result: 'no command configured', status: 'skipped' };
      const display = argvRaw?.length ? argvRaw.join(' ') : cmdRaw;

      const templated = /\{\{\s*dryRun\s*\}\}/.test(display);
      if (ctx.dryRunForced && !templated) {
        return { result: `dry-run: would run \`${display.slice(0, 200)}\``, status: 'ok' };
      }
      const effDryRun = ctx.dryRunForced ? true : config.dryRun !== false; // default true = safe
      const sub = (s: string) => (templated ? applyShellTemplate(s, effDryRun) : s);
      const cmdStr = sub(cmdRaw);
      const argv = argvRaw?.map(sub);
      const tag = templated ? (effDryRun ? '[dry-run] ' : '[armed] ') : '';

      const cwd = typeof config.cwd === 'string' && config.cwd ? config.cwd : undefined;
      const timeout = clampTimeoutMs(config.timeoutMs);
      const opts = { cwd, timeout, maxBuffer: 1024 * 1024, windowsHide: true };
      const cp = require('child_process');
      return await new Promise<JobRunOutcome>((resolve) => {
        const done = (err: any, stdout: string, stderr: string) => {
          const timedOut = !!err && (err.killed || err.signal === 'SIGTERM') && err.code == null;
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          const r = formatShellResult({ code: timedOut ? null : code, stdout: stdout || '', stderr: stderr || '', timedOut });
          resolve({ ...r, result: tag + r.result });
        };
        // argv form → execFile (no shell, injection-safe). string form → exec (operator-trusted shell line).
        const child = argv?.length ? cp.execFile(argv[0], argv.slice(1), opts, done) : cp.exec(cmdStr, opts, done);
        child.on?.('error', (e: any) => resolve({ result: `spawn failed: ${e?.message || e}`, status: 'error' }));
      });
    });

    if (this.handlers.has('cleanup-test-conversations')) return;
    this.registerHandler('cleanup-test-conversations', async (config, ctx) => {
      // Lazy require to avoid a static import cycle (claudeai-session is large).
      const { deleteConversation } = require('../utils/claudeai-session');
      // dryRun defaults TRUE; only an explicit config.dryRun===false arms deletion.
      // A forced dry-run (preview "Run now") always wins, so a preview never deletes.
      const armed = config.dryRun === false;
      const dryRun = ctx.dryRunForced ? true : !armed;
      // ID-ONLY BY DESIGN: deletes EXACTLY the conversation ids in the verified list (config.ids), by
      // DIRECT id match. It does NO name / pattern / TTL matching whatsoever — a conversation is deleted
      // only if its exact uuid was added to the list. An empty list deletes nothing. (ids are uuid-validated.)
      const ids = (Array.isArray(config.ids) ? config.ids : []).filter(
        (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x),
      );
      if (!ids.length) return { result: 'verified id list is empty — nothing to delete', status: 'skipped' };
      if (dryRun) return { result: `dry-run: would delete ${ids.length} conversation(s) by id`, status: 'ok' };
      let deleted = 0, gone = 0, failed = 0;
      for (const id of ids) {
        try {
          const r = await deleteConversation(id);
          if (r.status === 404) gone++;
          else if (r.status < 400) deleted++;
          else failed++;
        } catch { failed++; }
      }
      const result = `deleted ${deleted}/${ids.length} by id` + (gone ? `, ${gone} already gone` : '') + (failed ? `, ${failed} failed` : '');
      return { result, status: failed ? 'error' : 'ok' };
    });

    {
      const { registerStallMonitor } = require('../monitor/stall-monitor');
      registerStallMonitor(this);
    }

    {
      const { registerWorktreeGc } = require('./worktree-gc');
      registerWorktreeGc(this);
    }

    {
      const { registerExecutorReaper } = require('./executor-reaper');
      registerExecutorReaper(this);
    }

    {
      const { registerMissionController } = require('../mission/mission-controller');
      registerMissionController(this);
    }

    {
      const { registerAuthMonitor } = require('../monitor/auth-monitor');
      registerAuthMonitor(this);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    // Seed built-ins first so they always exist with their reserved identity.
    const now = Date.now();
    for (const b of makeBuiltinJobs(now)) this.jobs.set(b.id, b);

    // Overlay any persisted jobs.
    let arr: ScheduledJob[] = [];
    try {
      arr = JSON.parse(fs.readFileSync(jobsFilePath(), 'utf8')) as ScheduledJob[];
    } catch {
      arr = []; // no file yet → just the built-ins
    }
    try { this.lastDiskMtimeMs = fs.statSync(jobsFilePath()).mtimeMs; } catch { this.lastDiskMtimeMs = 0; }
    if (!Array.isArray(arr)) arr = [];
    for (const j of arr) {
      if (!j || typeof j.id !== 'string') continue;
      const existing = this.jobs.get(j.id);
      if (existing?.builtin) {
        // Preserve the built-in's identity/type/builtin flag; take the user's
        // saved enabled/interval/config + last-run state + run history.
        this.jobs.set(j.id, {
          ...existing,
          name: typeof j.name === 'string' ? j.name : existing.name,
          description: typeof j.description === 'string' ? j.description : existing.description,
          enabled: !!j.enabled,
          intervalMinutes: typeof j.intervalMinutes === 'number' ? j.intervalMinutes : existing.intervalMinutes,
          config: { ...existing.config, ...(j.config || {}) },
          lastRunAt: j.lastRunAt ?? existing.lastRunAt,
          lastResult: j.lastResult ?? existing.lastResult,
          lastStatus: j.lastStatus ?? existing.lastStatus,
          lastRun: j.lastRun ?? existing.lastRun,
          runLog: Array.isArray(j.runLog) ? j.runLog : existing.runLog,
          runCount: typeof j.runCount === 'number' ? j.runCount : existing.runCount,
          updatedAt: j.updatedAt || existing.updatedAt,
        });
      } else {
        this.jobs.set(j.id, { ...j, builtin: false });
      }
    }
  }

  private persist(): void {
    try {
      const f = jobsFilePath();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      this.mergeHandEdits(f); // never silently clobber an operator's edit
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
      fs.renameSync(tmp, f); // atomic replace
      this.mutatedSinceSync.clear(); // disk now reflects this process's mutations
      try { this.lastDiskMtimeMs = fs.statSync(f).mtimeMs; } catch { /* keep the old mark */ }
    } catch (e: any) {
      console.error(`[ScheduledJobs] persist failed: ${e?.message || e}`);
    }
  }

  /**
   * Guard against silently losing a hand-edit: persist() rewrites the WHOLE file from memory,
   * so an operator editing scheduled-jobs.json while Core runs (e.g. disarming a job during an
   * incident) used to lose that edit on the next in-process mutation. Before overwriting,
   * compare the file's mtime with the last read/write THIS process made; if the file is newer,
   * adopt the on-disk enabled/schedule/config fields for every job this process has NOT itself
   * mutated since the last sync — and log the hand-edit loudly. (Run state — lastRun/runLog —
   * stays in-memory: this process's runs are always newer than the edited file's copies.)
   */
  private mergeHandEdits(f: string): void {
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(f).mtimeMs; } catch { return; } // no file yet → nothing to merge
    if (mtimeMs <= this.lastDiskMtimeMs) return;
    let arr: unknown;
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e: any) {
      console.error(`[ScheduledJobs] ⚠️ HAND-EDIT DETECTED in ${f} but the file is unparseable (${e?.message || e}) — keeping in-memory state`);
      return;
    }
    if (!Array.isArray(arr)) return;
    const taken: string[] = [];
    const kept: string[] = [];
    for (const d of arr as Array<Partial<ScheduledJob>>) {
      if (!d || typeof d.id !== 'string') continue;
      const mem = this.jobs.get(d.id);
      if (!mem) continue; // hand-added/hand-deleted jobs are reconciled on the next Core start
      if (this.mutatedSinceSync.has(d.id)) { kept.push(d.id); continue; } // our change is newer than the edit
      const enabled = typeof d.enabled === 'boolean' ? d.enabled : mem.enabled;
      const intervalMinutes = typeof d.intervalMinutes === 'number' ? d.intervalMinutes : mem.intervalMinutes;
      const config = d.config && typeof d.config === 'object' && !Array.isArray(d.config)
        ? { ...mem.config, ...d.config }
        : mem.config;
      if (enabled !== mem.enabled || intervalMinutes !== mem.intervalMinutes || JSON.stringify(config) !== JSON.stringify(mem.config)) {
        this.jobs.set(d.id, { ...mem, enabled, intervalMinutes, config });
        taken.push(`${d.id}${enabled !== mem.enabled ? ` (enabled→${enabled})` : ''}`);
      }
    }
    console.error(
      `[ScheduledJobs] ⚠️ HAND-EDIT DETECTED: ${f} was modified outside this process — ` +
        (taken.length ? `adopted on-disk enabled/schedule/config for: ${taken.join(', ')}` : 'no adoptable differences') +
        (kept.length ? `; kept this process's newer values for: ${kept.join(', ')}` : ''),
    );
  }

  start(): void {
    if (this._started) return;
    this._started = true;
    this.load();
    this.registerDefaults();
    this.tickTimer = setInterval(() => {
      this.tick().catch((e) => console.error('[ScheduledJobs] tick error:', e?.message || e));
    }, TICK_MS);
    this.tickTimer.unref?.();
    const enabled = [...this.jobs.values()].filter((j) => j.enabled).length;
    console.log(`[ScheduledJobs] started — ${this.jobs.size} job(s), ${enabled} enabled`);
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.log('[ScheduledJobs] stopped');
  }

  private async tick(): Promise<void> {
    if (!this._started) return;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (this.running.has(job.id)) continue;
      if (!isJobDue(job, now)) continue;
      await this.runJob(job.id, {});
    }
  }

  /**
   * Run one job now. `force` = a manual trigger (bypasses the interval gate AND execution conditions —
   * the user explicitly asked). `trigger:'test'` = a verification run that captures full output but does
   * NOT advance the schedule clock or run count. `dryRunForced` makes a templated/destructive handler
   * preview-only. The tick calls with no opts → trigger 'schedule' (conditions apply).
   */
  async runJob(
    id: string,
    opts: { force?: boolean; dryRunForced?: boolean; trigger?: JobTrigger } = {},
  ): Promise<ScheduledJobView | null> {
    this.load();
    const job = this.jobs.get(id);
    if (!job) return null;
    // LM_DISABLE_JOBS kill switch — checked at RUN TIME so it beats any store state and
    // survives a dist-sync. An env-disabled job never executes, on ANY trigger (an emergency
    // override outranks even an explicit manual run — lift the env var to run the job).
    if (envDisabledJobIds().has(id)) {
      if (!this.envDisabledLogged.has(id)) {
        this.envDisabledLogged.add(id);
        console.log(`[ScheduledJobs] "${id}" is disabled by LM_DISABLE_JOBS — never executing (overrides store state; unset the env var and restart-free to re-enable)`);
      }
      return this.viewOf(job);
    }
    this.envDisabledLogged.delete(id); // env lifted → a future re-listing logs again
    if (this.running.has(id)) return this.viewOf(job);
    const trigger: JobTrigger = opts.trigger || (opts.force ? 'manual' : 'schedule');
    if (trigger === 'schedule' && !job.enabled) return this.viewOf(job); // disabled → no-op on a tick

    this.running.add(id);
    const start = Date.now();
    let conditionNote: string | undefined;
    try {
      // Execution conditions gate AUTOMATIC (scheduled) runs only — an explicit run/test bypasses them.
      if (trigger === 'schedule') {
        if (reachedMaxRuns(job)) {
          return this.finishRun(job, { at: iso(start), status: 'skipped', trigger, durationMs: 0,
            result: `skipped: reached maxRuns (${job.config?.maxRuns})` });
        }
        const runIf = typeof job.config?.runIf === 'string' ? job.config.runIf.trim() : '';
        if (runIf) {
          const g = await this.evalGuard(runIf, job.config?.cwd, job.config?.timeoutMs);
          conditionNote = `runIf exit ${g.code}${g.output ? `: ${g.output}` : ''}`;
          if (!g.ok) {
            return this.finishRun(job, { at: iso(start), status: 'skipped', trigger, durationMs: Date.now() - start,
              result: `skipped: condition not met (runIf exit ${g.code})`, condition: conditionNote });
          }
        }
      }
      const handler = this.handlers.get(job.type);
      const outcome: JobRunOutcome = handler
        ? await handler(job.config || {}, { dryRunForced: !!opts.dryRunForced })
        : { result: `no handler registered for type "${job.type}"`, status: 'error' };
      return this.finishRun(job, {
        at: iso(start), status: outcome.status ?? 'ok', result: outcome.result, trigger,
        exitCode: outcome.exitCode, durationMs: Date.now() - start,
        stdout: outcome.stdout, stderr: outcome.stderr, condition: conditionNote,
      });
    } catch (e: any) {
      return this.finishRun(job, { at: iso(start), status: 'error', trigger, durationMs: Date.now() - start,
        result: `Error: ${e?.message || e}`, condition: conditionNote });
    } finally {
      this.running.delete(id); // safety net (idempotent on a Set)
    }
  }

  /** Persist a finished run record onto the job and return a fresh view. */
  private finishRun(job: ScheduledJob, record: JobRunRecord): ScheduledJobView {
    const updated = applyRun(job, record, Date.now());
    this.jobs.set(job.id, updated);
    this.persist();
    this.running.delete(job.id); // clear before viewOf so the snapshot isn't stale
    const tag = record.trigger === 'test' ? 'tested' : record.status === 'skipped' ? 'skipped' : 'ran';
    console.log(`[ScheduledJobs] ${tag} "${job.id}": ${record.result}`);
    return this.viewOf(updated);
  }

  /** Run a guard command (config.runIf); a scheduled job only fires when it exits 0. */
  private async evalGuard(command: string, cwd?: unknown, timeoutMs?: unknown): Promise<{ ok: boolean; code: number; output: string }> {
    const cp = require('child_process');
    const opts = {
      cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
      timeout: clampTimeoutMs(timeoutMs),
      maxBuffer: 256 * 1024,
      windowsHide: true,
    };
    return await new Promise((resolve) => {
      try {
        cp.exec(command, opts, (err: any, stdout: string, stderr: string) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ ok: code === 0, code, output: ((stdout || '').trim() || (stderr || '').trim()).slice(0, 200) });
        });
      } catch (e: any) {
        resolve({ ok: false, code: 1, output: `guard spawn failed: ${e?.message || e}` });
      }
    });
  }

  /** The run-log history (newest first), or [] if none. */
  getLogs(id: string): JobRunRecord[] {
    this.load();
    return this.jobs.get(id)?.runLog ?? [];
  }

  private viewOf(job: ScheduledJob): ScheduledJobView {
    const disabledByEnv = envDisabledJobIds().has(job.id);
    const ms = disabledByEnv ? null : nextRunAtMs(job, Date.now()); // it will never fire while overridden
    return { ...job, nextRunAt: ms == null ? null : iso(ms), isRunning: this.running.has(job.id), disabledByEnv };
  }

  listJobs(): ScheduledJobView[] {
    this.load();
    return [...this.jobs.values()].map((j) => this.viewOf(j));
  }

  getJob(id: string): ScheduledJobView | null {
    this.load();
    const j = this.jobs.get(id);
    return j ? this.viewOf(j) : null;
  }

  /**
   * Create or update a job. For a built-in, identity/type/builtin are preserved
   * and only enabled/intervalMinutes/config are taken from the patch.
   */
  upsertJob(patch: Partial<ScheduledJob> & { id: string }): ScheduledJobView {
    this.load();
    const now = Date.now();
    const existing = this.jobs.get(patch.id);
    if (existing) {
      const updated: ScheduledJob = {
        ...existing,
        name: typeof patch.name === 'string' ? patch.name : existing.name,
        description: typeof patch.description === 'string' ? patch.description : existing.description,
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled,
        intervalMinutes:
          typeof patch.intervalMinutes === 'number' ? patch.intervalMinutes : existing.intervalMinutes,
        config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
        // type is immutable for built-ins; for custom jobs it may be re-pointed.
        type: existing.builtin ? existing.type : patch.type || existing.type,
        updatedAt: iso(now),
      };
      this.jobs.set(patch.id, updated);
      this.mutatedSinceSync.add(patch.id); // an API/MCP edit outranks a concurrent hand-edit
      this.persist();
      return this.viewOf(updated);
    }
    const created: ScheduledJob = {
      id: patch.id,
      name: typeof patch.name === 'string' ? patch.name : undefined,
      description: typeof patch.description === 'string' ? patch.description : undefined,
      type: patch.type || 'noop',
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : false,
      intervalMinutes: typeof patch.intervalMinutes === 'number' ? patch.intervalMinutes : 1440,
      config: patch.config || {},
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      lastRun: null,
      runLog: [],
      runCount: 0,
      builtin: false,
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    this.jobs.set(created.id, created);
    this.mutatedSinceSync.add(created.id);
    this.persist();
    return this.viewOf(created);
  }

  /** Delete a custom job. Built-ins cannot be deleted (returns false) — disable them instead. */
  deleteJob(id: string): boolean {
    this.load();
    const j = this.jobs.get(id);
    if (!j || j.builtin) return false;
    this.jobs.delete(id);
    this.persist();
    return true;
  }
}

// ── Singleton ──────────────────────────────────────────

let instance: ScheduledJobs | null = null;

export function getScheduledJobs(): ScheduledJobs {
  if (!instance) instance = new ScheduledJobs();
  return instance;
}
