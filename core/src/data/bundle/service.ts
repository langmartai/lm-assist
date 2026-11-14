/**
 * The bundle service — ONE implementation the REST routes, MCP tools, web UI and the scheduled
 * snapshot all call (spec: "Surfaces").
 *
 *   inventory()                     what an export would hold + "is my data safe" (sync health)
 *   createExport(opts)              collect sections → writeBundle (DISK_LOW first) → retention prune
 *   listBundles / inspect / deleteBundle / readChunk / uploadChunk / importReceived   store passthroughs
 *   plan(ref, opts)                 dry run: per-section counts + ≤10 samples, refusals, warnings
 *   apply(ref, {…, confirm:true})   the same shape plus `applied`; CONFIRM_REQUIRED without confirm
 *   takeover(datasetId, {force})    guarded replica → owner promotion
 *   fetchFromPeer(fromNode, id)     pull a bundle from another node through the hub, verify, store
 *
 * Everything runs in the Core process with the internal local ctx: the ROUTE (or tool) is the
 * auth boundary. Results are plain, compact JSON — counts and sample ids, never whole records —
 * so they fit the MCP result cap and the hub relay. Failures throw a coded error
 * (BundleServiceError, or the store/format's BundleError); both carry `.code`.
 */

import * as fs from 'fs';
import * as os from 'os';
import type { DatasetDescriptor, SyncStatus } from '../types';
import type { BundleSource, BundleEntry, BundleManifest, SectionSummary, SectionSummaryInput, FilesSectionId } from './format';
import { isBundleId } from './format';
import { BundleStore, getBundleStore, type StoredBundleInfo, type ChunkResult, type UploadChunkInput, type UploadChunkResult, type StoredImportResult } from './store';
import type { PeerRoster, RosterSnapshot } from './roster';
import { defaultRoster, isOnline, ownerProbe } from './roster';
import {
  classifyForExport, collectDatasets, datasetDiskBytes, findOrphans, importDatasetSection, neverExportReason, wellFormedDescriptors,
  MISSIONS_DATASET, MISSIONS_RESERVED_IDS,
  type DatasetSectionPlan, type OrphanStore, type RawDataPort, type RegistryPort,
} from './sections/datasets';
import { isImportPolicy, emptyCounts, PLAN_BUCKETS, type ConfigProvider, type FilesProvider, type ImportPolicy, type PlanCounts, type SectionPlan } from './sections/types';

// ─── errors ─────────────────────────────────────────────────────────────────

/** A coded refusal from the service layer. `details` carries the numbers a caller shows. */
export class BundleServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'BundleServiceError';
  }
}

/** The `.code` of any error this layer throws (service, store or format), else 'INTERNAL'. */
export function bundleErrorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && c ? c : 'INTERNAL';
}

// ─── options / results ──────────────────────────────────────────────────────

/** Section groups a caller selects: every dataset, every config provider, or one files section. */
export type SectionGroup = 'datasets' | 'config' | FilesSectionId;
export const SECTION_GROUPS: readonly SectionGroup[] = ['datasets', 'config', 'knowledge', 'claude-memory', 'claude-rules'];
/** Default export: owned datasets + sanitized config. Everything else is opt-in. */
export const DEFAULT_EXPORT_GROUPS: readonly SectionGroup[] = ['datasets', 'config'];

/** Secrets and derived stores a bundle never carries (spec Non-goals) — shown by inventory. */
export const NEVER_EXPORTED: readonly string[] = [
  'secrets: api-token*, scoped-tokens.json, hub*.json, machine-id*, gateway-id*, tls*/, local-ui-secret, keys.lmdb, '
    + 'github-accounts.json, WhatsApp/Gmail/panetest browser profiles, harness provider keys, controller*/ configs, assist-config lanAccessToken',
  'derived stores (rebuild themselves): system sql indexes (session-prompts, memory-files), knowledge/vectors system datasets, '
    + 'log-* file datasets, lance-store, session-cache, memory-cache, rules-mirror, bus, task-store, monitor state',
  'runtime datasets: node-clusters, mcp-bootstrap',
  'session JSONL under ~/.claude/projects (backup_run owns ~/.claude)',
];

export interface ExportOptions {
  /** Section groups; default datasets + config. The include* flags add to it. */
  sections?: string[];
  /** Restrict the datasets section to these ids (naming a replica opts it in). */
  datasets?: string[];
  includeReplicas?: boolean;
  includeKnowledge?: boolean;
  /** Claude project memory AND own rules. */
  includeClaudeMemory?: boolean;
  note?: string;
}

