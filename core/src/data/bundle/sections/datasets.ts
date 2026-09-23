/**
 * Section 1 — `datasets` (spec §1): the data-service datasets a bundle carries.
 *
 * EXPORT enumerates the REGISTRY (never the disk) and excludes:
 *   - system datasets (knowledge, vectors, log-* file datasets, the sql indexes);
 *   - backends that are derived or not record stores (file / knowledge / vectors);
 *   - the runtime deny-list: node-clusters (identity heartbeats that self-heal) and
 *     mcp-bootstrap (runtime state);
 *   - replicas, unless includeReplicas (or the caller named the dataset explicitly).
 * Records are read RAW through DataService.exportRaw — unredacted, tombstones included, paged
 * past the 50k cap — and `missions` drops its reserved runtime ids (__controller__,
 * __engagement__). LMDB/SQLite files with no descriptor are ORPHANS: reported, never exported.
 *
 * IMPORT applies the spec's ownership table per dataset:
 *   local owns it           → import per policy (warn `foreign-owner` when the bundle's owner differs)
 *   local holds a replica   → REPLICA_READ_ONLY, unless takeOwnership: the guarded takeover
 *                             runs first (ORIGIN_ONLINE / ROSTER_UNAVAILABLE refuse it)
 *   absent, not synced      → create from the bundle descriptor, then import
 *   absent, synced          → create when the bundle's owner is THIS node or is not online;
 *                             OWNER_ONLINE when it is (a second owner would split the brain)
 *   system / denied id      → skipped with a warning
 * Missions whose status is active|waiting|blocked are NEUTRALIZED on the way in (paused, no
 * binding, no in-flight spawn) so the supervisor does not spawn sessions for them.
 *
 * A plan is computed from the pure per-record decision (planImportRecord) against a raw read
 * of the local dataset, so it can describe a dataset that does not exist yet, and an apply
 * goes through DataService.importRaw (per-key locks, one batched change-notify).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DataResult, CallCtx } from '../../data-service';
import { planImportRecord, recordTooLarge, sameRecordContent } from '../../data-service';
import { DATASET_ID_RE, RESERVED_DATASET_IDS, type PromoteReplicaPatch } from '../../dataset-registry';
import type {
  BackendKind, DataRecord, DatasetDescriptor, ImportOutcome, ImportPolicy, NodeOrigin,
} from '../../types';
import type { BundleEntry, ReadSection, SectionSummaryInput } from '../format';
import type { OwnerProbe, RosterSnapshot } from '../roster';
import { diffMission } from '../../../mission/mission-history';
import { bump, emptyCounts, newSectionPlan, SAMPLE_CAP, type PlanBucket, type SectionPlan } from './types';

// ─── constants ──────────────────────────────────────────────────────────────

/** Runtime datasets never exported (and skipped on import): node identity heartbeats that
 *  self-heal every reconcile, and bootstrap runtime state. */
export const DATASET_EXPORT_DENY: ReadonlySet<string> = new Set(['node-clusters', 'mcp-bootstrap']);

/** Backends a bundle cannot round-trip (derived stores / file adapters). */
export const DATASET_UNSUPPORTED_BACKENDS: ReadonlySet<BackendKind> = new Set<BackendKind>(['knowledge', 'vectors', 'file']);

export const MISSIONS_DATASET = 'missions';
/** Reserved runtime records in `missions` — controller session + engagement bookkeeping. */
export const MISSIONS_RESERVED_IDS: ReadonlySet<string> = new Set(['__controller__', '__engagement__']);
/** Mission statuses the supervisor acts on — neutralized to `paused` on import. */
export const MISSION_LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'waiting', 'blocked']);
/** Inline history cap on a mission record (mirrors appendHistory's default inlineCap). */
const MISSION_HISTORY_INLINE_CAP = 50;

const LOCAL: CallCtx = { principal: { type: 'local' } };

// ─── ports ──────────────────────────────────────────────────────────────────

