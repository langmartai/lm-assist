/**
 * data_export / data_import MCP tools — portable data bundles and guarded dataset takeover.
 *
 *   data_export  action: inventory (default) | create | list | inspect | delete
 *   data_import  action: plan | apply | fetch | takeover
 *
 * Both wrap the `/data/bundles` REST routes (and POST /data/datasets/:id/takeover) over the
 * loopback hop, so the bundle service stays the single implementation behind REST, MCP, the
 * web Backup tab and the scheduled snapshot. The ROUTE is the auth boundary; the spec lets the
 * node owner export and import from any surface, the claude.ai connector included, and the
 * gateway gates data_import as `admin`.
 *
 * Two rules shape everything below:
 *
 *   1. APPLY IS CONFIRMED OR IT DOES NOT HAPPEN. `apply` without confirm:true never reaches
 *      the apply route: it runs the plan and says, at both ends of the reply, that nothing was
 *      written. A model that skims past the banner still sees it last.
 *   2. RESULTS ARE COMPACT AND SAY WHAT THEY DROP. A plan over a big node can carry dozens of
 *      sections with ten sample ids per bucket and free-text warnings; the renderers print
 *      counts, a few samples, warnings and each refusal's fix, bounded by rows AND bytes, and
 *      every bound that bites is counted in the reply with the argument that narrows it.
 *      Records are never printed. Sizes are asserted by mcp-output-size.test.ts.
 *
 * Errors keep their CODE. The routes answer `{success:false, error:{code,message}}`, and the
 * code is what decides the next step (ORIGIN_ONLINE → import there; ROSTER_UNAVAILABLE →
 * retry, or force only if you know; BUNDLE_CORRUPT → re-fetch), so the handlers read the raw
 * envelope instead of the message-only unwrap.
 *
 * Registration: DATA_BUNDLE_TOOL_DEFS + DATA_BUNDLE_HANDLERS → expanded.ts; TOOL_SCOPES
 * (data_export read, data_import admin) → configure.ts; category `data` →
 * registry/categories.ts; playbook `data` → tool-topics.ts; output budget →
 * tool-output-budget.ts.
 */
import { ok, err, workerGetRaw, workerPostRaw, workerDelete, type McpToolResult } from './_passthrough';
import { boolArg } from './data-tools-format';
import type {
  Inventory, ExportResult, ImportResult, TakeoverResult, CompactSection, BundleService,
  FetchResult, StoredBundleInfo, StoredImportResult, DatasetSectionPlan, PlanCounts, PlanBucket,
} from '../../data/bundle';

// ─── definitions ─────────────────────────────────────────────────────────────

export const DATA_EXPORT_ACTIONS = ['inventory', 'create', 'list', 'inspect', 'delete'] as const;
export const DATA_IMPORT_ACTIONS = ['plan', 'apply', 'fetch', 'takeover'] as const;
/** Mirrors SECTION_GROUPS / IMPORT_POLICIES in data/bundle — kept literal so loading the tool
 *  catalogue never loads the bundle service; mcp-tools.test.ts pins them equal. */
export const SECTION_GROUP_ENUM = ['datasets', 'config', 'knowledge', 'claude-memory', 'claude-rules'];
export const POLICY_ENUM = ['merge', 'add-missing', 'replace'];

export const dataExportToolDef = {
  name: 'data_export',
  description:
    'Back up THIS node\'s lm-assist data as a portable bundle (gzip JSONL stored on the node; secrets never ' +
    'travel). action: inventory (default: what an export holds — owned vs replica datasets, origin online, ' +
    'record counts, sync errors) · create (owned datasets + sanitized config; opt in includeReplicas / ' +
    'includeKnowledge / includeClaudeMemory) · list · inspect · delete (bundle). To move a bundle, run ' +
    'data_import action:fetch on the TARGET node. guide("data").',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: [...DATA_EXPORT_ACTIONS], description: 'Default inventory.' },
      bundle: { type: 'string', description: 'inspect/delete: bundle id (lmb-…).' },
      sections: {
        type: 'array', items: { type: 'string', enum: SECTION_GROUP_ENUM },
        description: 'create: section groups (default datasets + config).',
      },
      datasets: { type: 'array', items: { type: 'string' }, description: 'create: only these dataset ids.' },
      includeReplicas: { type: 'boolean', description: 'create: add replica datasets.' },
      includeKnowledge: { type: 'boolean', description: 'create: add the knowledge base.' },
      includeClaudeMemory: { type: 'boolean', description: 'create: add Claude project memory + own rules.' },
      note: { type: 'string', description: 'create: a label (≤500 chars).' },
    },
  },
};

export const dataImportToolDef = {
  name: 'data_import',
  description:
    'Import a data bundle into THIS node (target it with node). action: plan (dry run — per-section counts, ' +
    'samples, warnings, and each refusal with its fix) · apply (confirm:true required; without it returns ' +
    'the plan and writes nothing) · fetch (copy a bundle from fromNode through the hub, verified) · takeover ' +
    '(promote a local replica whose origin is gone to owned; refused while the origin is online). Import ' +
    'never deletes. policy: merge (default, newer wins) · add-missing · replace (bundle wins as a new ' +
    'version). guide("data").',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: [...DATA_IMPORT_ACTIONS], description: 'plan first, then apply.' },
      bundle: { type: 'string', description: 'lmb-… id, or received:<name> (a file in the transfer inbox). fetch: the id on fromNode.' },
      policy: { type: 'string', enum: POLICY_ENUM, description: 'Default merge.' },
      sections: { type: 'array', items: { type: 'string', enum: SECTION_GROUP_ENUM }, description: 'Only these section groups.' },
      datasets: { type: 'array', items: { type: 'string' }, description: 'Only these dataset ids.' },
      takeOwnership: { type: 'boolean', description: 'Take over a local replica before importing into it.' },
      confirm: { type: 'boolean', description: 'apply: must be true.' },
      fromNode: { type: 'string', description: 'fetch: source node id (hostId from list_nodes).' },
      dataset: { type: 'string', description: 'takeover: dataset id.' },
      force: { type: 'boolean', description: 'Proceed when the fleet roster is unreadable. Never overrides an online owner.' },
    },
    required: ['action'],
  },
};