export interface ImportOptions {
  policy?: string;
  sections?: string[];
  datasets?: string[];
  /** Take over a replica-held dataset (guarded) before importing into it. */
  takeOwnership?: boolean;
  /** Proceed when the fleet roster is UNAVAILABLE. Never overrides an online owner. */
  force?: boolean;
}

export interface ApplyOptions extends ImportOptions {
  confirm?: boolean;
}

export interface ExportResult {
  bundleId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  note?: string;
  sections: CompactSection[];
  totals: BundleManifest['totals'];
  /** Datasets left out of this export, with the reason. */
  excluded: Array<{ id: string; reason: string }>;
  warnings: string[];
  pruned: string[];
  /** How to move it: run this on the TARGET node. */
  next: string;
}

/** A manifest section without its hash — what list/inspect/create results show. */
export type CompactSection = Omit<SectionSummary, 'sha256'>;

export interface ImportResult {
  bundleId: string;
  policy: ImportPolicy;
  dryRun: boolean;
  source: BundleSource;
  createdAt: string;
  note?: string;
  sections: SectionPlan[];
  /** Sum of every section's counts. */
  totals: PlanCounts;
  /** Apply only: sum of every section's applied counts. */
  applied?: PlanCounts;
  refused: number;
  warnings: string[];
}

export interface TakeoverResult {
  dataset: string;
  records: number;
  tombstones: number;
  superseded: { machineId: string; hostname: string };
  ownerNode: string;
  visibility: string;
  forced: boolean;
  note: string;
}

export interface InventoryDataset {
  id: string;
  title?: string;
  backend: string;
  owned: boolean;
  ownerNode: string;
  origin?: { machineId: string; hostname: string };
  /** Origin online per the fleet roster; null when the roster is unavailable (or owned). */
  originOnline?: boolean | null;
  supersedes?: { machineId: string; hostname: string; at: string };
  scope: string;
  syncMode: string;
  /** default = in a default export; opt-in = replica; never = excluded (see reason). */
  export: 'default' | 'opt-in' | 'never';
  reason?: string;
  records: number | null;
  tombstones: number | null;
  approxBytes: number | null;
  error?: string;
}

export interface Inventory {
  node: { nodeId: string; hostname: string; cluster: string | null; mode: 'prod' | 'dev' };
  /** Read only when a replica exists (its origin's online dot needs it) — no hub call otherwise. */
  roster: { queried: boolean; available?: boolean; reason?: string; onlinePeers?: number };
  datasets: InventoryDataset[];
  orphans: OrphanStore[];
  /** Registry entries with no usable `id` — never exported; counted so they are not invisible. */
  malformedDescriptors?: number;
  sections: {
    config: Array<{ id: string; title: string; default: true }>;
    files: Array<{ id: string; title: string; default: false; option: 'includeKnowledge' | 'includeClaudeMemory' }>;
  };
  neverExported: readonly string[];
  sync: { lastRun: string | null; peersChecked: number; datasetsReplicated: number; errors: string[] } | null;
  bundles: { count: number; newest?: string };
}

export interface BundleSelf {
  nodeId: string;
  hostname: string;
  platform: string;
  version: string;
  mode: 'prod' | 'dev';
  cluster: string | null;
}

// ─── deps ───────────────────────────────────────────────────────────────────

export interface BundleServiceDeps {
  data?: () => RawDataPort;
  registry?: () => RegistryPort;
  store?: () => BundleStore;
  roster?: PeerRoster;
  configProviders?: () => ConfigProvider[];
  filesProviders?: () => FilesProvider[];
  self?: () => BundleSelf;
  /** The data-service root (`<dataDir>/data{-dev}`) — for orphans and store sizes. */
  dataRoot?: () => string;
  syncStatus?: () => SyncStatus | null;
  /** Change-notify after a takeover so same-cluster peers pull now. */
  notify?: (d: DatasetDescriptor, ids: string[]) => void;
  /** Drop in-memory caches that shadow datasets an apply wrote or created. */
  invalidate?: (datasetIds: string[]) => void;
  /** Transport for fetchFromPeer (default: the hub machine-proxy). */
  fetchTransport?: import('./fetch').FetchTransport;
  now?: () => number;
}