/** The DataService surface this section uses (DataService satisfies it). */
export interface RawDataPort {
  exportRaw(ctx: CallCtx, datasetId: string): Promise<DataResult<DataRecord[]>>;
  importRaw(ctx: CallCtx, datasetId: string, records: DataRecord[], opts: { policy: ImportPolicy; dryRun: boolean }): Promise<DataResult<ImportOutcome>>;
  createDatasetFromBundle(ctx: CallCtx, descriptor: DatasetDescriptor, opts?: { replicaOf?: NodeOrigin | null; supersedes?: import('../../types').SupersedesMarker }): Promise<DataResult<DatasetDescriptor>>;
  /** Whether the data service is on (off ⇒ imported datasets are stored but not served). */
  isEnabled?(): boolean;
}

/** The DatasetRegistry surface this section uses. */
export interface RegistryPort {
  list(): DatasetDescriptor[];
  get(id: string): DatasetDescriptor | undefined;
  promoteReplica(id: string, patch?: PromoteReplicaPatch): DatasetDescriptor;
}

// ─── export ─────────────────────────────────────────────────────────────────

export interface DatasetSelection {
  includeReplicas?: boolean;
  /** Restrict to these ids. An id named here is an explicit opt-in for a replica. */
  datasets?: string[];
}

/** Why a descriptor is never exported (null = exportable in principle). */
export function neverExportReason(d: DatasetDescriptor): string | null {
  if (d.system) return 'system dataset (derived or rebuilt; never exported)';
  if (DATASET_UNSUPPORTED_BACKENDS.has(d.backend)) return `backend "${d.backend}" is derived or file-backed (never exported)`;
  if (DATASET_EXPORT_DENY.has(d.id)) return 'runtime state (self-heals; never exported)';
  return null;
}

/** Whether this export includes `d`, and why not when it does not. */
export function classifyForExport(d: DatasetDescriptor, sel: DatasetSelection = {}): { included: true } | { included: false; reason: string } {
  const never = neverExportReason(d);
  if (never) return { included: false, reason: never };
  const named = Array.isArray(sel.datasets) && sel.datasets.length > 0;
  if (named && !sel.datasets!.includes(d.id)) return { included: false, reason: 'not selected' };
  if (d.origin && !sel.includeReplicas && !named) {
    return { included: false, reason: `replica of ${d.origin.hostname || d.origin.machineId} (opt in with includeReplicas)` };
  }
  return { included: true };
}

export interface ExcludedDataset { id: string; reason: string }

export interface CollectedDatasets {
  entries: BundleEntry[];
  sections: SectionSummaryInput[];
  /** Registry descriptors left out, with the reason (compact — for the create result). */
  excluded: ExcludedDataset[];
  /** Ids named in `datasets` that the registry does not hold. */
  unknown: string[];
}

/** Collect the dataset sections of an export. Fails (never silently shortens) when a dataset
 *  cannot be read completely — the caller surfaces the code; the operator can deselect it. */
export async function collectDatasets(
  deps: { data: RawDataPort; registry: RegistryPort },
  sel: DatasetSelection = {},
): Promise<DataResult<CollectedDatasets>> {
  const entries: BundleEntry[] = [];
  const sections: SectionSummaryInput[] = [];
  const excluded: ExcludedDataset[] = [];
  const all = deps.registry.list().sort((a, b) => a.id.localeCompare(b.id));
  for (const d of all) {
    const c = classifyForExport(d, sel);
    if (!c.included) {
      if (c.reason !== 'not selected') excluded.push({ id: d.id, reason: c.reason });
      continue;
    }
    const r = await deps.data.exportRaw(LOCAL, d.id);
    if (!r.ok) return { ok: false, code: r.code, reason: `dataset "${d.id}": ${r.reason}` };
    const warnings: string[] = [];
    let records = r.value;
    if (d.id === MISSIONS_DATASET) {
      const before = records.length;
      records = records.filter((x) => !MISSIONS_RESERVED_IDS.has(x.id));
      if (records.length !== before) warnings.push(`reserved: ${before - records.length} runtime record(s) (__controller__/__engagement__) not exported`);
    }
    // Stable order: a re-export of unchanged data produces the same section hash.
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const line: BundleEntry = { t: 'dataset', id: d.id, descriptor: d };
    if (d.origin) line.replicaOf = d.origin;
    entries.push(line);
    for (const rec of records) entries.push({ t: 'record', ds: d.id, r: rec });
    sections.push({
      kind: 'dataset', id: d.id, title: d.title || d.id,
      owned: !d.origin,
      ...(d.origin ? { origin: d.origin } : {}),
      scope: d.scope ?? 'cluster',
      syncMode: d.syncMode ?? 'none',
      backend: d.backend,
      warnings,
    });
  }
  const known = new Set(all.map((d) => d.id));
  const unknown = (sel.datasets ?? []).filter((id) => !known.has(id));
  return { ok: true, value: { entries, sections, excluded, unknown } };
}

