/**
 * Scheduled-jobs MCP tool — manage lm-assist's internal job scheduler (the cron replacement that runs
 * inside Core) over the connector. Designed so an LLM can, in one call:
 *   • CREATE AN AUTO-RUN JOB:  scheduler_jobs(action="create", id="backup", command="…", interval_minutes=60, auto_run=true)
 *   • TEST-RUN + VERIFY:       scheduler_jobs(action="test", id="backup")  → returns status, exit code, duration, stdout, stderr
 *   • inspect history:         scheduler_jobs(action="logs", id="backup")
 *
 * Other actions: list | get | run (real manual run) | update | delete.
 *
 * Delegates to the /scheduler/jobs REST routes on the worker (one source of truth).
 * NOTE: connector args arrive as STRINGS — booleans/numbers are coerced; flat params (command, run_if,
 * max_runs, cwd, timeout_ms, dry_run) are folded into the job's config so the caller never builds a config blob.
 */
import { ok, err, workerGet, workerPost, workerPut, workerDelete, type McpToolResult } from './_passthrough';

export const schedulerJobsToolDef = {
  name: 'scheduler_jobs',
  description:
    "Manage lm-assist's INTERNAL scheduled jobs — the cron replacement that runs inside the worker (NOT OS " +
    'crontab). Trigger words: "schedule a job", "run it every N minutes/daily", "cron", "recurring task", ' +
    '"auto-run", "background job", "test the job", "show job logs/output". `action`: list (default) | get | ' +
    'create | test | run | update | delete | logs.\n' +
    '• CREATE AN AUTO-RUNNING JOB in one call: action="create", id="my-job", command="<shell command>", ' +
    'interval_minutes=60, auto_run=true. (auto_run=true enables it so the scheduler runs it on the interval.)\n' +
    '• TEST-RUN AND VERIFY: action="test", id="my-job" → runs it once NOW and returns status + exit code + ' +
    'duration + stdout + stderr, WITHOUT advancing the schedule or run count. Use this to confirm a job works ' +
    'before/after enabling it.\n' +
    '• EXECUTION CONDITIONS: run_if="<guard command>" makes a scheduled run fire only if the guard exits 0; ' +
    'max_runs=N stops auto-running after N runs. (Conditions gate scheduled runs; an explicit run/test bypasses them.)\n' +
    'command as a STRING runs in a shell (pipes/&&/redirects); a `{{dryRun}}` placeholder + dry_run toggles ' +
    'preview⟷live. The built-in `cleanup-test-conversations` job deletes claude.ai test convs (ships disabled+dryRun). ' +
    'WRITE for create/test/run/update/delete; list/get/logs are read-only. Runs on the worker (use `node`).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'test', 'run', 'update', 'delete', 'logs'], description: 'What to do (default "list").' },
      id: { type: 'string', description: 'Job id (required for everything except list).' },
      name: { type: 'string', description: 'Human-readable name (create/update).' },
      description: { type: 'string', description: 'What the job does (create/update).' },
      command: { type: 'string', description: 'Shell command to run (create/update). Sets type=shell. Pipes/&&/redirects work.' },
      interval_minutes: { type: 'number', description: 'Run cadence in minutes (create/update). 60=hourly, 1440=daily. <=0 pauses.' },
      auto_run: { type: 'boolean', description: 'Enable the job so the scheduler runs it on its interval (create/update). Default false.' },
      run_if: { type: 'string', description: 'Guard command — a SCHEDULED run only fires if this exits 0 (an execution condition).' },
      max_runs: { type: 'number', description: 'Stop auto-running after this many runs (0 = no cap).' },
      cwd: { type: 'string', description: 'Working directory for the command/guard.' },
      timeout_ms: { type: 'number', description: 'Per-run timeout in ms (clamped 1s–10m).' },
      dry_run: { type: 'boolean', description: 'For action="test"/"run": force a preview (no destructive action) on a {{dryRun}}-templated or cleanup job.' },
      type: { type: 'string', description: 'Handler type for create (default "shell" when a command is given, else "noop").' },
      config: { type: 'object', additionalProperties: true, description: 'Advanced: raw config overrides, merged after the flat params.' },
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
function toConfigObj(v: unknown): Record<string, any> | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : undefined; } catch { return undefined; } }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined;
}