// ─── defaults (lazy — nothing heavy loads until a method runs) ──────────────

function defaultSelf(): BundleSelf {
  const { thisNodeId } = require('../paths') as typeof import('../paths');
  const { isDevRepo } = require('../../utils/path-utils') as typeof import('../../utils/path-utils');
  let hostname = os.hostname();
  let version = '0.0.0';
  try {
    const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
    const cfg = getHubConfig();
    hostname = cfg.hostname || hostname;
    version = cfg.version || version;
  } catch { /* keep os defaults */ }
  let cluster: string | null = null;
  try {
    const { getMyCluster } = require('../../cluster/cluster-config') as typeof import('../../cluster/cluster-config');
    cluster = getMyCluster();
  } catch { /* unknown */ }
  return { nodeId: thisNodeId(), hostname, platform: os.platform(), version, mode: isDevRepo() ? 'dev' : 'prod', cluster };
}

const DATA_SERVICE_OFF_WARNING = 'data-service-disabled: dataServiceEnabled is off on this node — imported datasets are stored but not served or replicated until it is enabled';

function dataServiceOff(data: RawDataPort): boolean {
  try { return typeof data.isEnabled === 'function' && data.isEnabled() === false; } catch { return false; }
}

function defaultNotify(d: DatasetDescriptor, ids: string[]): void {
  // Same guard DataService.notifyChange applies: only synced, non-sensitive datasets
  // travel, and a disabled bus is a silent no-op (the 300 s reconcile heals).
  if (d.sensitive || !d.syncMode || d.syncMode === 'none') return;
  try {
    const { getBus } = require('../../bus') as typeof import('../../bus');
    const { boundNotifyIds } = require('../data-service') as typeof import('../data-service');
    getBus().publish(`data:${d.id}`, 'changed', { ids: boundNotifyIds(ids) });
  } catch { /* bus off / not ready */ }
}

/** Datasets whose content an in-memory cache shadows, and the hook that drops it. */
function defaultInvalidate(ids: string[]): void {
  const touched = new Set(ids);
  if (touched.has('mcp-tool-registry')) {
    try { (require('../../mcp-server/registry/overlay-live') as typeof import('../../mcp-server/registry/overlay-live')).invalidateOverlayCache(); } catch { /* not loaded in this process */ }
  }
  if (touched.has('assist-content-registry')) {
    try { (require('../../mcp-server/registry/content-live') as typeof import('../../mcp-server/registry/content-live')).invalidateContentOverlayCache(); } catch { /* not loaded in this process */ }
  }
  // node-profiles, missions, mission-views and the workflow stores read the data service on
  // every call (no record cache). Their `ensured` flags only guard a create-if-absent that an
  // import never invalidates: import creates, it never drops.
}

const LOCAL = { principal: { type: 'local' as const } };

function compactSection(s: SectionSummary): CompactSection {
  const { sha256: _h, ...rest } = s;
  return rest;
}

function sumCounts(into: PlanCounts, add: PlanCounts | undefined): void {
  if (!add) return;
  for (const b of PLAN_BUCKETS) into[b] += add[b] ?? 0;
}

function asStringList(v: unknown, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new BundleServiceError('BAD_REQUEST', `${what} must be an array of strings`);
  }
  return v as string[];
}

function parseGroups(v: unknown, fallback: readonly SectionGroup[]): Set<SectionGroup> {
  const list = asStringList(v, 'sections');
  if (!list) return new Set(fallback);
  const bad = list.filter((s) => !(SECTION_GROUPS as readonly string[]).includes(s));
  if (bad.length) {
    throw new BundleServiceError('BAD_REQUEST', `unknown section(s) ${JSON.stringify(bad)} — expected any of ${SECTION_GROUPS.join(', ')}`);
  }
  return new Set(list as SectionGroup[]);
}

// ─── service ────────────────────────────────────────────────────────────────

export class BundleService {
  private readonly d: Required<Omit<BundleServiceDeps, 'fetchTransport' | 'roster'>> & Pick<BundleServiceDeps, 'fetchTransport'> & { roster: PeerRoster | null };

