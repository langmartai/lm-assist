/**
 * Data snapshot — the built-in `data-snapshot` scheduled job.
 *
 * Replication is not backup: a fleet dataset's replicas take a bad bulk write within one
 * reconcile, and a cluster-scoped dataset on a one-node cluster has no other copy at all.
 * This job writes a point-in-time bundle — the same default export as `POST /data/bundles`
 * (every owned non-system dataset + sanitized config) — under note `scheduled`. The bundle
 * store prunes the oldest afterwards (`bundleRetention` in project-settings, default 20), so
 * a daily run keeps ~20 days of restore points without growing the disk.
 *
 * Ships DISABLED (see makeBuiltinJobs): it writes to disk on every node the build reaches,
 * so a human turns it on per node. `config.includeReplicas / includeKnowledge /
 * includeClaudeMemory` opt into the same extras an interactive export offers — seeded false,
 * so a seeded run IS the default export. A forced dry-run (preview) writes and prunes nothing.
 *
 * Refusals (DISK_LOW, EXPORT_INCOMPLETE, …) come back as a FAILED run whose result starts
 * with the code, so `lastStatus: 'error'` + `lastResult` say why without opening a log.
 */
import type { ExportOptions, ExportResult } from '../data/bundle';

export const DATA_SNAPSHOT_JOB_ID = 'data-snapshot';
/** The manifest note every scheduled bundle carries — how a list tells them from manual ones. */
export const DATA_SNAPSHOT_NOTE = 'scheduled';

/** The export extras a job config may switch on (anything else in config is ignored). */
const OPT_INS = ['includeReplicas', 'includeKnowledge', 'includeClaudeMemory'] as const;

const STDOUT_MAX = 8_000; // same bound the scheduler applies to a shell job's captured output

export interface DataSnapshotOutcome {
  result: string;
  status: 'ok' | 'error' | 'skipped';
  stdout?: string;
}

export interface DataSnapshotDeps {
  /** The export entry point (default: getBundleService().createExport). */
  createExport?: (opts: ExportOptions) => Promise<ExportResult>;
  /** Bundles the store keeps — only used to describe a preview (default: readBundleRetention). */
  retention?: () => number;
}

/** A flag the connector may have stringified: only `true` / `"true"` count. */
const on = (v: unknown): boolean => v === true || v === 'true';

/**
 * The export options for a scheduled run: note `scheduled` plus the opted-in extras. Section
 * and dataset selection are deliberately not job options — a snapshot is always the default
 * export, so a restore point never silently misses a dataset someone deselected once.
 */