// ─── orphans ────────────────────────────────────────────────────────────────

export interface OrphanStore {
  id: string;
  backend: 'cache' | 'sql';
  bytes: number;
  /** Only an LMDB `-lock` file remains (the data file is gone). */
  lockOnly?: boolean;
}

function fileBytes(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** LMDB / SQLite stores under `dataRoot` that no descriptor names. Reported, never exported. */
export function findOrphans(dataRoot: string, knownIds: ReadonlySet<string>): OrphanStore[] {
  const out: OrphanStore[] = [];
  const scan = (dir: string, backend: 'cache' | 'sql', ext: string, side: string[]) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const ids = new Set<string>();
    for (const n of names) {
      for (const suf of [ext, ...side.map((s) => ext + s)]) {
        if (n.endsWith(suf)) { ids.add(n.slice(0, -suf.length)); break; }
      }
    }
    for (const id of [...ids].sort()) {
      if (knownIds.has(id)) continue;
      const main = path.join(dir, id + ext);
      const bytes = [ext, ...side.map((s) => ext + s)].reduce((n, s) => n + fileBytes(path.join(dir, id + s)), 0);
      const o: OrphanStore = { id, backend, bytes };
      if (backend === 'cache' && !fs.existsSync(main)) o.lockOnly = true;
      out.push(o);
    }
  };
  scan(path.join(dataRoot, 'cache'), 'cache', '.lmdb', ['-lock']);
  scan(path.join(dataRoot, 'sql'), 'sql', '.sqlite', ['-wal', '-shm']);
  return out;
}

/** Approximate on-disk bytes of an owned/replica dataset's store (null when not measured). */
export function datasetDiskBytes(dataRoot: string, d: DatasetDescriptor): number | null {
  if (d.backend === 'cache') {
    const p = path.join(dataRoot, 'cache', `${d.id}.lmdb`);
    return fileBytes(p) + fileBytes(`${p}-lock`);
  }
  if (d.backend === 'sql') {
    const p = path.join(dataRoot, 'sql', `${d.id}.sqlite`);
    return fileBytes(p) + fileBytes(`${p}-wal`) + fileBytes(`${p}-shm`);
  }
  return null;
}

// ─── mission neutralization ─────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The one domain transform: a mission the supervisor would act on (active|waiting|blocked)
 * lands `paused`, unbound, with no in-flight spawn — so an import never launches sessions.
 * Returns null when the record needs nothing. With `recordHistory` (replace mode) the change
 * is appended to the mission's own inline history as a new rev.
 */