  constructor(deps: BundleServiceDeps = {}) {
    this.d = {
      data: deps.data ?? (() => (require('../data-service') as typeof import('../data-service')).getDataService()),
      registry: deps.registry ?? (() => (require('../dataset-registry') as typeof import('../dataset-registry')).getDatasetRegistry()),
      store: deps.store ?? getBundleStore,
      roster: deps.roster ?? null,
      configProviders: deps.configProviders ?? (() => (require('./sections/config') as typeof import('./sections/config')).createConfigProviders()),
      filesProviders: deps.filesProviders ?? (() => (require('./sections/files') as typeof import('./sections/files')).createFilesProviders()),
      self: deps.self ?? defaultSelf,
      dataRoot: deps.dataRoot ?? (() => (require('../paths') as typeof import('../paths')).dataRoot()),
      syncStatus: deps.syncStatus ?? (() => {
        try { return (require('../data-service') as typeof import('../data-service')).getSyncEngine().status(); } catch { return null; }
      }),
      notify: deps.notify ?? defaultNotify,
      invalidate: deps.invalidate ?? defaultInvalidate,
      fetchTransport: deps.fetchTransport,
      now: deps.now ?? Date.now,
    };
  }

  private roster(): PeerRoster {
    if (!this.d.roster) this.d.roster = defaultRoster();
    return this.d.roster;
  }

  /** One roster read per operation — every guard in a plan/apply sees the same snapshot. */
  private memoRoster(): () => Promise<RosterSnapshot> {
    let p: Promise<RosterSnapshot> | null = null;
    return () => (p ??= this.roster().snapshot());
  }

  // ─── inventory ────────────────────────────────────────────────────────

  async inventory(): Promise<Inventory> {
    const self = this.d.self();
    const registry = this.d.registry();
    const data = this.d.data();
    const root = this.d.dataRoot();
    const { valid: all, malformed } = wellFormedDescriptors(registry.list());
    const anyReplica = all.some((x) => !!x.origin);
    const snap: RosterSnapshot | null = anyReplica ? await this.roster().snapshot() : null;

    const datasets: InventoryDataset[] = [];
    for (const x of all) {
      const never = neverExportReason(x);
      const row: InventoryDataset = {
        id: x.id,
        ...(x.title ? { title: x.title } : {}),
        backend: x.backend,
        owned: !x.origin,
        ownerNode: x.ownerNode,
        scope: x.scope ?? 'cluster',
        syncMode: x.syncMode ?? 'none',
        export: never ? 'never' : x.origin ? 'opt-in' : 'default',
        records: null,
        tombstones: null,
        approxBytes: datasetDiskBytes(root, x),
      };
      if (never) row.reason = never;
      else if (x.origin) row.reason = (classifyForExport(x) as { reason?: string }).reason;
      if (x.origin) {
        row.origin = { machineId: x.origin.machineId, hostname: x.origin.hostname };
        row.originOnline = snap ? isOnline(snap, x.origin.machineId) : null;
      }
      if (x.supersedes) row.supersedes = { ...x.supersedes };
      if (!never) {
        const r = await data.exportRaw(LOCAL, x.id);
        if (r.ok) {
          let recs = r.value;
          if (x.id === MISSIONS_DATASET) recs = recs.filter((q) => !MISSIONS_RESERVED_IDS.has(q.id));
          row.records = recs.length;
          row.tombstones = recs.filter((q) => q.deleted === true).length;
        } else {
          row.error = `${r.code}: ${r.reason}`;
        }
      }
      datasets.push(row);
    }

    let bundles: StoredBundleInfo[] = [];
    try { bundles = await this.d.store().list(); } catch { /* store unreadable — count stays 0 */ }
    const status = this.d.syncStatus();
    return {
      node: { nodeId: self.nodeId, hostname: self.hostname, cluster: self.cluster, mode: self.mode },
      roster: snap
        ? { queried: true, available: snap.available, ...(snap.available ? { onlinePeers: snap.peers.size } : { reason: snap.reason }) }
        : { queried: false },
      datasets,
      orphans: findOrphans(root, new Set(all.map((x) => x.id))),
      ...(malformed ? { malformedDescriptors: malformed } : {}),
      sections: {
        config: this.d.configProviders().map((p) => ({ id: p.id, title: p.title, default: true as const })),
        files: this.d.filesProviders().map((p) => ({
          id: p.id, title: p.title, default: false as const,
          option: p.id === 'knowledge' ? 'includeKnowledge' as const : 'includeClaudeMemory' as const,
        })),
      },
      neverExported: NEVER_EXPORTED,
      sync: status ? {
        lastRun: status.lastRun, peersChecked: status.peersChecked, datasetsReplicated: status.datasetsReplicated,
        errors: status.errors.slice(0, 20),
      } : null,
      bundles: { count: bundles.length, ...(bundles[0] ? { newest: bundles[0].bundleId } : {}) },
    };
  }