export const DATA_BUNDLE_TOOL_DEFS = [dataExportToolDef, dataImportToolDef] as const;

// ─── wire shapes (the routes return the bundle service's results as JSON) ────

export type InventoryView = Inventory;
export type ExportView = ExportResult;
export type ImportView = Omit<ImportResult, 'sections'> & { sections: DatasetSectionPlan[] };
export type TakeoverView = TakeoverResult;
export type FetchView = FetchResult;
export type InspectView = Awaited<ReturnType<BundleService['inspect']>>;
export type StoredBundleView = Omit<StoredBundleInfo, 'sections'> & { sections?: CompactSection[] };

// ─── argument coercion ───────────────────────────────────────────────────────

/** A coded refusal raised before or after the hop; rendered as `CODE: message` + next step. */
class CodedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CodedError';
  }
}

const bad = (message: string) => new CodedError('BAD_REQUEST', message);

/** A trimmed non-empty string (a number is stringified), else undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * A string list that may arrive as an array, a JSON array string, or a comma list — the
 * connector relay stringifies non-string args. Absent or '' → undefined (no filter). An
 * explicit empty array passes through as []: a selection is never silently BROADENED, and
 * a value of the wrong type is refused rather than read as "everything".
 */
export function listArg(v: unknown, name = 'list'): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  let items: unknown[];
  if (Array.isArray(v)) {
    items = v;
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (s.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(s);
        items = Array.isArray(parsed) ? parsed : [s];
      } catch {
        items = s.replace(/[[\]"']/g, '').split(',');
      }
    } else {
      items = s.split(',');
    }
  } else {
    throw bad(`${name} must be a list of strings, got ${typeof v}`);
  }
  return items
    .map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : ''))
    .filter((x) => x.length > 0);
}

/** POST /data/bundles body — only what the caller asked for. */
export function exportBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const sections = listArg(args.sections, 'sections');
  if (sections) body.sections = sections;
  const datasets = listArg(args.datasets, 'datasets');
  if (datasets) body.datasets = datasets;
  for (const k of ['includeReplicas', 'includeKnowledge', 'includeClaudeMemory']) {
    if (boolArg(args[k])) body[k] = true;
  }
  if (typeof args.note === 'string' && args.note.length) body.note = args.note;
  return body;
}

/** POST /data/bundles/:id/plan|apply body (apply adds confirm:true itself). */
export function importBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const policy = str(args.policy);
  if (policy) body.policy = policy;
  const sections = listArg(args.sections, 'sections');
  if (sections) body.sections = sections;
  const datasets = listArg(args.datasets, 'datasets');
  if (datasets) body.datasets = datasets;
  if (boolArg(args.takeOwnership)) body.takeOwnership = true;
  if (boolArg(args.force)) body.force = true;
  return body;
}

/**
 * One URL path segment. encodeURIComponent stops `/`, `?` and `#`, but a bare `.` or `..`
 * survives it and the URL parser resolves it as a dot segment — `/data/datasets/../takeover`
 * would reach a different route. Refuse those outright.
 */
function seg(id: string, what: string): string {
  if (id === '.' || id === '..') throw bad(`invalid ${what} "${id}"`);
  return encodeURIComponent(id);
}

// ─── transport ───────────────────────────────────────────────────────────────

/** The loopback hop, returning the RAW `{success,data,error}` envelope so error codes survive. */
export interface BundleTransport {
  get(path: string, timeoutMs: number): Promise<unknown>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

/** Inventory counts every dataset's records (a full raw read each) and may ask the hub roster. */
const INVENTORY_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 15_000;

const loopback: BundleTransport = {
  get: (p, timeoutMs) => workerGetRaw(p, timeoutMs),
  // 120 s: create, plan/apply over a big node and a multi-chunk peer fetch all run synchronously.
  post: (p, body) => workerPostRaw(p, body),
  // There is no raw DELETE helper; the unwrap throws the route's message, which is all a
  // delete refusal (bad id / not found) needs.
  del: async (p) => ({ success: true, data: await workerDelete(p) }),
};

let transport: BundleTransport = loopback;

/** Tests only: swap the transport (null restores the loopback hop). */
export function _setBundleTransportForTests(t: BundleTransport | null): void {
  transport = t ?? loopback;
}

/** Unwrap a raw envelope, throwing its CODE and message on refusal. */
function unwrap<T>(env: unknown, what: string): T {
  if (!env || typeof env !== 'object') throw new CodedError('BAD_RESPONSE', `${what}: Core returned no JSON envelope`);
  const e = env as { success?: unknown; data?: unknown; error?: unknown };
  if (e.success === false || (e.success !== true && e.error)) {
    const x = e.error;
    if (x && typeof x === 'object') {
      const o = x as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };
      let msg = typeof o.message === 'string' && o.message ? o.message : JSON.stringify(x);
      if (typeof o.hint === 'string' && o.hint) msg += ` — ${o.hint}`;
      // details carry the numbers and the failed check (DISK_LOW sizes, BUNDLE_CORRUPT check).
      if (o.details && typeof o.details === 'object' && Object.keys(o.details).length) {
        msg += ` (${JSON.stringify(o.details).slice(0, 300)})`;
      }
      throw new CodedError(typeof o.code === 'string' && o.code ? o.code : 'ERROR', msg);
    }
    throw new CodedError('ERROR', typeof x === 'string' && x ? x : `${what} failed`);
  }
  return (e.data !== undefined ? e.data : env) as T;
}

