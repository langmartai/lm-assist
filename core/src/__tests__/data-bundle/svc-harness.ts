// core/src/__tests__/data-bundle/svc-harness.ts
// Shared fixture for the svc-* bundle-service suites (not a suite itself). Importing it FIRST
// points HOME and LM_ASSIST_DATA_DIR at fresh temp dirs before any lm-assist module loads, so
// nothing here can reach the real ~/.lm-assist or ~/.claude. Each "node" is an isolated
// DatasetRegistry + CacheBackend + DataService; the roster, config/files providers, self and
// notify are injected fakes.
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

if (!process.env.__SVC_HARNESS_ENV) {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-home-'));
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-data-'));
  process.env.__SVC_HARNESS_ENV = '1';
}

import { DataService } from '../../data/data-service';
import { DatasetRegistry } from '../../data/dataset-registry';
import { BackendRegistry } from '../../data/backend-registry';
import { CacheBackend } from '../../data/backends/cache-backend';
import { AccessManager } from '../../data/access-manager';
import { KeyStore } from '../../data/key-store';
import { thisNodeId } from '../../data/paths';
import { BundleStore } from '../../data/bundle/store';
import { BundleService, type BundleServiceDeps } from '../../data/bundle/service';
import type { PeerRoster, RosterSnapshot } from '../../data/bundle/roster';
import type { BundleEntry, BundleSource } from '../../data/bundle/format';
import type { DataRecord, DatasetDescriptor, ManifestEntry, NodeInfo, NodeOrigin, SyncStatus } from '../../data/types';