  // ─── export ───────────────────────────────────────────────────────────

  async createExport(opts: ExportOptions = {}): Promise<ExportResult> {
    const groups = parseGroups(opts.sections, DEFAULT_EXPORT_GROUPS);
    if (opts.includeKnowledge) groups.add('knowledge');
    if (opts.includeClaudeMemory) { groups.add('claude-memory'); groups.add('claude-rules'); }
    const dsFilter = asStringList(opts.datasets, 'datasets');
    if (opts.note !== undefined && (typeof opts.note !== 'string' || opts.note.length > 500)) {
      throw new BundleServiceError('BAD_REQUEST', 'note must be a string of at most 500 chars');
    }
    const store = this.d.store();
    const registry = this.d.registry();
    const self = this.d.self();

    // DISK_LOW before any reading: a rough size from the stores on disk. The store re-checks
    // against the exact manifest before it writes a byte.
    const root = this.d.dataRoot();
    const estimate = groups.has('datasets')
      ? registry.list().filter((x) => classifyForExport(x, { includeReplicas: opts.includeReplicas, datasets: dsFilter }).included)
        .reduce((n, x) => n + (datasetDiskBytes(root, x) ?? 0), 0)
      : 0;
    store.assertDiskSpace(estimate);

    const entries: BundleEntry[] = [];
    const sections: SectionSummaryInput[] = [];
    const warnings: string[] = [];
    let excluded: Array<{ id: string; reason: string }> = [];

    if (groups.has('datasets')) {
      const r = await collectDatasets({ data: this.d.data(), registry }, { includeReplicas: opts.includeReplicas, datasets: dsFilter });
      if (!r.ok) throw new BundleServiceError(r.code, `${r.reason} — the export was not written (deselect the dataset to export the rest)`);
      entries.push(...r.value.entries);
      sections.push(...r.value.sections);
      excluded = r.value.excluded;
      if (r.value.unknown.length) warnings.push(`unknown dataset id(s) not exported: ${r.value.unknown.join(', ')}`);
    }
    // A config/files source that cannot be read must not block the rest of the backup, and must
    // not vanish either: the section is left out and named in the result AND in the manifest.
    const collectErrors: string[] = [];
    const failed = (id: string, e: unknown) => collectErrors.push(`${id}: ${(e as Error)?.message || String(e)}`);
    if (groups.has('config')) {
      for (const p of this.d.configProviders()) {
        let c;
        try { c = await p.collect(); } catch (e) { failed(p.id, e); continue; }
        entries.push({ t: 'config', id: p.id, data: c.data });
        sections.push({ kind: 'config', id: p.id, title: p.title, warnings: c.warnings, ...(c.redactedKeys.length ? { redactedKeys: c.redactedKeys } : {}) });
      }
    }
    for (const p of this.d.filesProviders()) {
      if (!groups.has(p.id)) continue;
      let c;
      try { c = await p.collect(); } catch (e) { failed(p.id, e); continue; }
      for (const f of c.files) entries.push({ t: 'file', section: p.id, ...f });
      sections.push({ kind: 'files', id: p.id, title: p.title, warnings: c.warnings });
    }
    for (const e of collectErrors) warnings.push(`not exported — ${e}`);

    const source: BundleSource = {
      nodeId: self.nodeId, hostname: self.hostname, platform: self.platform,
      lmAssistVersion: self.version, mode: self.mode, ...(self.cluster ? { cluster: self.cluster } : {}),
    };
    const options: Record<string, unknown> = { sections: SECTION_GROUPS.filter((g) => groups.has(g)) };
    if (dsFilter) options.datasets = dsFilter;
    if (opts.includeReplicas) options.includeReplicas = true;
    if (collectErrors.length) options.collectErrors = collectErrors;
    const res = await store.writeBundle({
      source, options, sections,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      createdAt: new Date(this.d.now()).toISOString(),
    }, entries);
    return {
      bundleId: res.bundleId,
      path: res.path,
      sizeBytes: res.sizeBytes,
      sha256: res.sha256,
      createdAt: res.manifest.createdAt,
      ...(res.manifest.note !== undefined ? { note: res.manifest.note } : {}),
      sections: res.manifest.sections.map(compactSection),
      totals: res.manifest.totals,
      excluded,
      warnings,
      pruned: res.pruned,
      next: `on the target node: data_import{action:'fetch', fromNode:'${self.nodeId}', bundleId:'${res.bundleId}'}, then action:'plan'`,
    };
  }

