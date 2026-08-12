/**
 * Scheduled Jobs Routes
 *
 * Management surface for lm-assist's internal job scheduler (scheduler/scheduled-jobs.ts) —
 * the cron replacement that runs inside Core. List / inspect / configure / arm / trigger jobs.
 *
 *   GET    /scheduler/jobs            List all jobs (+ nextRunAt, isRunning)
 *   GET    /scheduler/jobs/:id        One job
 *   POST   /scheduler/jobs            Create a custom job  { id, type, enabled?, intervalMinutes?, config? }
 *   PUT    /scheduler/jobs/:id        Update a job         { enabled?, intervalMinutes?, config? }
 *   POST   /scheduler/jobs/:id/run    Run now (manual)     { dryRun?: true → force preview-only }
 *   DELETE /scheduler/jobs/:id        Delete a custom job (built-ins can only be disabled)
 *
 * The built-in `cleanup-test-conversations` job ships DISABLED + dryRun. Arming the
 * deletion is the user's action: PUT it { enabled:true, config:{ dryRun:false } }.
 */

import type { RouteHandler, RouteContext } from '../index';
import { getScheduledJobs } from '../../scheduler/scheduled-jobs';

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sanitizeConfig(c: unknown): Record<string, any> | undefined {
  if (c == null) return undefined;
  if (typeof c !== 'object' || Array.isArray(c)) return undefined;
  return c as Record<string, any>;
}

export function createSchedulerRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /scheduler/jobs — list all jobs
    {
      method: 'GET',
      pattern: /^\/scheduler\/jobs$/,
      handler: async () => {
        const jobs = getScheduledJobs().listJobs();
        return { success: true, data: { jobs, count: jobs.length } };
      },
    },

    // GET /scheduler/jobs/:id — one job
    {
      method: 'GET',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const job = getScheduledJobs().getJob(req.params.id);
        if (!job) return { success: false, error: { code: 'NOT_FOUND', message: `No job "${req.params.id}"` } };
        return { success: true, data: job };
      },
    },

    // POST /scheduler/jobs — create a custom job
    {
      method: 'POST',
      pattern: /^\/scheduler\/jobs$/,
      handler: async (req) => {
        const b = req.body || {};
        if (typeof b.id !== 'string' || !JOB_ID_RE.test(b.id)) {
          return { success: false, error: { code: 'INVALID_ID', message: 'id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}' } };
        }
        if (getScheduledJobs().getJob(b.id)) {
          return { success: false, error: { code: 'EXISTS', message: `Job "${b.id}" already exists — use PUT to update` } };
        }
        const job = getScheduledJobs().upsertJob({
          id: b.id,
          name: typeof b.name === 'string' ? b.name : undefined,
          description: typeof b.description === 'string' ? b.description : undefined,
          type: typeof b.type === 'string' ? b.type : 'noop',
          enabled: typeof b.enabled === 'boolean' ? b.enabled : false,
          intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : undefined,
          config: sanitizeConfig(b.config),
        });
        return { success: true, data: job };
      },
    },

    // PUT /scheduler/jobs/:id — update name / description / enabled / interval / config
    {
      method: 'PUT',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const id = req.params.id;
        if (!getScheduledJobs().getJob(id)) {
          return { success: false, error: { code: 'NOT_FOUND', message: `No job "${id}"` } };
        }
        const b = req.body || {};
        const job = getScheduledJobs().upsertJob({
          id,
          name: typeof b.name === 'string' ? b.name : undefined,
          description: typeof b.description === 'string' ? b.description : undefined,
          enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
          intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : undefined,
          config: sanitizeConfig(b.config),
        });
        return { success: true, data: job };
      },
    },

    // POST /scheduler/jobs/:id/run — run now. Body: { dryRun?: true (force preview), test?: true (verify run —
    // captures full output but doesn't advance the schedule / run count) }. Returns the job with `lastRun`
    // (exitCode, durationMs, stdout, stderr) so the caller can verify the result.
    {
      method: 'POST',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)\/run$/,
      handler: async (req) => {
        const id = req.params.id;
        const b = req.body || {};
        const job = await getScheduledJobs().runJob(id, {
          force: true,
          dryRunForced: b.dryRun === true,
          trigger: b.test === true ? 'test' : 'manual',
        });
        if (!job) return { success: false, error: { code: 'NOT_FOUND', message: `No job "${id}"` } };
        if (job.disabledByEnv) {
          // runJob refused (the LM_DISABLE_JOBS kill switch is checked at run time and outranks
          // even an explicit manual run). Say so — returning the unchanged job view here looked
          // exactly like a successful trigger, so the caller never learned the run didn't happen.
          return { success: false, error: { code: 'ENV_DISABLED', message:
            `Job "${id}" is disabled by LM_DISABLE_JOBS in the Core environment — the run was REFUSED and did not execute. ` +
            `Remove "${id}" from LM_DISABLE_JOBS (in the environment Core was launched with) to allow it to run.` } };
        }
        return { success: true, data: job };
      },
    },

    // GET /scheduler/jobs/:id/logs — run history (newest first)
    {
      method: 'GET',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)\/logs$/,
      handler: async (req) => {
        const id = req.params.id;
        if (!getScheduledJobs().getJob(id)) return { success: false, error: { code: 'NOT_FOUND', message: `No job "${id}"` } };
        const logs = getScheduledJobs().getLogs(id);
        return { success: true, data: { id, logs, count: logs.length } };
      },
    },

    // DELETE /scheduler/jobs/:id — delete a custom job
    {
      method: 'DELETE',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)$/,
      handler: async (req) => {
        const id = req.params.id;
        const existing = getScheduledJobs().getJob(id);
        if (!existing) return { success: false, error: { code: 'NOT_FOUND', message: `No job "${id}"` } };
        const deleted = getScheduledJobs().deleteJob(id);
        if (!deleted) {
          // Name the exact lever — an error that says only "disable it" leaves the caller
          // hunting for HOW (the executor-reaper incident's operational lesson).
          return { success: false, error: { code: 'BUILTIN', message:
            `"${id}" is a built-in job and cannot be deleted. Disable it instead: ` +
            `PUT /scheduler/jobs/${id} {"enabled":false} (REST) or ` +
            `scheduler_jobs(action="update", id="${id}", auto_run=false) (MCP). ` +
            `For an emergency stop that survives store rewrites, set LM_DISABLE_JOBS=${id} in the Core environment.` } };
        }
        return { success: true, data: { deleted: id } };
      },
    },
  ];
}