/** Fold the flat params (command/run_if/max_runs/cwd/timeout_ms/dry_run) + explicit config into one config object. */
function buildConfig(args: Record<string, unknown>): Record<string, any> | undefined {
  const cfg: Record<string, any> = {};
  if (typeof args.command === 'string') cfg.command = args.command;
  if (typeof args.run_if === 'string' && args.run_if.trim()) cfg.runIf = args.run_if;
  const maxRuns = toNum(args.max_runs); if (maxRuns !== undefined) cfg.maxRuns = maxRuns;
  if (typeof args.cwd === 'string' && args.cwd) cfg.cwd = args.cwd;
  const timeout = toNum(args.timeout_ms); if (timeout !== undefined) cfg.timeoutMs = timeout;
  const dry = toBool(args.dry_run); if (dry !== undefined) cfg.dryRun = dry;
  const explicit = toConfigObj(args.config); if (explicit) Object.assign(cfg, explicit);
  return Object.keys(cfg).length ? cfg : undefined;
}

interface JobView {
  id: string; name?: string; description?: string; type: string; enabled: boolean; intervalMinutes: number;
  config: Record<string, any>; lastRunAt: string | null; lastResult: string | null; lastStatus: string | null;
  lastRun?: RunRec | null; runLog?: RunRec[]; runCount?: number; builtin: boolean; nextRunAt: string | null; isRunning: boolean;
}
interface RunRec { at: string; status: string; result: string; trigger: string; exitCode?: number | null; durationMs?: number; stdout?: string; stderr?: string; condition?: string; }

function fmtJob(j: JobView): string {
  const state = !j.enabled ? 'disabled' : j.intervalMinutes > 0 ? `every ${j.intervalMinutes}m` : 'paused';
  const lines = [`- ${j.id}${j.name ? `  "${j.name}"` : ''}${j.builtin ? ' (built-in)' : ''}  [${state}]`];
  if (j.description) lines.push(`  ${j.description}`);
  lines.push(`  type: ${j.type}`);
  if (j.config?.command) lines.push(`  command: ${String(j.config.command).slice(0, 160)}`);
  const conds: string[] = [];
  if (j.config?.runIf) conds.push(`runIf: ${String(j.config.runIf).slice(0, 80)}`);
  if (j.config?.maxRuns) conds.push(`maxRuns: ${j.config.maxRuns} (run ${j.runCount ?? 0}×)`);
  if (conds.length) lines.push(`  conditions: ${conds.join(' · ')}`);
  if (j.lastRun) {
    const r = j.lastRun;
    lines.push(`  last run: ${r.at} [${r.trigger}] → ${r.status}` + (r.exitCode != null ? ` (exit ${r.exitCode}` : '') + (r.durationMs != null ? `, ${r.durationMs}ms)` : r.exitCode != null ? ')' : ''));
    lines.push(`    ${r.result}`);
  } else if (j.lastResult) {
    lines.push(`  last run: ${j.lastRunAt} → ${j.lastStatus}: ${j.lastResult}`);
  }
  if (j.nextRunAt) lines.push(`  next run: ${j.nextRunAt}`);
  if (j.isRunning) lines.push('  (running now)');
  return lines.join('\n');
}

