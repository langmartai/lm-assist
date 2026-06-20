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
 * SAFETY: the one built-in job (`cleanup-test-conversations`) deletes claude.ai
 * conversations when armed. It ships DISABLED with dryRun=true. The user arms
 * the actual deletion (set enabled + config.dryRun=false) themselves — the
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

export interface ScheduledJob {
  /** Stable id. Built-in ids are reserved (e.g. 'cleanup-test-conversations'). */
  id: string;
  /** Handler key in the registry (built-ins set this to their id). */
  type: string;
  /** Master on/off. Built-ins ship disabled. */
  enabled: boolean;
  /** Run cadence in minutes. <=0 means "paused" (never fires even if enabled). */
  intervalMinutes: number;
  /** Handler-specific options (e.g. { dryRun, ids, patterns, olderThanHours }). */
  config: Record<string, any>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: JobStatus | null;
  /** Built-in jobs cannot be deleted (only disabled/configured). */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobRunOutcome {
  result: string;
  status?: JobStatus;
}

/** A handler receives the job's config and a ctx flag, and returns a one-line outcome. */
export type JobHandler = (
  config: Record<string, any>,
  ctx: { dryRunForced: boolean },
) => Promise<JobRunOutcome>;

export type ScheduledJobView = ScheduledJob & { nextRunAt: string | null; isRunning: boolean };

// ── Pure scheduling logic (unit-tested) ──────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

/** Is this job due to run at nowMs? Disabled / paused / not-yet-elapsed → false. */
export function isJobDue(job: ScheduledJob, nowMs: number): boolean {
  if (!job.enabled) return false;
  if (!job.intervalMinutes || job.intervalMinutes <= 0) return false;
  if (!job.lastRunAt) return true; // never run → due immediately
  const last = Date.parse(job.lastRunAt);
  if (Number.isNaN(last)) return true; // unparseable timestamp → treat as never-run
  return nowMs - last >= job.intervalMinutes * 60_000;
}

/** When will this job next fire (ms)? null if disabled/paused. A never-run job → now. */
export function nextRunAtMs(job: ScheduledJob, nowMs: number): number | null {
  if (!job.enabled) return null;
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
  };
}