export function neutralizeMission(
  r: DataRecord,
  o: { recordHistory: boolean; nowMs: number; node: string },
): DataRecord | null {
  if (r.deleted === true || !isObj(r.fields)) return null;
  const f = r.fields;
  const status = f.status;
  if (typeof status !== 'string' || !MISSION_LIVE_STATUSES.has(status)) return null;
  const control = isObj(f.control) ? { ...f.control } : undefined;
  if (control) { delete control.spawnInFlight; delete control.lastSpawnRequest; }
  const next: Record<string, unknown> = { ...f, status: 'paused', binding: null };
  if (control) next.control = control;
  if (o.recordHistory) {
    const rev = (typeof f.rev === 'number' ? f.rev : 1) + 1;
    const changes: Record<string, { from: unknown; to: unknown }> = { status: { from: status, to: 'paused' } };
    if (f.binding !== null && f.binding !== undefined) changes.binding = { from: f.binding, to: null };
    const history = Array.isArray(f.history) ? [...f.history] : [];
    history.push({
      rev, at: o.nowMs, changes,
      actor: { kind: 'user', channel: 'api', node: o.node, label: 'bundle import (neutralized)', at: o.nowMs },
    });
    next.rev = rev;
    next.history = history.slice(-MISSION_HISTORY_INLINE_CAP);
    next.updatedAt = o.nowMs;
  }
  return { ...r, fields: next };
}

// ─── import ─────────────────────────────────────────────────────────────────

/** What the section did (or would do) at the dataset level. */
export type DatasetAction = 'import' | 'create' | 'takeover' | 'skip' | 'refuse';

export type DatasetSectionPlan = SectionPlan & { action?: DatasetAction };

export interface DatasetImportContext {
  data: RawDataPort;
  registry: RegistryPort;
  apply: boolean;
  policy: ImportPolicy;
  takeOwnership: boolean;
  /** Proceed when the roster is UNAVAILABLE (never when an owner is online). */
  force: boolean;
  selfNode: string;
  selfCluster: string | null;
  /** The exporting node's cluster (manifest source.cluster). */
  sourceCluster?: string;
  /** The fleet roster, read once per plan/apply (memoized by the caller). */
  roster: () => Promise<RosterSnapshot>;
  /** Promote a replica (apply only). The caller has already checked the guard. */
  promote: (id: string, patch: PromoteReplicaPatch) => Promise<void>;
  /** Which ONLINE peer already owns a dataset (memoized per operation). Absent ⇒ nobody. */
  onlineOwner?: (id: string, scope?: 'cluster' | 'fleet') => Promise<OwnerProbe>;
  now: () => number;
}

/** Well-formed enough to store — mirrors DataService's own check (the apply's authority). */
function isImportableRecord(r: unknown): r is DataRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as DataRecord;
  return typeof x.id === 'string' && x.id.length > 0
    && typeof x.version === 'number' && Number.isFinite(x.version) && x.version >= 0
    && isObj(x.fields)
    && typeof x.createdAt === 'string' && typeof x.updatedAt === 'string'
    && (x.deleted === undefined || typeof x.deleted === 'boolean');
}

/** importRaw's `invalid` bucket has no plan bucket of its own: it lands in `skipped`. */
function bucketOf(b: string): PlanBucket {
  return b === 'invalid' ? 'skipped' : (b as PlanBucket);
}

function refuse(plan: DatasetSectionPlan, code: string, reason: string): DatasetSectionPlan {
  plan.refused = { code, reason };
  plan.action = 'refuse';
  return plan;
}

function skipAll(plan: DatasetSectionPlan, count: number, warning: string): DatasetSectionPlan {
  plan.counts.skipped += count;
  plan.warnings.push(warning);
  plan.action = 'skip';
  return plan;
}

const label = (o: NodeOrigin | undefined, fallback: string): string => (o?.hostname ? `${o.hostname} (${o.machineId})` : fallback);

/**
 * Plan (ctx.apply=false) or apply one dataset section. Never throws for a per-dataset
 * problem: refusals are `refused{code,reason}` on the section, so one refused dataset
 * never blocks the rest of the bundle.
 */