/** A clear, structured verification block for a test/run result. */
function fmtRunResult(j: JobView, action: string): string {
  const r = j.lastRun;
  if (!r) return `${action} "${j.id}": ${j.lastStatus}: ${j.lastResult}`;
  const head = `${action} "${j.id}"${j.name ? ` (${j.name})` : ''}: ${r.status}` +
    (r.exitCode != null ? ` · exit ${r.exitCode}` : '') + (r.durationMs != null ? ` · ${r.durationMs}ms` : '');
  const out: string[] = [head];
  if (r.condition) out.push(`condition: ${r.condition}`);
  out.push(`summary: ${r.result}`);
  if (r.stdout) out.push(`stdout:\n${r.stdout}`);
  if (r.stderr && r.stderr.trim()) out.push(`stderr:\n${r.stderr}`);
  if (!r.stdout && !r.stderr) out.push('(no captured output)');
  return out.join('\n');
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
  const enc = (s: string) => encodeURIComponent(s);
  try {
    if (action === 'list') {
      const data = unwrap(await workerGet('/scheduler/jobs')) as { jobs: JobView[]; count: number };
      if (!data.jobs?.length) return ok('No scheduled jobs.');
      return ok(
        `Scheduled jobs (${data.count}):\n\n${data.jobs.map(fmtJob).join('\n\n')}\n\n` +
          '→ create one: scheduler_jobs(action="create", id="…", command="…", interval_minutes=60, auto_run=true). ' +
          'Test it: action="test", id="…".',
      );
    }
    if (action === 'get') {
      if (!id) return err('id is required.');
      return ok(fmtJob(unwrap(await workerGet(`/scheduler/jobs/${enc(id)}`)) as JobView));
    }
    if (action === 'logs') {
      if (!id) return err('id is required.');
      const d = unwrap(await workerGet(`/scheduler/jobs/${enc(id)}/logs`)) as { logs: RunRec[]; count: number };
      if (!d.logs?.length) return ok(`No run history for "${id}".`);
      const lines = d.logs.map((r) => `  ${r.at} [${r.trigger}] ${r.status}` + (r.exitCode != null ? ` exit ${r.exitCode}` : '') + (r.durationMs != null ? ` ${r.durationMs}ms` : '') + ` — ${r.result}`);
      return ok(`Run history for "${id}" (${d.count}, newest first):\n${lines.join('\n')}`);
    }
    if (action === 'create' || action === 'update') {
      if (!id) return err('id is required.');
      const exists = !!(await workerGet(`/scheduler/jobs/${enc(id)}`).then((r) => (r as any)?.success).catch(() => false));
      const body: Record<string, unknown> = { id };
      if (typeof args.name === 'string') body.name = args.name;
      if (typeof args.description === 'string') body.description = args.description;
      if (typeof args.type === 'string') body.type = args.type;
      else if (action === 'create' && typeof args.command === 'string') body.type = 'shell';
      const en = toBool(args.auto_run); if (en !== undefined) body.enabled = en;
      const iv = toNum(args.interval_minutes); if (iv !== undefined) body.intervalMinutes = iv;
      const cfg = buildConfig(args); if (cfg) body.config = cfg;
      if (action === 'update' && !exists) return err(`No job "${id}" to update — use action="create".`);
      if (action === 'create' && exists) return err(`Job "${id}" already exists — use action="update".`);
      const data = unwrap(action === 'create' ? await workerPost('/scheduler/jobs', body) : await workerPut(`/scheduler/jobs/${enc(id)}`, body)) as JobView;
      const hint = data.enabled ? '' : '\n(disabled — pass auto_run=true to schedule it, or action="test" to try it now.)';
      return ok(`${action === 'create' ? 'Created' : 'Updated'} "${id}":\n${fmtJob(data)}${hint}`);
    }
    if (action === 'test' || action === 'run') {
      if (!id) return err('id is required.');
      const dryRun = toBool(args.dry_run);
      const data = unwrap(await workerPost(`/scheduler/jobs/${enc(id)}/run`, { dryRun: dryRun === true, test: action === 'test' })) as JobView;
      return ok(fmtRunResult(data, action === 'test' ? 'Test run of' : 'Ran'));
    }
    if (action === 'delete') {
      if (!id) return err('id is required.');
      const data = unwrap(await workerDelete(`/scheduler/jobs/${enc(id)}`)) as { deleted: string };
      return ok(`Deleted job "${data.deleted}".`);
    }
    return err(`Unknown action "${action}". Use list | get | create | test | run | update | delete | logs.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const SCHEDULER_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  scheduler_jobs: handleSchedulerJobs,
};