/** The built-in jobs, seeded on first load. All ship inert (disabled). */
export function makeBuiltinJobs(nowMs: number): ScheduledJob[] {
  const at = iso(nowMs);
  return [
    {
      id: 'cleanup-test-conversations',
      type: 'cleanup-test-conversations',
      enabled: false, // SAFE BY DEFAULT — the user arms it
      intervalMinutes: 1440, // daily, once armed
      config: {
        // dryRun TRUE → reports matches without deleting. The user sets dryRun:false to arm deletion.
        dryRun: true,
        // Selection: expired lm-autodel markers + these explicit ids. No name patterns by default,
        // so a conversation without a (valid, expired) TTL marker is never swept.
        ids: [] as string[],
        patterns: [] as string[],
        olderThanHours: 0,
        limit: 200,
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

class ScheduledJobs {
  private jobs: Map<string, ScheduledJob> = new Map();
  private handlers: Map<string, JobHandler> = new Map();
  private running: Set<string> = new Set();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private _started = false;
  private loaded = false;

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
      const { cleanupTestConversations } = require('../utils/claudeai-session');
      // dryRun defaults TRUE; only an explicit config.dryRun===false arms deletion.
      // A forced dry-run (preview "Run now") always wins, so a preview never deletes.
      const armed = config.dryRun === false;
      const dryRun = ctx.dryRunForced ? true : !armed;
      const res = await cleanupTestConversations({
        dryRun,
        ids: Array.isArray(config.ids) ? config.ids : undefined,
        patterns: Array.isArray(config.patterns) && config.patterns.length ? config.patterns : undefined,
        olderThanHours: typeof config.olderThanHours === 'number' ? config.olderThanHours : undefined,
        limit: typeof config.limit === 'number' ? config.limit : undefined,
      });
      const matched = res.matched?.length ?? 0;
      const result = dryRun
        ? `dry-run: ${matched} conversation(s) would be deleted`
        : `deleted ${res.deleted?.length ?? 0}/${matched}` + (res.failed?.length ? `, ${res.failed.length} failed` : '');
      return { result, status: res.failed?.length ? 'error' : 'ok' };
    });
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
    if (!Array.isArray(arr)) arr = [];
    for (const j of arr) {
      if (!j || typeof j.id !== 'string') continue;
      const existing = this.jobs.get(j.id);
      if (existing?.builtin) {
        // Preserve the built-in's identity/type/builtin flag; take the user's
        // saved enabled/interval/config + last-run state.
        this.jobs.set(j.id, {
          ...existing,
          enabled: !!j.enabled,
          intervalMinutes: typeof j.intervalMinutes === 'number' ? j.intervalMinutes : existing.intervalMinutes,
          config: { ...existing.config, ...(j.config || {}) },
          lastRunAt: j.lastRunAt ?? existing.lastRunAt,
          lastResult: j.lastResult ?? existing.lastResult,
          lastStatus: j.lastStatus ?? existing.lastStatus,
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
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
      fs.renameSync(tmp, f); // atomic replace
    } catch (e: any) {
      console.error(`[ScheduledJobs] persist failed: ${e?.message || e}`);
    }
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
   * Run one job now. `force` bypasses the interval gate (manual trigger).
   * `dryRunForced` makes a destructive handler preview-only regardless of config.
   */
  async runJob(id: string, opts: { force?: boolean; dryRunForced?: boolean } = {}): Promise<ScheduledJobView | null> {
    this.load();
    const job = this.jobs.get(id);
    if (!job) return null;
    if (this.running.has(id)) return this.viewOf(job);
    if (!opts.force && !opts.dryRunForced && !job.enabled) {
      // A non-forced run of a disabled job is a no-op (the tick path already gates on enabled).
      return this.viewOf(job);
    }

    const handler = this.handlers.get(job.type);
    this.running.add(id);
    try {
      let outcome: JobRunOutcome;
      if (!handler) {
        outcome = { result: `no handler registered for type "${job.type}"`, status: 'error' };
      } else {
        outcome = await handler(job.config || {}, { dryRunForced: !!opts.dryRunForced });
      }
      const updated = applyJobResult(job, outcome, Date.now());
      this.jobs.set(id, updated);
      this.persist();
      console.log(`[ScheduledJobs] ran "${id}": ${outcome.result}`);
      this.running.delete(id); // clear before viewOf so the returned snapshot isn't stale
      return this.viewOf(updated);
    } catch (e: any) {
      const updated = applyJobResult(job, { result: `Error: ${e?.message || e}`, status: 'error' }, Date.now());
      this.jobs.set(id, updated);
      this.persist();
      console.error(`[ScheduledJobs] job "${id}" failed: ${e?.message || e}`);
      this.running.delete(id);
      return this.viewOf(updated);
    } finally {
      this.running.delete(id); // safety net (idempotent on a Set)
    }
  }

  private viewOf(job: ScheduledJob): ScheduledJobView {
    const ms = nextRunAtMs(job, Date.now());
    return { ...job, nextRunAt: ms == null ? null : iso(ms), isRunning: this.running.has(job.id) };
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
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled,
        intervalMinutes:
          typeof patch.intervalMinutes === 'number' ? patch.intervalMinutes : existing.intervalMinutes,
        config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
        // type is immutable for built-ins; for custom jobs it may be re-pointed.
        type: existing.builtin ? existing.type : patch.type || existing.type,
        updatedAt: iso(now),
      };
      this.jobs.set(patch.id, updated);
      this.persist();
      return this.viewOf(updated);
    }
    const created: ScheduledJob = {
      id: patch.id,
      type: patch.type || 'noop',
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : false,
      intervalMinutes: typeof patch.intervalMinutes === 'number' ? patch.intervalMinutes : 1440,
      config: patch.config || {},
      lastRunAt: null,
      lastResult: null,
      lastStatus: null,
      builtin: false,
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    this.jobs.set(created.id, created);
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