  // ─── store passthroughs ───────────────────────────────────────────────

  async listBundles(): Promise<Array<Omit<StoredBundleInfo, 'sections'> & { sections?: CompactSection[] }>> {
    const list = await this.d.store().list();
    return list.map((b) => ({ ...b, ...(b.sections ? { sections: b.sections.map(compactSection) } : {}) }));
  }

  /** The manifest (fast read — integrity is checked by plan/apply) plus the store's metadata. */
  async inspect(bundleId: string): Promise<{ bundleId: string; sizeBytes: number; manifest: Omit<BundleManifest, 'sections'> & { sections: CompactSection[] }; imported?: import('./store').ImportedMeta }> {
    const store = this.d.store();
    const file = store.resolveExisting(bundleId);
    const m = await store.getManifest(bundleId);
    const imported = store.getImportedMeta(bundleId);
    return {
      bundleId,
      sizeBytes: fs.statSync(file).size,
      manifest: { ...m, sections: m.sections.map(compactSection) },
      ...(imported ? { imported } : {}),
    };
  }

  deleteBundle(bundleId: string): { bundleId: string; deleted: boolean } {
    return { bundleId, deleted: this.d.store().delete(bundleId) };
  }

  readChunk(bundleId: string, offset: number, length?: number): ChunkResult {
    return this.d.store().readChunk(bundleId, offset, length);
  }

  uploadChunk(input: UploadChunkInput): Promise<UploadChunkResult> {
    return this.d.store().uploadChunk(input);
  }

  importReceived(name: string): Promise<StoredImportResult> {
    return this.d.store().importReceived(name);
  }

  /** `lmb-…` → itself (validated); `received:<name>` → imported from the inbox, its new id. */
  async resolveBundleRef(ref: string): Promise<string> {
    if (typeof ref !== 'string' || !ref) throw new BundleServiceError('BAD_REQUEST', 'bundle is required (a bundleId or received:<name>)');
    if (ref.startsWith('received:')) return (await this.importReceived(ref.slice('received:'.length))).bundleId;
    if (!isBundleId(ref)) {
      throw new BundleServiceError('BUNDLE_ID_INVALID', `invalid bundle ${JSON.stringify(ref)} — expected lmb-<yyyymmdd>-<hhmmss>-<6 hex> or received:<name>`);
    }
    return ref;
  }

  async fetchFromPeer(fromNode: string, bundleId: string): Promise<import('./fetch').FetchResult> {
    const { fetchFromPeer } = require('./fetch') as typeof import('./fetch');
    return fetchFromPeer(fromNode, bundleId, { store: this.d.store(), ...(this.d.fetchTransport ? { transport: this.d.fetchTransport } : {}) });
  }

  // ─── plan / apply ─────────────────────────────────────────────────────

  plan(ref: string, opts: ImportOptions = {}): Promise<ImportResult> {
    return this.runImport(ref, opts, false);
  }

  /** Writes. Refuses CONFIRM_REQUIRED unless `confirm === true` — plan first, then apply. */
  apply(ref: string, opts: ApplyOptions = {}): Promise<ImportResult> {
    if (opts.confirm !== true) {
      return Promise.reject(new BundleServiceError('CONFIRM_REQUIRED', 'apply writes to this node — run plan first, then repeat with confirm:true'));
    }
    return this.runImport(ref, opts, true);
  }