export function snapshotOptions(config: Record<string, unknown>): ExportOptions {
  const o: ExportOptions = { note: DATA_SNAPSHOT_NOTE };
  for (const k of OPT_INS) if (on(config?.[k])) o[k] = true;
  return o;
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One-line job result + a bounded per-section listing for the run record's output. */
export function formatSnapshotResult(r: ExportResult): DataSnapshotOutcome {
  const byKind = { dataset: 0, config: 0, files: 0 };
  let records = 0;
  let tombstones = 0;
  let sectionWarnings = 0;
  const lines: string[] = [];
  for (const s of r.sections) {
    byKind[s.kind]++;
    sectionWarnings += s.warnings?.length ?? 0;
    if (s.kind === 'dataset') {
      records += s.count;
      tombstones += s.tombstones ?? 0;
      lines.push(`dataset ${s.id}: ${plural(s.count, 'record')}${s.tombstones ? ` (${plural(s.tombstones, 'tombstone')})` : ''}`);
    } else if (s.kind === 'files') {
      lines.push(`files ${s.id}: ${plural(s.count, 'file')}`);
    } else {
      lines.push(`config ${s.id}${s.redactedKeys?.length ? ` (redacted: ${s.redactedKeys.join(', ')})` : ''}`);
    }
    for (const w of s.warnings ?? []) lines.push(`  warning: ${w}`);
  }
  for (const x of r.excluded) lines.push(`excluded ${x.id}: ${x.reason}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  if (r.pruned.length) lines.push(`pruned: ${r.pruned.join(', ')}`);

  const kinds = ([
    [byKind.dataset, 'dataset'], [byKind.config, 'config', 'config'], [byKind.files, 'files section'],
  ] as Array<[number, string, string?]>).filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));
  const warnings = r.warnings.length + sectionWarnings;
  const result = [
    `bundle ${r.bundleId} ${fmtSize(r.sizeBytes)}`,
    `${plural(r.sections.length, 'section')}${kinds.length ? ` (${kinds.join(', ')})` : ''}`
      + (byKind.dataset ? `, ${plural(records, 'record')}${tombstones ? `, ${plural(tombstones, 'tombstone')}` : ''}` : ''),
    ...(r.pruned.length ? [`pruned ${r.pruned.length}`] : []),
    ...(warnings ? [plural(warnings, 'warning')] : []),
  ].join(' · ');
  const out = lines.join('\n');
  return { result, status: 'ok', stdout: out.length <= STDOUT_MAX ? out : `${out.slice(0, STDOUT_MAX)}… (+${out.length - STDOUT_MAX} more)` };
}

/** A refused/failed export as a failed run: `<CODE>: <why>`, with DISK_LOW's numbers readable. */
export function formatSnapshotError(e: unknown): DataSnapshotOutcome {
  const err = e as { code?: unknown; message?: unknown; details?: Record<string, unknown> } | null;
  const code = typeof err?.code === 'string' && err.code ? err.code : 'INTERNAL';
  const msg = typeof err?.message === 'string' && err.message ? err.message : String(e);
  if (code === 'DISK_LOW') {
    const free = Number(err?.details?.freeBytes);
    const need = Number(err?.details?.requiredBytes);
    const nums = Number.isFinite(free) && Number.isFinite(need) ? `${fmtSize(free)} free, ${fmtSize(need)} required` : msg;
    return { result: `DISK_LOW: ${nums} — no bundle written (free disk space or delete old bundles)`, status: 'error' };
  }
  return { result: `${code}: ${msg}`.slice(0, 400), status: 'error' };
}

/** Run one snapshot. Never throws: every failure is a failed run with its code. */
export async function runDataSnapshot(
  config: Record<string, unknown>,
  ctx: { dryRunForced?: boolean },
  deps: DataSnapshotDeps = {},
): Promise<DataSnapshotOutcome> {
  const opts = snapshotOptions(config);
  if (ctx.dryRunForced === true) {
    let keep: number | string = '?';
    try {
      keep = deps.retention
        ? deps.retention()
        : (require('../data/bundle/store') as typeof import('../data/bundle/store')).readBundleRetention();
    } catch { /* describe without it */ }
    const extras = OPT_INS.filter((k) => opts[k]);
    return {
      result: `dry-run: would write a default export (owned datasets + config${extras.length ? ` + ${extras.join(', ')}` : ''}) `
        + `with note "${DATA_SNAPSHOT_NOTE}"; retention keeps the newest ${keep}`,
      status: 'ok',
    };
  }
  const createExport = deps.createExport ?? ((o: ExportOptions) => {
    // Lazy: the scheduler registers every built-in at boot; the bundle stack loads on first run.
    const { getBundleService } = require('../data/bundle') as typeof import('../data/bundle');
    return getBundleService().createExport(o);
  });
  try {
    return formatSnapshotResult(await createExport(opts));
  } catch (e) {
    return formatSnapshotError(e);
  }
}

export function registerDataSnapshot(
  jobs: { registerHandler: (t: string, fn: (config: Record<string, unknown>, ctx: { dryRunForced?: boolean }) => Promise<DataSnapshotOutcome>) => void },
  deps: DataSnapshotDeps = {},
): void {
  jobs.registerHandler(DATA_SNAPSHOT_JOB_ID, (config, ctx) => runDataSnapshot(config || {}, ctx || {}, deps));
}