export async function importDatasetSection(sec: ReadSection, ctx: DatasetImportContext): Promise<DatasetSectionPlan> {
  const id = sec.id;
  const plan: DatasetSectionPlan = newSectionPlan('dataset', id, sec.summary?.title);
  const bundleDesc = sec.dataset?.descriptor;
  const replicaOf = sec.dataset?.replicaOf ?? bundleDesc?.origin ?? null;
  if (!bundleDesc || typeof bundleDesc !== 'object') {
    return refuse(plan, 'BAD_SECTION_DATA', `dataset section "${id}" has no descriptor line`);
  }

  // Bundle-side exclusions: never imported, whatever the bundle says.
  if (bundleDesc.system) return skipAll(plan, sec.records.length, `system: "${id}" is a system dataset — skipped`);
  if (DATASET_EXPORT_DENY.has(id)) return skipAll(plan, sec.records.length, `denied: "${id}" is runtime state that self-heals — skipped`);
  if (DATASET_UNSUPPORTED_BACKENDS.has(bundleDesc.backend)) {
    return skipAll(plan, sec.records.length, `unsupported: backend "${bundleDesc.backend}" is derived or file-backed — skipped`);
  }
  if (!DATASET_ID_RE.test(id) || RESERVED_DATASET_IDS.has(id)) {
    return refuse(plan, 'BAD_DATASET_ID', `dataset id "${id}" is invalid or reserved on this node`);
  }

  // Records: missions never carries its runtime ids (live missions are neutralized below,
  // once the local copy is known).
  let records = sec.records;
  const neutralizedIds = new Set<string>();
  if (id === MISSIONS_DATASET) {
    const kept = records.filter((r) => !(r && MISSIONS_RESERVED_IDS.has(r.id)));
    if (kept.length !== records.length) {
      plan.counts.skipped += records.length - kept.length;
      plan.warnings.push(`reserved: ${records.length - kept.length} runtime record(s) (__controller__/__engagement__) are never imported`);
    }
    records = kept;
  }

  const scope = bundleDesc.scope ?? 'cluster';
  if (scope === 'cluster' && ctx.sourceCluster && ctx.selfCluster && ctx.sourceCluster !== ctx.selfCluster) {
    plan.warnings.push(`cross-cluster: exported from cluster "${ctx.sourceCluster}", this node is in "${ctx.selfCluster}" — records merge by LWW into this cluster's copy`);
  }

  const bundleOwner = replicaOf?.machineId ?? bundleDesc.ownerNode;
  const local = ctx.registry.get(id);
  let exists = !!local;
  plan.action = 'import';

  if (local) {
    if (local.system || DATASET_UNSUPPORTED_BACKENDS.has(local.backend)) {
      return skipAll(plan, records.length, `system: the local "${id}" is a system or derived dataset — skipped`);
    }
    if (local.readOnly) return refuse(plan, 'FORBIDDEN', `the local "${id}" is read-only (readOnly caps every principal)`);
    if (local.origin) {
      const host = label(local.origin, local.ownerNode);
      if (!ctx.takeOwnership) {
        return refuse(plan, 'REPLICA_READ_ONLY',
          `"${id}" is a read-only replica here; its origin is ${host}. Import on the origin ${local.origin.hostname || local.origin.machineId}, `
          + 'or pass takeOwnership:true to take it over first (refused while the origin is online)');
      }
      if (local.syncMode !== 'full') {
        return refuse(plan, 'NOT_SUPPORTED', `cannot take over "${id}": it is a ${local.syncMode ?? 'non-full'} replica — it caches only what was read and is not a copy of the dataset; import on the origin ${host}, or convert it to full sync first`);
      }
      const snap = await ctx.roster();
      if (snap.available && snap.peers.has(local.origin.machineId)) {
        return refuse(plan, 'ORIGIN_ONLINE', `cannot take over "${id}": its origin ${host} is online — import there instead`);
      }
      if (!snap.available && !ctx.force) {
        return refuse(plan, 'ROSTER_UNAVAILABLE', `cannot tell whether the origin ${host} is online (${snap.reason}); pass force:true to take over anyway`);
      }
      const owner = await probeOwner(ctx, id, local.scope);
      if (owner.kind === 'owner') {
        return refuse(plan, 'OWNER_ONLINE', `cannot take over "${id}": ${owner.peer.hostname || owner.peer.node} (${owner.peer.node}) already owns it and is online — this replica just has not re-pointed yet. Import there instead`);
      }
      if (owner.kind === 'unknown' && !ctx.force) {
        return refuse(plan, 'ROSTER_UNAVAILABLE', `cannot tell whether another online node already owns "${id}" (${owner.reason}); pass force:true to take over anyway`);
      }
      plan.action = 'takeover';
      // The bundle's visibility/ACL only when the bundle side OWNED it — a replica's
      // local-only/empty ACL is an artifact of replication, not the owner's choice.
      const patch: PromoteReplicaPatch = replicaOf ? {} : { visibility: bundleDesc.visibility, acl: Array.isArray(bundleDesc.acl) ? bundleDesc.acl : undefined };
      if (ctx.apply) {
        try {
          await ctx.promote(id, patch);
        } catch (e) {
          return refuse(plan, (e as { code?: string }).code || 'TAKEOVER_FAILED', (e as Error).message || String(e));
        }
        plan.warnings.push(`takeover: the replica of ${host} was promoted to owned before importing`);
      } else {
        plan.warnings.push(`takeover: the replica of ${host} would be promoted to owned before importing${snap.available ? '' : ' (forced: roster unavailable)'}`);
      }
    } else if (bundleOwner && bundleOwner !== ctx.selfNode) {
      plan.warnings.push(`foreign-owner: the bundle's copy was owned by ${label(replicaOf ?? undefined, bundleOwner)}; its records are merged by LWW into this node's owned copy`);
    }
    if (local.backend !== bundleDesc.backend) {
      plan.warnings.push(`backend-differs: bundle "${bundleDesc.backend}", local "${local.backend}" — records are written to the local backend`);
    }
  } else {
    const synced = !!bundleDesc.syncMode && bundleDesc.syncMode !== 'none';
    let supersedes: import('../../types').SupersedesMarker | undefined;
    if (synced && bundleOwner !== ctx.selfNode) {
      const snap = await ctx.roster();
      const ownerInfo = snap.available ? snap.peers.get(bundleOwner) : undefined;
      if (ownerInfo) {
        return refuse(plan, 'OWNER_ONLINE',
          `"${id}" is owned by ${ownerInfo.hostname || bundleOwner} (${bundleOwner}), which is online — importing here would mint a second owner. `
          + `Import on ${ownerInfo.hostname || bundleOwner}, or wait for replication`);
      }
      if (!snap.available && !ctx.force) {
        return refuse(plan, 'ROSTER_UNAVAILABLE',
          `cannot tell whether the owner ${bundleOwner} of "${id}" is online (${snap.reason}); pass force:true to create an owned copy anyway`);
      }
      const owner = await probeOwner(ctx, id, bundleDesc.scope);
      if (owner.kind === 'owner') {
        return refuse(plan, 'OWNER_ONLINE',
          `"${id}" is already owned by ${owner.peer.hostname || owner.peer.node} (${owner.peer.node}), which is online — importing here would mint a second owner. `
          + `Let it replicate here, or import on ${owner.peer.hostname || owner.peer.node}`);
      }
      if (owner.kind === 'unknown' && !ctx.force) {
        return refuse(plan, 'ROSTER_UNAVAILABLE',
          `cannot tell whether another online node already owns "${id}" (${owner.reason}); pass force:true to create an owned copy anyway`);
      }
      plan.warnings.push(`owner-offline: ${bundleOwner} is ${snap.available ? 'not online' : 'of unknown state (forced)'} — this node creates the owned copy; if ${bundleOwner} returns it demotes itself to a replica of this node`);
      // The returning owner must find a marker naming it, or it stays a second owner forever.
      supersedes = { machineId: bundleOwner, hostname: replicaOf?.hostname ?? '', at: new Date(ctx.now()).toISOString() };
    } else if (synced) {
      // Rebuilt origin: this node's own dataset, restored. A node that TOOK IT OVER while
      // this one was gone is the owner now — creating here would split the brain.
      const owner = await probeOwner(ctx, id, bundleDesc.scope);
      if (owner.kind === 'owner') {
        return refuse(plan, 'OWNER_ONLINE',
          `"${id}" was taken over by ${owner.peer.hostname || owner.peer.node} (${owner.peer.node}), which is online and owns it now — let it replicate here instead of restoring a second owner`);
      }
      plan.warnings.push(`rebuilt-origin: replicas on other nodes may hold versions newer than this bundle; this node's later writes to those records lose LWW there until its version overtakes. If a replica is online and current, prefer a takeover on that replica and export from there`);
    }
    plan.action = 'create';
    if (ctx.apply) {
      const c = await ctx.data.createDatasetFromBundle(LOCAL, bundleDesc, { replicaOf, ...(supersedes ? { supersedes } : {}) });
      if (!c.ok) return refuse(plan, c.code, c.reason);
      exists = true;
      plan.warnings.push(`create: "${id}" was created from the bundle descriptor`);
    } else {
      plan.warnings.push(`create: "${id}" does not exist here — it would be created from the bundle descriptor`);
    }
  }

  // Per-record decisions against a RAW read of the local copy (empty when absent).
  const localMap = new Map<string, DataRecord>();
  if (exists) {
    const r = await ctx.data.exportRaw(LOCAL, id);
    if (!r.ok) return refuse(plan, r.code, r.reason);
    for (const rec of r.value) localMap.set(rec.id, rec);
  }
  const nowIso = new Date(ctx.now()).toISOString();
  if (id === MISSIONS_DATASET) {
    const nowMs = ctx.now();
    records = records.map((r) => {
      if (!isImportableRecord(r)) return r;
      const p = prepareMission(r, localMap.get(r.id) ?? null, ctx.policy, { nowIso, nowMs, node: ctx.selfNode });
      if (p.neutralized) neutralizedIds.add(r.id);
      return p.record;
    });
  }
  const neutralizedWrites: string[] = [];
  let invalid = 0;
  for (const rec of records) {
    if (!isImportableRecord(rec)) {
      invalid++;
      if (!ctx.apply) bump(plan, 'skipped', typeof (rec as { id?: unknown })?.id === 'string' ? (rec as { id: string }).id : undefined);
      continue;
    }
    if (recordTooLarge(rec)) { if (!ctx.apply) bump(plan, 'tooLarge', rec.id); continue; }
    const d = planImportRecord(rec, localMap.get(rec.id) ?? null, ctx.policy, nowIso);
    if (!ctx.apply) bump(plan, bucketOf(d.bucket), rec.id);
    if (neutralizedIds.has(rec.id) && (d.bucket === 'add' || d.bucket === 'update')) {
      neutralizedWrites.push(rec.id);
      if (!ctx.apply) bump(plan, 'neutralized', rec.id);
    }
  }
  if (!ctx.apply) {
    if (invalid) plan.warnings.push(`invalid: ${invalid} record(s) are not well-formed and would be skipped`);
    return plan;
  }

  let out: Awaited<ReturnType<RawDataPort['importRaw']>>;
  try {
    out = await ctx.data.importRaw(LOCAL, id, records, { policy: ctx.policy, dryRun: false });
  } catch (e) {
    return refuse(plan, 'IMPORT_FAILED', e instanceof Error ? e.message : String(e));
  }
  if (!out.ok) return refuse(plan, out.code, out.reason);
  const applied = emptyCounts();
  for (const [b, n] of Object.entries(out.value.counts)) {
    const pb = bucketOf(b);
    plan.counts[pb] += n;
    for (const s of out.value.samples[b as keyof typeof out.value.samples] ?? []) {
      const list = (plan.samples[pb] ??= []);
      if (list.length < SAMPLE_CAP) list.push(s);
    }
  }
  if (out.value.counts.invalid) plan.warnings.push(`invalid: ${out.value.counts.invalid} record(s) were not well-formed and were skipped`);
  applied.add = out.value.counts.add;
  applied.update = out.value.counts.update;
  // A stopped import counts only the neutralized missions it actually got to.
  const done = new Set([...(out.value.samples.add ?? []), ...(out.value.samples.update ?? [])]);
  const neutralizedDone = out.value.failed ? neutralizedWrites.filter((n) => done.has(n)) : neutralizedWrites;
  for (const nid of neutralizedDone) bump(plan, 'neutralized', nid);
  applied.neutralized = neutralizedDone.length;
  plan.applied = applied;
  plan.errors = [];
  if (out.value.failed) {
    plan.errors.push(out.value.failed.reason);
    plan.refused = { code: out.value.failed.code, reason: `stopped part-way — ${out.value.failed.reason}. ${applied.add + applied.update} record(s) were written before the stop; re-running the apply is safe` };
    plan.action = 'refuse';
  }
  return plan;
}