  private async runImport(ref: string, opts: ImportOptions, apply: boolean): Promise<ImportResult> {
    const policy = opts.policy ?? 'merge';
    if (!isImportPolicy(policy)) {
      throw new BundleServiceError('BAD_REQUEST', `unknown policy ${JSON.stringify(policy)} — expected merge | add-missing | replace`);
    }
    const groups = parseGroups(opts.sections, SECTION_GROUPS);
    const dsFilter = asStringList(opts.datasets, 'datasets');
    const bundleId = await this.resolveBundleRef(ref);
    const store = this.d.store();
    const bundle = await store.read(bundleId); // full verify — BUNDLE_CORRUPT names the failed check
    const self = this.d.self();
    const registry = this.d.registry();
    const data = this.d.data();
    const roster = this.memoRoster();
    const owners = ownerProbe(this.roster(), roster);
    const configs = new Map(this.d.configProviders().map((p) => [p.id as string, p]));
    const files = new Map(this.d.filesProviders().map((p) => [p.id as string, p]));

    const sections: SectionPlan[] = [];
    const touched: string[] = [];
    const warnings: string[] = [];
    if (bundle.manifest.source?.nodeId && bundle.manifest.source.nodeId !== self.nodeId) {
      warnings.push(`source: exported on ${bundle.manifest.source.hostname || bundle.manifest.source.nodeId} (${bundle.manifest.source.nodeId}), not this node`);
    }
    if (groups.has('datasets') && bundle.sections.some((x) => x.kind === 'dataset') && dataServiceOff(data)) {
      warnings.push(DATA_SERVICE_OFF_WARNING);
    }

    for (const sec of bundle.sections) {
      const group: string = sec.kind === 'dataset' ? 'datasets' : sec.kind === 'config' ? 'config' : sec.id;
      if (!groups.has(group as SectionGroup)) continue;
      if (sec.kind === 'dataset') {
        if (dsFilter && !dsFilter.includes(sec.id)) continue;
        const p: DatasetSectionPlan = await importDatasetSection(sec, {
          data, registry, apply, policy,
          takeOwnership: opts.takeOwnership === true,
          force: opts.force === true,
          selfNode: self.nodeId,
          selfCluster: self.cluster,
          sourceCluster: bundle.manifest.source?.cluster,
          roster,
          promote: async (id, patch) => { await this.promote(id, patch); },
          onlineOwner: owners,
          now: this.d.now,
        });
        sections.push(p);
        // A section that stopped part-way still wrote rows: its caches must drop too.
        if (apply && (p.action === 'create' || p.action === 'takeover' || (p.applied && (p.applied.add || p.applied.update)))) {
          touched.push(sec.id);
        }
        continue;
      }
      const provider = sec.kind === 'config' ? configs.get(sec.id) : files.get(sec.id);
      if (!provider) {
        const p: SectionPlan = { kind: sec.kind, id: sec.id, counts: emptyCounts(), samples: {}, warnings: [`unknown section "${sec.id}" — this build has no provider for it; skipped`] };
        sections.push(p);
        continue;
      }
      try {
        const payload = sec.kind === 'config' ? sec.config?.data : sec.files;
        const p = sec.kind === 'config'
          ? await (apply ? (provider as ConfigProvider).apply(payload, policy) : (provider as ConfigProvider).plan(payload, policy))
          : await (apply ? (provider as FilesProvider).apply(payload as never, policy) : (provider as FilesProvider).plan(payload as never, policy));
        sections.push(p);
      } catch (e) {
        sections.push({
          kind: sec.kind, id: sec.id, title: provider.title, counts: emptyCounts(), samples: {}, warnings: [],
          refused: { code: bundleErrorCode(e) === 'INTERNAL' ? 'IMPORT_FAILED' : bundleErrorCode(e), reason: (e as Error)?.message || String(e) },
        });
      }
    }

    if (apply && touched.length) {
      try { this.d.invalidate(touched); } catch { /* a cache hook must never fail the apply */ }
    }

    const totals = emptyCounts();
    let applied: PlanCounts | undefined;
    for (const s of sections) {
      sumCounts(totals, s.counts);
      if (apply) sumCounts((applied ??= emptyCounts()), s.applied);
    }
    const m = bundle.manifest;
    return {
      bundleId,
      policy,
      dryRun: !apply,
      source: m.source,
      createdAt: m.createdAt,
      ...(m.note !== undefined ? { note: m.note } : {}),
      sections,
      totals,
      ...(apply ? { applied: applied ?? emptyCounts() } : {}),
      refused: sections.filter((s) => s.refused).length,
      warnings,
    };
  }

  // ─── takeover ─────────────────────────────────────────────────────────

  /** Promote + change-notify. Shared by takeover() and apply's takeOwnership path. */
  private async promote(id: string, patch: import('../dataset-registry').PromoteReplicaPatch = {}): Promise<DatasetDescriptor> {
    let promoted: DatasetDescriptor;
    try {
      promoted = this.d.registry().promoteReplica(id, patch);
    } catch (e) {
      throw new BundleServiceError(bundleErrorCode(e) === 'INTERNAL' ? 'TAKEOVER_FAILED' : bundleErrorCode(e), (e as Error).message);
    }
    // Same-cluster peers pull now; everyone else re-points on the next reconcile.
    try { this.d.notify(promoted, []); } catch { /* notify is best effort */ }
    return promoted;
  }