// ─── rendering (pure) ────────────────────────────────────────────────────────
//
// Display bounds live in the RENDERER, not upstream: a bound that exists only in the caller
// disappears the moment someone renders from somewhere else. mcp-output-size.test.ts pushes
// worst-case data through each renderer and measures the bytes.

const ID_CHARS = 48;
const HOST_CHARS = 40;
const LINE_CHARS = 240;
const MESSAGE_CHARS = 1200;
/** Section rows per table (plan/apply, create, inspect), and their byte budget. */
const MAX_SECTION_ROWS = 40;
const SECTION_TABLE_BYTES = 9 * 1024;
const MAX_INVENTORY_ROWS = 60;
const INVENTORY_TABLE_BYTES = 11 * 1024;
const MAX_LIST_ROWS = 40;
const LIST_TABLE_BYTES = 9 * 1024;
/** Per-section detail blocks in a plan (samples, warnings, refusal fixes). */
const DETAIL_BYTES = 7 * 1024;
const MAX_NOTES = 6;
const SECTION_WARNINGS = 3;
const SECTION_ERRORS = 3;
const SAMPLE_IDS = 5;
const MAX_ORPHANS = 10;
const MAX_HINT_LINES = 6;

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

/** One line, whitespace collapsed, clamped with an ellipsis. */
function clamp(v: unknown, n: number): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** A markdown table row. Cells carry caller and bundle text, so a `|` inside one is escaped. */
function row(cells: readonly string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
}

function size(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function when(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : clamp(iso, 24);
}

const shortHash = (h: unknown) => (typeof h === 'string' && h ? `${h.slice(0, 16)}…` : '—');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '—');

function host(o: { hostname?: string; machineId?: string } | undefined | null): string {
  if (!o) return '—';
  const h = o.hostname ? clamp(o.hostname, HOST_CHARS) : '';
  const m = o.machineId ? clamp(o.machineId, HOST_CHARS) : '';
  return h && m && h !== m ? `${h} (${m})` : h || m || '—';
}

/**
 * Lines added in order while under BOTH a row cap and a byte budget. `omitted` is what the
 * caller must report — a bounded list that does not say it was bounded reads as complete.
 */
function bounded<T>(items: readonly T[], render: (x: T) => string, maxRows: number, maxBytes: number): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let bytes = 0;
  for (const x of items) {
    const line = render(x);
    const b = byteLen(line) + 1;
    if (lines.length >= maxRows || bytes + b > maxBytes) break;
    lines.push(line);
    bytes += b;
  }
  return { lines, omitted: items.length - lines.length };
}

/** Up to `max` clamped notes, then a "+N more" line. */
function notes(list: readonly unknown[] | undefined, max: number, indent: string, prefix = ''): string[] {
  const xs = Array.isArray(list) ? list : [];
  const out = xs.slice(0, max).map((w) => `${indent}${prefix}${clamp(w, LINE_CHARS)}`);
  if (xs.length > max) out.push(`${indent}… +${xs.length - max} more`);
  return out;
}

const BUCKET_LABEL: Record<PlanBucket, string> = {
  add: 'add', update: 'update', skipOlder: 'older', skipIdentical: 'identical', skipExists: 'exists',
  tooLarge: 'tooLarge', neutralized: 'neutralized', skipDiffers: 'differs', skipped: 'skipped', importedDisabled: 'disabled',
};
const BUCKETS = Object.keys(BUCKET_LABEL) as PlanBucket[];
/** Buckets whose sample ids are worth a line: what gets written, and what is held back. */
const SAMPLE_BUCKETS: PlanBucket[] = ['add', 'update', 'neutralized', 'importedDisabled', 'tooLarge', 'skipDiffers', 'skipped'];
const WRITE_BUCKETS: PlanBucket[] = ['add', 'update', 'neutralized', 'importedDisabled'];