export const tmp = (p = 'svc-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const SELF = thisNodeId();
export const LOCAL = { principal: { type: 'local' as const } };

/** A roster fake: set `.state` to 'online' peers, or make it unavailable. */
export class FakeRoster implements PeerRoster {
  peers: NodeInfo[] = [];
  unavailable: string | null = null;
  calls = 0;
  async snapshot(): Promise<RosterSnapshot> {
    this.calls++;
    const fetchedAt = new Date().toISOString();
    if (this.unavailable) return { available: false, reason: this.unavailable, fetchedAt };
    return { available: true, peers: new Map(this.peers.map((p) => [p.node, p])), fetchedAt };
  }
  online(...nodes: string[]): this { this.peers = nodes.map((n) => ({ node: n, hostname: `host-${n}`, platform: 'linux' })); return this; }
  /** Per-node sync manifests (the "does another online node already OWN it" probe). */
  manifests: Record<string, ManifestEntry[] | Error> = {};
  async manifest(node: string): Promise<ManifestEntry[]> {
    const m = this.manifests[node];
    if (m instanceof Error) throw m;
    return m ?? [];
  }
}

export interface TestNode {
  svc: BundleService;
  data: DataService;
  datasets: DatasetRegistry;
  backend: CacheBackend;
  store: BundleStore;
  roster: FakeRoster;
  root: string;
  notes: Array<{ id: string; ids: string[] }>;
  invalidated: string[][];
}

/** One isolated node. `store` may be shared between two nodes to hand a bundle across. */
export function makeNode(opts: { store?: BundleStore; cluster?: string | null; deps?: Partial<BundleServiceDeps>; now?: () => number } = {}): TestNode {
  const root = tmp('svc-root-');
  const datasets = new DatasetRegistry(path.join(root, 'datasets.json'));
  const keys = new KeyStore(tmp('svc-keys-'));
  const backend = new CacheBackend(path.join(root, 'cache'));
  const backends = new BackendRegistry();
  backends.register(backend);
  const data = new DataService({ datasets, backends, manager: new AccessManager({ datasets, keys, nodeId: SELF }) });
  (data as any).enabledOverride = true;
  const store = opts.store ?? new BundleStore({ dir: path.join(tmp('svc-store-'), 'bundles'), receivedDir: tmp('svc-recv-'), retention: 50, freeBytes: () => 1e15 });
  const roster = new FakeRoster();
  const notes: Array<{ id: string; ids: string[] }> = [];
  const invalidated: string[][] = [];
  const status: SyncStatus = { lastRun: '2026-09-23T00:00:00.000Z', peersChecked: 2, datasetsReplicated: 3, recordsApplied: 0, recordsSkipped: 0, errors: ['pull x/y: boom'] };
  const svc = new BundleService({
    data: () => data,
    registry: () => datasets,
    store: () => store,
    roster,
    configProviders: () => [],
    filesProviders: () => [],
    self: () => ({ nodeId: SELF, hostname: 'self-host', platform: 'linux', version: '0.0.0-test', mode: 'dev', cluster: opts.cluster === undefined ? 'alpha' : opts.cluster }),
    dataRoot: () => root,
    syncStatus: () => status,
    notify: (d, ids) => { notes.push({ id: d.id, ids }); },
    invalidate: (ids) => { invalidated.push(ids); },
    ...(opts.now ? { now: opts.now } : {}),
    ...opts.deps,
  });
  return { svc, data, datasets, backend, store, roster, root, notes, invalidated };
}

export function rec(id: string, version: number, fields: Record<string, unknown>, extra: Partial<DataRecord> = {}): DataRecord {
  const day = String(Math.min(28, Math.max(1, version))).padStart(2, '0');
  return { id, version, fields, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-${day}T00:00:00.000Z`, ...extra };
}

/** Create an OWNED dataset and write records verbatim (version/timestamps/tombstones kept). */
export async function ownedDataset(n: TestNode, id: string, records: DataRecord[], over: Partial<DatasetDescriptor> = {}): Promise<void> {
  n.datasets.create({
    id, backend: 'cache', title: over.title ?? id, visibility: over.visibility ?? 'cross-node-readable',
    syncMode: over.syncMode ?? 'full', scope: over.scope ?? 'fleet', config: { kind: 'cache' },
    ...(over.system ? { system: true } : {}),
  });
  for (const r of records) await n.backend.put(id, r);
}

/** A replica descriptor (as the sync engine would write it) plus its records. */
export async function replicaDataset(n: TestNode, id: string, origin: NodeOrigin, records: DataRecord[], scope: 'fleet' | 'cluster' = 'fleet'): Promise<void> {
  n.datasets.upsertReplica({ id, backend: 'cache', ownerNode: origin.machineId, syncMode: 'full', scope, config: { kind: 'cache' }, origin });
  for (const r of records) await n.backend.put(id, { ...r, origin });
}

export function descriptor(id: string, over: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    id, backend: 'cache', title: id, ownerNode: SELF, visibility: 'cross-node-readable',
    syncMode: 'full', scope: 'fleet', config: { kind: 'cache' }, acl: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

/** Write a hand-made bundle into `store` (for ownership rows the exporter would not produce). */
export async function craftBundle(
  store: BundleStore,
  datasets: Array<{ descriptor: DatasetDescriptor; records: DataRecord[]; replicaOf?: NodeOrigin }>,
  source: Partial<BundleSource> = {},
): Promise<string> {
  const entries: BundleEntry[] = [];
  for (const d of datasets) {
    const line: BundleEntry = { t: 'dataset', id: d.descriptor.id, descriptor: d.descriptor };
    if (d.replicaOf) line.replicaOf = d.replicaOf;
    entries.push(line);
    for (const r of d.records) entries.push({ t: 'record', ds: d.descriptor.id, r });
  }
  const res = await store.writeBundle({
    source: { nodeId: 'gw-src', hostname: 'src-host', platform: 'linux', lmAssistVersion: '0.0.0-test', mode: 'dev', cluster: 'alpha', ...source },
    sections: datasets.map((d) => ({ kind: 'dataset' as const, id: d.descriptor.id, title: d.descriptor.id })),
  }, entries);
  return res.bundleId;
}

export async function all(n: TestNode, id: string): Promise<Map<string, DataRecord>> {
  const r = await n.data.exportRaw(LOCAL, id);
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return new Map(r.value.map((x) => [x.id, x]));
}

export async function rejectsCode(p: Promise<unknown>, code: string): Promise<Error & { code: string }> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  if (!caught) throw new Error(`expected a ${code} rejection, got success`);
  const c = (caught as { code?: string }).code;
  if (c !== code) throw new Error(`expected ${code}, got ${c}: ${(caught as Error).message}`);
  return caught as Error & { code: string };
}