async function probeOwner(ctx: DatasetImportContext, id: string, scope?: 'cluster' | 'fleet'): Promise<OwnerProbe> {
  if (!ctx.onlineOwner) return { kind: 'none' };
  try { return await ctx.onlineOwner(id, scope); } catch (e) { return { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) }; }
}

/** Mission fields that are bookkeeping, not content: a record that differs only here is the
 *  same mission state (re-applying a bundle must be a no-op). */
const MISSION_BOOKKEEPING = ['history', 'rev', 'updatedAt', 'lastUpdatedBy'] as const;

function missionContentEqual(a: DataRecord, b: DataRecord): boolean {
  const strip = (r: DataRecord): DataRecord => {
    const f: Record<string, unknown> = { ...(r.fields ?? {}) };
    for (const k of MISSION_BOOKKEEPING) delete f[k];
    return { ...r, fields: f };
  };
  return sameRecordContent(strip(a), strip(b));
}

/**
 * The record a mission import actually hands importRaw, decided against the LOCAL copy:
 *  - a record the policy would SKIP is passed raw — never neutralized — so it buckets as
 *    skipIdentical / skipOlder / skipExists exactly as any other dataset's record would, and
 *    an identical copy of a running mission does not pause and unbind it;
 *  - a record that would be written onto a present mission never LOWERS its `rev`: the
 *    durable mission-history keys entries `<id>:<rev>`, so a regressed rev makes later edits
 *    silently overwrite real history. It is rebased onto the local rev + 1 with the local
 *    inline history plus one "bundle import" entry;
 *  - live statuses are then neutralized (paused, unbound, no in-flight spawn);
 *  - a result whose mission content already equals the local copy (a re-apply) is replaced
 *    by the local record itself, so importRaw counts it skipIdentical instead of re-writing.
 */