function countsText(c: Partial<PlanCounts> | undefined, only: readonly PlanBucket[] = BUCKETS): string {
  if (!c) return '—';
  const parts = only.filter((b) => typeof c[b] === 'number' && (c[b] as number) > 0).map((b) => `${BUCKET_LABEL[b]} ${c[b]}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** Section-level refusal → the next step, in call form where there is one. */
const REFUSAL_FIX: Record<string, string> = {
  REPLICA_READ_ONLY: 'run this import on the origin named above (pass it as node), or — only if that origin is gone — repeat with takeOwnership:true to take it over first',
  ORIGIN_ONLINE: 'the origin is online — run this import there (pass it as node); a takeover is only for an origin that is gone',
  OWNER_ONLINE: 'the owner is online — run this import there (pass it as node), or wait for replication',
  ROSTER_UNAVAILABLE: 'the fleet roster could not be read — retry once the hub is reachable; add force:true ONLY if you know the owner is gone',
  FORBIDDEN: 'system and read-only datasets are never imported — leave it out with datasets:[…]',
  BAD_DATASET_ID: 'the id is invalid or reserved on this node — leave it out with datasets:[…]',
  BAD_SECTION_DATA: 'the section is malformed in the bundle — re-export it on the source node',
  NOT_SUPPORTED: 'derived stores rebuild themselves — nothing to import',
  NO_BACKEND: 'this node has no backend for that dataset — enable it, then plan again',
};

/** Whole-call error → the next step. */
const ERROR_FIX: Record<string, string> = {
  BAD_REQUEST: 'check the arguments against the tool schema',
  BUNDLE_NOT_FOUND: 'bundles are per node — list them with data_export({action:"list"}) on the node that holds it',
  BUNDLE_ID_INVALID: 'a bundle id is lmb-<yyyymmdd>-<hhmmss>-<6 hex>, or received:<name> for a file in the transfer inbox',
  BAD_BUNDLE_ID: 'a bundle id is lmb-<yyyymmdd>-<hhmmss>-<6 hex>, or received:<name> for a file in the transfer inbox',
  BAD_DATASET_ID: 'check the id: data_export({action:"inventory"}) lists this node\'s datasets',
  UNSUPPORTED_FIELD: 'this build of Core does not take that field — check the tool schema',
  BUNDLE_CORRUPT: 'the file failed verification — re-fetch it, or re-export on the source node',
  BUNDLE_FORMAT: 'not an lm-assist bundle this build can read — re-export it on the source node',
  BUNDLE_TOO_LARGE: 'export less: narrow with sections:[…] / datasets:[…]',
  DISK_LOW: 'free disk space on this node, or delete old bundles with data_export({action:"delete", bundle})',
  EXPORT_INCOMPLETE: 'leave that dataset out with datasets:[…] to export the rest',
  EXPORT_FAILED: 'leave that dataset out with datasets:[…] to export the rest',
  FETCH_FAILED: 'check the source node is online (list_nodes) and holds the id: data_export({action:"list", node:"<fromNode>"})',
  RECEIVED_NOT_FOUND: 'the file must be in this node\'s transfer inbox (transfer_send_file puts it there)',
  RECEIVED_NAME_INVALID: 'a received name is [A-Za-z0-9._-]{1,128}, no path',
  ORIGIN_ONLINE: 'the origin is online — write there instead; a takeover is only for an origin that is gone',
  ROSTER_UNAVAILABLE: 'the fleet roster could not be read — retry once the hub is reachable; force:true ONLY if you know the origin is gone',
  NOT_A_REPLICA: 'this node already owns that dataset — nothing to take over',
  NOT_FOUND: 'check the id: data_export({action:"inventory"}) lists this node\'s datasets',
  CONFIRM_REQUIRED: 'run action:"plan" first, then repeat action:"apply" with confirm:true',
};

/** `CODE: message` plus the next step — the text of every failed call. */
export function renderToolError(code: string, message: string, fix: string | undefined = ERROR_FIX[code]): string {
  return `${code}: ${clamp(message, MESSAGE_CHARS)}${fix ? `\n→ ${fix}` : ''}`;
}

// ── data_export ─────────────────────────────────────────────────────────────

export function renderInventory(inv: InventoryView): string {
  const node = inv.node ?? ({} as InventoryView['node']);
  const out: string[] = [
    `Data inventory — ${host({ hostname: node.hostname, machineId: node.nodeId })} · ${node.mode ?? '—'}` +
      ` · cluster ${node.cluster ? clamp(node.cluster, HOST_CHARS) : 'none'}`,
  ];
  const r = inv.roster;
  if (r?.queried) {
    out.push(r.available
      ? `Fleet roster: ${num(r.onlinePeers)} peer(s) online.`
      : `Fleet roster UNAVAILABLE (${clamp(r.reason, LINE_CHARS)}) — replica origins show "unknown".`);
  }

  const ds = Array.isArray(inv.datasets) ? inv.datasets : [];
  out.push('', '| Dataset | Owner | Records | Tombstones | Scope/sync | Size | Export |', '|---|---|---|---|---|---|---|');
  const table = bounded(ds, (d) => {
    const owner = d.owned
      ? 'owned'
      : `replica of ${host(d.origin)} — ${d.originOnline === true ? 'online' : d.originOnline === false ? 'OFFLINE' : 'unknown'}`;
    const exp = d.export === 'default' ? 'default' : `${d.export}${d.reason ? `: ${clamp(d.reason, 60)}` : ''}`;
    return row([clamp(d.id, ID_CHARS), owner, num(d.records), num(d.tombstones),
      `${clamp(d.scope, 12)}/${clamp(d.syncMode, 12)}`, size(d.approxBytes), exp]);
  }, MAX_INVENTORY_ROWS, INVENTORY_TABLE_BYTES);
  out.push(...table.lines);
  if (table.omitted) out.push(`… ${table.omitted} more dataset(s) not shown.`);

  // The actionable rows: a replica whose origin is gone can be taken over.
  const orphanedReplicas = ds.filter((d) => !d.owned && d.originOnline !== true);
  if (orphanedReplicas.length) {
    out.push('', 'Replicas whose origin is not confirmed online (take over ONLY if that origin is gone for good):');
    for (const d of orphanedReplicas.slice(0, MAX_HINT_LINES)) {
      out.push(`  data_import({action:"takeover", dataset:"${clamp(d.id, ID_CHARS)}"${d.originOnline === null ? ', force:true' : ''}})` +
        (d.originOnline === null ? '   (roster unreadable — force only if you KNOW it is gone)' : ''));
    }
    if (orphanedReplicas.length > MAX_HINT_LINES) out.push(`  … +${orphanedReplicas.length - MAX_HINT_LINES} more`);
  }
  const superseding = ds.filter((d) => d.supersedes);
  if (superseding.length) {
    out.push('', 'Taken over here (the old origin demotes itself when it returns):');
    for (const d of superseding.slice(0, MAX_HINT_LINES)) {
      out.push(`  ${clamp(d.id, ID_CHARS)} — from ${host(d.supersedes)} at ${when(d.supersedes?.at)}`);
    }
    if (superseding.length > MAX_HINT_LINES) out.push(`  … +${superseding.length - MAX_HINT_LINES} more`);
  }
  const unreadable = ds.filter((d) => d.error);
  if (unreadable.length) {
    out.push('', 'Could not be read (an export including them fails):');
    out.push(...notes(unreadable.map((d) => `${clamp(d.id, ID_CHARS)}: ${d.error}`), MAX_HINT_LINES, '  '));
  }

  const orphans = Array.isArray(inv.orphans) ? inv.orphans : [];
  if (orphans.length) {
    out.push('', 'Orphan stores (on disk with no descriptor; never exported):');
    for (const o of orphans.slice(0, MAX_ORPHANS)) {
      out.push(`  ${clamp(o.id, ID_CHARS)} (${o.backend}, ${size(o.bytes)}${o.lockOnly ? ', lock file only' : ''})`);
    }
    if (orphans.length > MAX_ORPHANS) out.push(`  … ${orphans.length - MAX_ORPHANS} more orphan(s)`);
  }

  const cfg = inv.sections?.config ?? [];
  const files = inv.sections?.files ?? [];
  out.push('', `Config sections (in every export): ${cfg.length ? clamp(cfg.map((c) => c.id).join(', '), 400) : '—'}`);
  if (files.length) {
    out.push(`Opt-in file sections: ${clamp(files.map((f) => `${f.id} (${f.option})`).join(', '), 400)}`);
  }

  const s = inv.sync;
  out.push('', s
    ? `Sync: last reconcile ${when(s.lastRun)} · ${num(s.peersChecked)} peer(s) checked · ${num(s.datasetsReplicated)} dataset(s) replicated` +
      (s.errors?.length ? ` · ${s.errors.length} error(s):` : ' · no errors')
    : 'Sync: not running on this node.');
  if (s?.errors?.length) out.push(...notes(s.errors, 5, '  '));

  if (inv.neverExported?.length) {
    out.push('', 'Never exported:');
    out.push(...notes(inv.neverExported, MAX_NOTES, '  ', '- '));
  }
  const b = inv.bundles;
  out.push('', `Stored bundles: ${num(b?.count)}${b?.newest ? ` (newest ${clamp(b.newest, ID_CHARS)})` : ''}. ` +
    'Create one: data_export({action:"create"}); list: data_export({action:"list"}).');
  return out.join('\n');
}

function sectionRow(s: CompactSection): string {
  const own = s.kind !== 'dataset' ? '—' : s.owned === false ? `replica of ${host(s.origin)}` : 'owned';
  const scope = s.kind === 'dataset' ? `${clamp(s.scope ?? '—', 12)}/${clamp(s.syncMode ?? '—', 12)}` : '—';
  const flags = [
    s.warnings?.length ? `${s.warnings.length} warning(s)` : '',
    s.redactedKeys?.length ? `${s.redactedKeys.length} secret key(s) dropped` : '',
  ].filter(Boolean).join(', ') || '—';
  return row([clamp(s.id, ID_CHARS), s.kind, num(s.count), s.kind === 'dataset' ? num(s.tombstones) : '—',
    size(s.bytes), own, scope, flags]);
}

function sectionTable(sections: readonly CompactSection[] | undefined, out: string[]): void {
  const list = Array.isArray(sections) ? sections : [];
  if (!list.length) {
    out.push('', 'Sections: none.');
    return;
  }
  out.push('', '| Section | Kind | Count | Tombstones | Size | Owner | Scope/sync | Notes |', '|---|---|---|---|---|---|---|---|');
  const t = bounded(list, sectionRow, MAX_SECTION_ROWS, SECTION_TABLE_BYTES);
  out.push(...t.lines);
  if (t.omitted) out.push(`… ${t.omitted} more section(s) not shown.`);
  const warned = list.flatMap((s) => (s.warnings ?? []).map((w: string) => `${clamp(s.id, ID_CHARS)}: ${w}`));
  if (warned.length) out.push('', 'Section warnings:', ...notes(warned, MAX_NOTES, '  '));
}

export function renderCreate(r: ExportView): string {
  const out = [
    `Bundle created: ${r.bundleId}`,
    `Path (on this node): ${clamp(r.path, 200)}`,
    `Size: ${size(r.sizeBytes)} gzip · ${num(r.totals?.entries)} entries · ${size(r.totals?.uncompressedBytes)} uncompressed · ` +
      `sha256 ${shortHash(r.sha256)}`,
  ];
  if (r.note) out.push(`Note: ${clamp(r.note, LINE_CHARS)}`);
  sectionTable(r.sections, out);
  if (r.excluded?.length) {
    out.push('', `Not exported (${r.excluded.length}):`, ...notes(r.excluded.map((x) => `${clamp(x.id, ID_CHARS)} — ${x.reason}`), MAX_NOTES, '  '));
  }
  if (r.warnings?.length) out.push('', 'Warnings:', ...notes(r.warnings, MAX_NOTES, '  '));
  if (r.pruned?.length) {
    out.push('', `Retention pruned ${r.pruned.length} older bundle(s): ${clamp(r.pruned.slice(0, 5).join(', '), 200)}` +
      (r.pruned.length > 5 ? ` … +${r.pruned.length - 5} more` : ''));
  }
  out.push('', 'The bundle holds private data unredacted (secrets excluded) — keep it on trusted nodes.');
  if (r.next) out.push(`Next: ${clamp(r.next, 400)}`);
  return out.join('\n');
}

function sectionMix(sections: readonly { kind?: string }[] | undefined): string {
  const list = Array.isArray(sections) ? sections : [];
  const n = (k: string) => list.filter((s) => s.kind === k).length;
  return `${n('dataset')} dataset · ${n('config')} config · ${n('files')} files`;
}

export function renderList(bundles: readonly StoredBundleView[]): string {
  const list = Array.isArray(bundles) ? bundles : [];
  if (!list.length) return 'No stored bundles on this node. Create one: data_export({action:"create"}).';
  const out = [`Stored bundles on this node — ${list.length}, newest first`, '',
    '| Bundle | Created | Size | Source | Sections | Note |', '|---|---|---|---|---|---|'];
  const t = bounded(list, (b) => {
    if (b.error) {
      return row([clamp(b.bundleId, ID_CHARS), '—', size(b.sizeBytes), '—', '—', `UNREADABLE ${clamp(b.error.code, 32)}: ${clamp(b.error.message, 80)}`]);
    }
    const src = b.source ? `${clamp(b.source.hostname || b.source.nodeId, HOST_CHARS)} (${b.source.mode})` : '—';
    const note = [
      b.note ? `"${clamp(b.note, 60)}"` : '',
      b.imported ? `imported via ${b.imported.via}${b.imported.fromNode ? ` from ${clamp(b.imported.fromNode, HOST_CHARS)}` : ''}` : '',
    ].filter(Boolean).join(' · ') || '—';
    return row([clamp(b.bundleId, ID_CHARS), when(b.createdAt ?? b.mtime), size(b.sizeBytes), src, sectionMix(b.sections), note]);
  }, MAX_LIST_ROWS, LIST_TABLE_BYTES);
  out.push(...t.lines);
  if (t.omitted) out.push(`… ${t.omitted} more bundle(s) not shown (oldest).`);
  out.push('', 'Inspect: data_export({action:"inspect", bundle}) · import: data_import({action:"plan", bundle}).');
  return out.join('\n');
}

export function renderInspect(r: InspectView): string {
  const m = r.manifest ?? ({} as InspectView['manifest']);
  const src = m.source;
  const out = [
    `Bundle ${clamp(r.bundleId ?? m.bundleId, ID_CHARS)} — ${size(r.sizeBytes)} · created ${when(m.createdAt)} · format ${clamp(m.format, 24)} v${num(m.formatVersion)}`,
    src
      ? `Source: ${host({ hostname: src.hostname, machineId: src.nodeId })} · ${clamp(src.platform, 16)} · lm-assist ${clamp(src.lmAssistVersion, 24)} · ${src.mode}` +
        (src.cluster ? ` · cluster ${clamp(src.cluster, HOST_CHARS)}` : '')
      : 'Source: —',
  ];
  if (r.imported) {
    out.push(`Imported here via ${r.imported.via} at ${when(r.imported.at)}` +
      (r.imported.fromNode ? ` from ${clamp(r.imported.fromNode, HOST_CHARS)}` : '') +
      (r.imported.name ? ` (file ${clamp(r.imported.name, 60)})` : '') +
      ` · original id ${clamp(r.imported.importedFrom, ID_CHARS)}`);
  }
  if (m.note) out.push(`Note: ${clamp(m.note, LINE_CHARS)}`);
  if (m.options && Object.keys(m.options).length) out.push(`Options: ${clamp(JSON.stringify(m.options), LINE_CHARS)}`);
  out.push(`Totals: ${num(m.totals?.entries)} entries · ${size(m.totals?.uncompressedBytes)} uncompressed`);
  sectionTable(m.sections, out);
  out.push('', 'This reads the manifest only; data_import({action:"plan", bundle}) verifies integrity and shows what an import would do.');
  return out.join('\n');
}

export function renderDelete(r: { bundleId?: string; deleted?: boolean }): string {
  return r?.deleted === false
    ? `${clamp(r.bundleId, ID_CHARS)} was not found — nothing deleted.`
    : `Deleted ${clamp(r?.bundleId, ID_CHARS)}.`;
}

// ── data_import ─────────────────────────────────────────────────────────────

export type ImportRenderMode = 'plan' | 'apply' | 'unconfirmed';

const UNCONFIRMED_HEAD = 'APPLY NOT CONFIRMED — NOTHING WAS WRITTEN. Below is the plan; repeat this call with confirm:true to apply it.';
const UNCONFIRMED_TAIL = 'NOTHING WAS WRITTEN — review the plan above, then repeat with confirm:true to apply it.';

function sectionAction(s: DatasetSectionPlan): string {
  if (s.refused) return `REFUSED ${clamp(s.refused.code, 32)}`;
  return s.kind === 'dataset' ? s.action ?? 'import' : 'import';
}

/** A section's detail block, or null when the table row already says everything. */
function sectionDetail(s: DatasetSectionPlan, mode: ImportRenderMode): string | null {
  const lines: string[] = [];
  if (s.refused) {
    lines.push(`  REFUSED ${clamp(s.refused.code, 32)}: ${clamp(s.refused.reason, 400)}`);
    const fix = REFUSAL_FIX[s.refused.code];
    if (fix) lines.push(`  → ${fix}`);
  }
  if (mode === 'apply' && s.errors?.length) lines.push(...notes(s.errors, SECTION_ERRORS, '  ', 'error: '));
  const samples = SAMPLE_BUCKETS
    .filter((b) => s.samples?.[b]?.length)
    .map((b) => {
      const ids = s.samples[b]!;
      const shown = ids.slice(0, SAMPLE_IDS).map((x) => clamp(x, ID_CHARS)).join(', ');
      const total = s.counts?.[b] ?? ids.length;
      return `${BUCKET_LABEL[b]}: ${shown}${total > SAMPLE_IDS ? ` … (${total})` : ''}`;
    });
  if (samples.length) lines.push(`  e.g. ${samples.join(' · ')}`);
  lines.push(...notes(s.warnings, SECTION_WARNINGS, '  ', 'warning: '));
  if (!lines.length) return null;
  const action = !s.refused && s.kind === 'dataset' && s.action && s.action !== 'import' ? `, ${s.action}` : '';
  return [`• ${clamp(s.id, ID_CHARS)} (${s.kind}${action})`, ...lines].join('\n');
}

/** Detail priority: refusals, then write errors, then warnings, then samples only. */
function detailRank(s: DatasetSectionPlan): number {
  if (s.refused) return 0;
  if (s.errors?.length) return 1;
  if (s.warnings?.length) return 2;
  return 3;
}

export function renderImport(r: ImportView, opts: { mode: ImportRenderMode }): string {
  const mode = opts.mode;
  const out: string[] = [];
  const what = `${clamp(r.bundleId, ID_CHARS)} · policy ${clamp(r.policy, 16)}`;
  out.push(mode === 'apply' ? `APPLIED — ${clamp(r.bundleId, ID_CHARS)} imported into this node · policy ${clamp(r.policy, 16)}`
    : mode === 'unconfirmed' ? UNCONFIRMED_HEAD
      : `DRY RUN — nothing was written. Import plan for ${what}`);
  if (mode === 'unconfirmed') out.push(`Import plan for ${what}`);
  const src = r.source;
  if (src) {
    out.push(`Source: ${host({ hostname: src.hostname, machineId: src.nodeId })} · ${clamp(src.platform, 16)} · lm-assist ` +
      `${clamp(src.lmAssistVersion, 24)} · ${src.mode}${src.cluster ? ` · cluster ${clamp(src.cluster, HOST_CHARS)}` : ''} · ` +
      `created ${when(r.createdAt)}${r.note ? ` · note "${clamp(r.note, 80)}"` : ''}`);
  }
  out.push(`${mode === 'apply' ? 'Planned' : 'Would'}: ${countsText(r.totals)}`);
  if (mode === 'apply') out.push(`Written: ${countsText(r.applied, WRITE_BUCKETS)}`);
  if (r.refused) out.push(`Refused sections: ${r.refused} (${mode === 'apply' ? 'not written' : 'apply skips them'} — fixes below)`);

  const sections = Array.isArray(r.sections) ? r.sections : [];
  if (sections.length) {
    out.push('', `| Section | Kind | Action | ${mode === 'apply' ? 'Planned | Written' : 'Plan'} |`,
      mode === 'apply' ? '|---|---|---|---|---|' : '|---|---|---|---|');
    const t = bounded(sections, (s) => row([
      clamp(s.id, ID_CHARS), s.kind, sectionAction(s), countsText(s.counts),
      ...(mode === 'apply' ? [countsText(s.applied, WRITE_BUCKETS)] : []),
    ]), MAX_SECTION_ROWS, SECTION_TABLE_BYTES);
    out.push(...t.lines);
    if (t.omitted) {
      out.push(`… ${t.omitted} more section(s) not shown (their counts are in the totals) — narrow with datasets:[…] or sections:[…].`);
    }

    const blocks = sections
      .map((s, i) => ({ s, i, rank: detailRank(s) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map(({ s }) => sectionDetail(s, mode))
      .filter((x): x is string => x !== null);
    if (blocks.length) {
      const d = bounded(blocks, (x) => x, blocks.length, DETAIL_BYTES);
      out.push('', 'Details:', ...d.lines);
      if (d.omitted) out.push(`… details for ${d.omitted} more section(s) omitted — narrow with datasets:[…] or sections:[…].`);
    }
  } else {
    out.push('', 'No sections selected — check sections:[…] / datasets:[…] against data_export({action:"inspect", bundle}).');
  }

  if (r.warnings?.length) out.push('', 'Warnings:', ...notes(r.warnings, MAX_NOTES, '  '));

  out.push('');
  if (mode === 'apply') {
    out.push('Import never deletes. Synced datasets reach peers on change-notify or the next reconcile.');
  } else if (mode === 'plan') {
    out.push(`To apply: data_import({action:"apply", bundle:"${clamp(r.bundleId, ID_CHARS)}"` +
      `${r.policy && r.policy !== 'merge' ? `, policy:"${clamp(r.policy, 16)}"` : ''}, confirm:true}) ` +
      'with the same sections / datasets / takeOwnership.');
  } else {
    out.push(UNCONFIRMED_TAIL);
  }
  return out.join('\n');
}

export function renderReceived(name: string, r: Pick<StoredImportResult, 'bundleId' | 'sizeBytes'>): string {
  return `Imported received:${clamp(name, 128)} into the bundle store as ${clamp(r.bundleId, ID_CHARS)} (verified, ${size(r.sizeBytes)}). ` +
    `Use bundle:"${clamp(r.bundleId, ID_CHARS)}" from now on — repeating received:<name> stores another copy.`;
}

export function renderFetch(r: FetchView): string {
  const m = r.manifest;
  const src = m?.source;
  const out = [
    `Fetched ${clamp(r.sourceBundleId, ID_CHARS)} from ${clamp(r.fromNode, HOST_CHARS)} — stored here as ${clamp(r.bundleId, ID_CHARS)} ` +
      `(${num(r.chunks)} chunk(s), ${size(r.sizeBytes)}, sha256 ${shortHash(r.sha256)}, verified).`,
  ];
  if (src) {
    out.push(`Source: ${host({ hostname: src.hostname, machineId: src.nodeId })} · ${src.mode} · created ${when(m.createdAt)} · ` +
      `${sectionMix(m.sections)}${m.note ? ` · note "${clamp(m.note, 80)}"` : ''}`);
  }
  out.push(`Next: data_import({action:"plan", bundle:"${clamp(r.bundleId, ID_CHARS)}"})`);
  return out.join('\n');
}

export function renderTakeover(r: TakeoverView): string {
  const out = [
    `Took over "${clamp(r.dataset, ID_CHARS)}" — this node now owns it (ownerNode ${clamp(r.ownerNode, HOST_CHARS)}, visibility ${clamp(r.visibility, 24)}).`,
    `Superseded origin: ${host(r.superseded)}. Records: ${num(r.records)} (tombstones ${num(r.tombstones)}).`,
  ];
  if (r.forced) out.push('FORCED — the fleet roster was unreadable, so the origin\'s state was not checked.');
  if (r.note) out.push(clamp(r.note, 400));
  return out.join('\n');
}

// ─── handlers ────────────────────────────────────────────────────────────────

function isTimeout(e: unknown): boolean {
  const x = e as { name?: string; message?: string } | null;
  return !!x && (x.name === 'TimeoutError' || x.name === 'AbortError' || /timed? ?out|aborted/i.test(x.message ?? ''));
}

/** Render a failure. A write that TIMED OUT may still land server-side — never "nothing happened". */
function fail(e: unknown, write: boolean): McpToolResult {
  if (e instanceof CodedError) return err(renderToolError(e.code, e.message));
  const msg = e instanceof Error ? e.message : String(e);
  if (isTimeout(e)) {
    return err(renderToolError('TIMEOUT', msg, write
      ? 'Core did not answer in time, but the operation may still complete — check data_export({action:"list"}) or plan again before retrying'
      : 'Core did not answer in time — retry'));
  }
  return err(msg);
}

const bundleArg = (args: Record<string, unknown>) => str(args.bundle) ?? str(args.bundleId);

function requireBundle(args: Record<string, unknown>, what: string): string {
  const b = bundleArg(args);
  if (!b) throw bad(`bundle is required for ${what} (lmb-<yyyymmdd>-<hhmmss>-<6 hex>)`);
  return b;
}

function asBundleList(d: unknown): StoredBundleView[] {
  if (Array.isArray(d)) return d as StoredBundleView[];
  const o = d as { bundles?: unknown } | null;
  return Array.isArray(o?.bundles) ? (o!.bundles as StoredBundleView[]) : [];
}

/** GET /data/bundles/:id answers the inspect shape; a bare manifest is accepted too. */
function asInspect(d: unknown, id: string): InspectView {
  const o = (d ?? {}) as Partial<InspectView> & { t?: string };
  if (o.manifest) return o as InspectView;
  return { bundleId: id, sizeBytes: undefined as unknown as number, manifest: o as unknown as InspectView['manifest'] };
}

async function handleDataExport(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = str(args.action) ?? 'inventory';
  if (!(DATA_EXPORT_ACTIONS as readonly string[]).includes(action)) {
    return err(`unknown action "${clamp(action, 32)}" — expected one of ${DATA_EXPORT_ACTIONS.join(', ')}`);
  }
  try {
    switch (action) {
      case 'create':
        return ok(renderCreate(unwrap<ExportView>(await transport.post('/data/bundles', exportBody(args)), 'create')));
      case 'list':
        return ok(renderList(asBundleList(unwrap(await transport.get('/data/bundles', READ_TIMEOUT_MS), 'list'))));
      case 'inspect': {
        const id = requireBundle(args, 'inspect');
        return ok(renderInspect(asInspect(unwrap(await transport.get(`/data/bundles/${seg(id, 'bundle')}`, READ_TIMEOUT_MS), 'inspect'), id)));
      }
      case 'delete': {
        const id = requireBundle(args, 'delete');
        return ok(renderDelete(unwrap(await transport.del(`/data/bundles/${seg(id, 'bundle')}`), 'delete')));
      }
      default:
        return ok(renderInventory(unwrap<InventoryView>(await transport.get('/data/bundles/inventory', INVENTORY_TIMEOUT_MS), 'inventory')));
    }
  } catch (e) {
    return fail(e, action === 'create' || action === 'delete');
  }
}

async function handleDataImport(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = str(args.action);
  if (!action || !(DATA_IMPORT_ACTIONS as readonly string[]).includes(action)) {
    return err(`${action ? `unknown action "${clamp(action, 32)}"` : 'action is required'} — expected one of ${DATA_IMPORT_ACTIONS.join(', ')}`);
  }
  // plan counts as a write too: a received:<name> bundle is copied into the store first.
  const write = action !== 'plan' || (bundleArg(args) ?? '').startsWith('received:');
  try {
    if (action === 'takeover') {
      const dataset = str(args.dataset);
      if (!dataset) throw bad('dataset is required for takeover');
      const body = boolArg(args.force) ? { force: true } : {};
      return ok(renderTakeover(unwrap<TakeoverView>(await transport.post(`/data/datasets/${seg(dataset, 'dataset')}/takeover`, body), 'takeover')));
    }
    if (action === 'fetch') {
      const fromNode = str(args.fromNode);
      if (!fromNode) throw bad('fromNode is required for fetch (the node holding the bundle — list_nodes)');
      const bundleId = requireBundle(args, 'fetch');
      return ok(renderFetch(unwrap<FetchView>(await transport.post('/data/bundles/fetch', { fromNode, bundleId }), 'fetch')));
    }

    let bundle = bundleArg(args);
    if (!bundle) throw bad(`bundle is required for ${action} (lmb-… or received:<name>)`);
    const body = importBody(args);
    const confirmed = action === 'apply' && boolArg(args.confirm);
    const out: string[] = [];
    if (bundle.startsWith('received:')) {
      // Copied into the store ONCE here, then planned by its new id — resolving the ref on the
      // plan route instead would store a fresh copy on every plan and apply.
      const name = bundle.slice('received:'.length);
      const got = unwrap<StoredImportResult>(await transport.post(`/data/bundles/received/${seg(name, 'received name')}`, {}), 'received');
      out.push(renderReceived(name, got), '');
      bundle = got.bundleId;
    }
    if (confirmed) {
      const res = unwrap<ImportView>(await transport.post(`/data/bundles/${seg(bundle, 'bundle')}/apply`, { ...body, confirm: true }), 'apply');
      out.push(renderImport(res, { mode: 'apply' }));
    } else {
      // apply WITHOUT confirm:true never reaches the apply route: it plans, and says so.
      const res = unwrap<ImportView>(await transport.post(`/data/bundles/${seg(bundle, 'bundle')}/plan`, body), 'plan');
      out.push(renderImport(res, { mode: action === 'apply' ? 'unconfirmed' : 'plan' }));
    }
    return ok(out.join('\n'));
  } catch (e) {
    return fail(e, write);
  }
}

export const DATA_BUNDLE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  data_export: handleDataExport,
  data_import: handleDataImport,
};