  /**
   * Guarded TAKEOVER (spec): refuse NOT_A_REPLICA; refuse ORIGIN_ONLINE while the origin is on
   * the roster; refuse ROSTER_UNAVAILABLE when the roster cannot be read unless `force` — force
   * covers exactly that case. Then promote the replica to owned (stamping `supersedes`) and fire
   * a change-notify.
   */
  async takeover(datasetId: string, opts: { force?: boolean } = {}): Promise<TakeoverResult> {
    if (typeof datasetId !== 'string' || !datasetId) throw new BundleServiceError('BAD_REQUEST', 'dataset is required');
    const d = this.d.registry().get(datasetId);
    if (!d) throw new BundleServiceError('NOT_FOUND', `dataset "${datasetId}" not found`);
    if (!d.origin) {
      throw new BundleServiceError('NOT_A_REPLICA', `dataset "${datasetId}" is not a replica — this node already owns it`);
    }
    const origin = d.origin;
    const host = origin.hostname ? `${origin.hostname} (${origin.machineId})` : origin.machineId;
    if (d.syncMode !== 'full') {
      throw new BundleServiceError('NOT_SUPPORTED',
        `"${datasetId}" is a ${d.syncMode ?? 'non-full'} replica — it caches only what was read and is not a copy of the dataset; restore from a bundle on the origin ${host}, or convert it to full sync first`);
    }
    const snap = await this.roster().snapshot();
    if (snap.available && snap.peers.has(origin.machineId)) {
      throw new BundleServiceError('ORIGIN_ONLINE',
        `the origin of "${datasetId}", ${host}, is online — write there; a takeover is only for an origin that is gone`,
        { machineId: origin.machineId, hostname: origin.hostname });
    }
    let forced = !snap.available;
    if (!snap.available && opts.force !== true) {
      throw new BundleServiceError('ROSTER_UNAVAILABLE',
        `cannot tell whether the origin ${host} is online: ${snap.reason}. Pass force:true only if you know it is gone`,
        { machineId: origin.machineId, hostname: origin.hostname });
    }
    // The recorded origin being gone is not enough: another node may ALREADY have taken it
    // over (or restored it) while this replica still points at the old origin.
    const owner = await ownerProbe(this.roster(), async () => snap)(datasetId, d.scope);
    if (owner.kind === 'owner') {
      throw new BundleServiceError('OWNER_ONLINE',
        `"${datasetId}" is already owned by ${owner.peer.hostname || owner.peer.node} (${owner.peer.node}), which is online — this replica has not re-pointed yet. Write there; a second owner would split the brain`,
        { machineId: owner.peer.node, hostname: owner.peer.hostname });
    }
    if (owner.kind === 'unknown' && snap.available) {
      if (opts.force !== true) {
        throw new BundleServiceError('ROSTER_UNAVAILABLE',
          `cannot tell whether another online node already owns "${datasetId}": ${owner.reason}. Pass force:true only if you know none does`,
          { machineId: origin.machineId, hostname: origin.hostname });
      }
      forced = true;
    }
    const promoted = await this.promote(datasetId);
    try { this.d.invalidate([datasetId]); } catch { /* a cache hook must never fail the takeover */ }
    let records = 0;
    let tombstones = 0;
    const r = await this.d.data().exportRaw(LOCAL, datasetId);
    if (r.ok) { records = r.value.length; tombstones = r.value.filter((x) => x.deleted === true).length; }
    return {
      dataset: datasetId,
      records,
      tombstones,
      superseded: { machineId: origin.machineId, hostname: origin.hostname },
      ownerNode: promoted.ownerNode,
      visibility: promoted.visibility,
      forced,
      note: `this node now owns "${datasetId}". If ${host} comes back, it demotes itself to a replica once nothing of its own would be stranded`,
    };
  }
}

// ─── singleton ──────────────────────────────────────────────────────────────

let instance: BundleService | null = null;

/** The shared service (lazy — constructing it loads nothing heavy). */
export function getBundleService(): BundleService {
  if (!instance) instance = new BundleService();
  return instance;
}

/** Tests only: swap the singleton (null resets to the default on next get). */
export function _setBundleServiceForTests(s: BundleService | null): void {
  instance = s;
}