export function prepareMission(
  raw: DataRecord,
  local: DataRecord | null,
  policy: ImportPolicy,
  o: { nowIso: string; nowMs: number; node: string },
): { record: DataRecord; neutralized: boolean } {
  const decision = planImportRecord(raw, local, policy, o.nowIso);
  if (!decision.write) return { record: raw, neutralized: false };
  let base = raw;
  let rebased = false;
  if (local && isObj(local.fields) && isObj(raw.fields) && local.deleted !== true && raw.deleted !== true) {
    const localRev = typeof local.fields.rev === 'number' ? local.fields.rev : 0;
    const bundleRev = typeof raw.fields.rev === 'number' ? raw.fields.rev : 0;
    if (bundleRev <= localRev) {
      const rev = localRev + 1;
      const changes = diffMission(local.fields as never, raw.fields as never);
      const history = [...(Array.isArray(local.fields.history) ? local.fields.history : []), {
        rev, at: o.nowMs, changes,
        actor: { kind: 'user', channel: 'api', node: o.node, label: `bundle import (${policy})`, at: o.nowMs },
      }];
      base = { ...raw, fields: { ...raw.fields, rev, history: history.slice(-MISSION_HISTORY_INLINE_CAP), updatedAt: o.nowMs } };
      rebased = true;
    }
  }
  const n = neutralizeMission(base, { recordHistory: policy === 'replace' || rebased, nowMs: o.nowMs, node: o.node });
  const record = n ?? base;
  if (local && missionContentEqual(record, local)) return { record: local, neutralized: false };
  return { record, neutralized: !!n };
}
