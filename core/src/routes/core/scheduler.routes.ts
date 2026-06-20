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
          type: typeof b.type === 'string' ? b.type : 'noop',
          enabled: typeof b.enabled === 'boolean' ? b.enabled : false,
          intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : undefined,
          config: sanitizeConfig(b.config),
        });
        return { success: true, data: job };
      },
    },

    // PUT /scheduler/jobs/:id — update enabled / interval / config
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
          enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
          intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : undefined,
          config: sanitizeConfig(b.config),
        });
        return { success: true, data: job };
      },
    },

    // POST /scheduler/jobs/:id/run — run now (manual trigger, bypasses the interval gate)
    {
      method: 'POST',
      pattern: /^\/scheduler\/jobs\/(?<id>[^/?]+)\/run$/,
      handler: async (req) => {
        const id = req.params.id;
        const b = req.body || {};
        // dryRun:true forces a non-destructive preview even on an armed job.
        const job = await getScheduledJobs().runJob(id, { force: true, dryRunForced: b.dryRun === true });
        if (!job) return { success: false, error: { code: 'NOT_FOUND', message: `No job "${id}"` } };
        return { success: true, data: job };
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
          return { success: false, error: { code: 'BUILTIN', message: `"${id}" is a built-in job — disable it instead of deleting` } };
        }
        return { success: true, data: { deleted: id } };
      },
    },
  ];
}
