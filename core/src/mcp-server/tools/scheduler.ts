/**
 * Scheduled-jobs MCP tool — manage lm-assist's internal job scheduler (the cron
 * replacement that runs inside Core) over the connector.
 *
 *   scheduler_jobs(action="list")                              → list jobs + status
 *   scheduler_jobs(action="get", id="…")                       → one job
 *   scheduler_jobs(action="run", id="…", dry_run=true)         → trigger now (preview-only when dry_run)
 *   scheduler_jobs(action="update", id="…", enabled=…, interval_minutes=…, config={…})
 *   scheduler_jobs(action="create", id="…", type="…", …)       → add a custom job
 *   scheduler_jobs(action="delete", id="…")                    → remove a custom job
 *
 * Delegates to the /scheduler/jobs REST routes on the worker (same logic, one source of truth).
 * NOTE: connector args arrive as STRINGS — enabled/interval_minutes/dry_run are coerced; config
 * accepts an object OR a JSON string.
 *
 * SAFETY: the built-in `cleanup-test-conversations` job DELETES claude.ai conversations only once
 * the user ARMS it (update enabled=true, config={dryRun:false}). It ships disabled + dryRun, and a
 * dry-run run just reports what WOULD be deleted. Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS.
 */
import { ok, err, workerGet, workerPost, workerPut, workerDelete, type McpToolResult } from './_passthrough';

export const schedulerJobsToolDef = {
  name: 'scheduler_jobs',
  description:
    "Manage lm-assist's INTERNAL scheduled jobs — the cron replacement that runs inside the worker " +
    '(NOT OS crontab). Trigger words: "scheduled jobs", "schedule a job", "run it daily", "cron", ' +
    '"recurring task", "arm the cleanup", "auto-clean conversations on a schedule", "list scheduled ' +
    'jobs", "disable the scheduled job". `action`: list (default) | get | run | update | create | delete. ' +
    'The built-in `cleanup-test-conversations` job sweeps EXPIRED auto-delete conversations + explicit ' +
    'ids; it ships DISABLED + dryRun (safe). To ARM it: action="update", id="cleanup-test-conversations", ' +
    'enabled=true, config={"dryRun":false}. To preview safely: action="run", id="…", dry_run=true (reports ' +
    'matches, deletes nothing). interval_minutes sets the cadence (1440 = daily). WRITE for ' +
    'run/update/create/delete; list/get are read-only. Runs on the worker (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'run', 'update', 'create', 'delete'],
        description: 'What to do (default "list").',
      },
      id: { type: 'string', description: 'Job id (required for get/run/update/create/delete).' },
      type: { type: 'string', description: 'Handler type (create only). Use "noop" for a placeholder.' },
      enabled: { type: 'boolean', description: 'Master on/off (create/update). Arming the cleanup job needs enabled=true.' },
      interval_minutes: { type: 'number', description: 'Run cadence in minutes (create/update). 1440 = daily. <=0 pauses.' },
      config: {
        type: 'object',
        description: 'Handler config (create/update), merged into existing. For cleanup: {dryRun, ids, patterns, olderThanHours, limit}. dryRun:false ARMS deletion.',
        additionalProperties: true,
      },
      dry_run: { type: 'boolean', description: 'For action="run": force a non-destructive preview even on an armed job.' },
    },
  },
};

export const SCHEDULER_TOOL_DEFS = [schedulerJobsToolDef] as const;

const toBool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
function toConfig(v: unknown): Record<string, any> | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
}

interface JobView {
  id: string;
  type: string;
  enabled: boolean;
  intervalMinutes: number;
  config: Record<string, any>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: string | null;
  builtin: boolean;
  nextRunAt: string | null;
  isRunning: boolean;
}

function fmtJob(j: JobView): string {
  const state = !j.enabled ? 'disabled' : j.intervalMinutes > 0 ? `every ${j.intervalMinutes}m` : 'paused';
  const lines = [
    `- ${j.id}${j.builtin ? ' (built-in)' : ''}  [${state}]`,
    `  type: ${j.type}`,
    `  config: ${JSON.stringify(j.config)}`,
  ];
  if (j.lastRunAt) lines.push(`  last run: ${j.lastRunAt} → ${j.lastStatus}: ${j.lastResult}`);
  if (j.nextRunAt) lines.push(`  next run: ${j.nextRunAt}`);
  if (j.isRunning) lines.push('  (running now)');
  return lines.join('\n');
}

function unwrap(res: any): any {
  if (res && typeof res === 'object' && 'success' in res) {
    if (!res.success) throw new Error(res.error?.message || 'request failed');
    return res.data;
  }
  return res;
}

async function handleSchedulerJobs(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || 'list').toLowerCase();
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  try {
    if (action === 'list') {
      const data = unwrap(await workerGet('/scheduler/jobs')) as { jobs: JobView[]; count: number };
      if (!data.jobs?.length) return ok('No scheduled jobs.');
      return ok(
        `Scheduled jobs (${data.count}):\n\n${data.jobs.map(fmtJob).join('\n\n')}\n\n` +
          '→ scheduler_jobs(action="run", id="…", dry_run=true) to preview; ' +
          'action="update", id="…", enabled=true, config={"dryRun":false} to arm.',
      );
    }
    if (action === 'get') {
      if (!id) return err('id is required for action="get".');
      const data = unwrap(await workerGet(`/scheduler/jobs/${encodeURIComponent(id)}`)) as JobView;
      return ok(fmtJob(data));
    }
    if (action === 'run') {
      if (!id) return err('id is required for action="run".');
      const dryRun = toBool(args.dry_run);
      const data = unwrap(await workerPost(`/scheduler/jobs/${encodeURIComponent(id)}/run`, { dryRun: dryRun === true })) as JobView;
      return ok(`Ran "${id}":\n${data.lastStatus}: ${data.lastResult}\n\n${fmtJob(data)}`);
    }
    if (action === 'update') {
      if (!id) return err('id is required for action="update".');
      const body: Record<string, unknown> = {};
      const en = toBool(args.enabled);
      if (en !== undefined) body.enabled = en;
      const iv = toNum(args.interval_minutes);
      if (iv !== undefined) body.intervalMinutes = iv;
      const cfg = toConfig(args.config);
      if (cfg) body.config = cfg;
      if (Object.keys(body).length === 0) return err('Nothing to update — pass enabled, interval_minutes, and/or config.');
      const data = unwrap(await workerPut(`/scheduler/jobs/${encodeURIComponent(id)}`, body)) as JobView;
      return ok(`Updated "${id}":\n${fmtJob(data)}`);
    }
    if (action === 'create') {
      if (!id) return err('id is required for action="create".');
      const body: Record<string, unknown> = { id, type: typeof args.type === 'string' ? args.type : 'noop' };
      const en = toBool(args.enabled);
      if (en !== undefined) body.enabled = en;
      const iv = toNum(args.interval_minutes);
      if (iv !== undefined) body.intervalMinutes = iv;
      const cfg = toConfig(args.config);
      if (cfg) body.config = cfg;
      const data = unwrap(await workerPost('/scheduler/jobs', body)) as JobView;
      return ok(`Created "${id}":\n${fmtJob(data)}`);
    }
    if (action === 'delete') {
      if (!id) return err('id is required for action="delete".');
      const data = unwrap(await workerDelete(`/scheduler/jobs/${encodeURIComponent(id)}`)) as { deleted: string };
      return ok(`Deleted job "${data.deleted}".`);
    }
    return err(`Unknown action "${action}". Use list | get | run | update | create | delete.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const SCHEDULER_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  scheduler_jobs: handleSchedulerJobs,
};
