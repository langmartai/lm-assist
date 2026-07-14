/** Fleet-synced workflow-registry store (dataset `mission-workflows`, syncMode:'full', scope:'fleet').
 *  Snapshots (dataset `mission-workflow-history`) hold FULL bodies per rev — unlike mission-history's
 *  truncated diffs — because workflow docs are capped at 64KiB and rollback must reproduce them exactly. */
import { WorkflowDoc, WorkflowEditPolicy, WorkflowChange, validateWorkflowId, validateWorkflowBody, workflowChanged, renderWorkflowText } from './workflow-model';
import { DEFAULT_WORKFLOWS } from './workflow-defaults';
import type { MissionActor } from './mission-model';
import { getDataService } from '../data/data-service';
import { getProjectSettings } from '../project-settings';
import type { CallCtx } from '../data/data-service';
import type { DataRecord } from '../data/types';

const DATASET = 'mission-workflows';
const SNAP_DATASET = 'mission-workflow-history';
/** I5 — retention: keep only the most recent N snapshots per doc. Workflow docs can be edited
 *  frequently (controller self-edits + human edits), and each snapshot holds a FULL body (up to
 *  64KiB) rather than a diff — unbounded snapshot growth is a real storage/query-cost concern in
 *  a way mission-history's truncated diffs are not. 20 comfortably covers "recent rollback
 *  candidates" while bounding worst-case growth per doc. */
const SNAPSHOT_RETENTION = 20;

/** A durable snapshot of one workflow doc revision — the FULL title/body/editPolicy, not a diff. */
export interface WorkflowSnapshot {
  id: string;              // `${docId}:${rev}`
  docId: string;
  rev: number;
  at: number;
  actor: MissionActor;
  title: string;
  body: string;
  editPolicy: WorkflowEditPolicy;
}

/** The seam the store reads/writes through for workflow docs. Tests inject an in-memory fake. */
export interface WorkflowPort {
  isEnabled(): boolean;
  get(id: string): Promise<WorkflowDoc | null>;
  list(): Promise<WorkflowDoc[]>;
  put(d: WorkflowDoc): Promise<void>;
}

/** The seam for durable per-rev snapshots (rollback source of truth). */
export interface WorkflowSnapshotPort {
  isEnabled(): boolean;
  put(s: WorkflowSnapshot): Promise<void>;
  get(docId: string, rev: number): Promise<WorkflowSnapshot | null>;
  list(docId: string, opts: { limit?: number; beforeRev?: number }): Promise<WorkflowSnapshot[]>;
  /** I5 — delete one snapshot by its record id (`${docId}:${rev}`), for retention pruning.
   *  Optional: a port that doesn't implement it (e.g. an older in-memory test fake) simply
   *  never gets pruned — putWorkflow's pruning step is a no-op when this is absent. */
  del?(id: string): Promise<void>;
}

function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

function docToRecord(d: WorkflowDoc): DataRecord {
  const now = new Date().toISOString();
  return { id: d.id, version: 0, fields: { ...d } as Record<string, unknown>, createdAt: now, updatedAt: now };
}
function recordToDoc(fields: Record<string, unknown>): WorkflowDoc {
  return fields as unknown as WorkflowDoc;
}

function snapshotToRecord(s: WorkflowSnapshot): DataRecord {
  const now = new Date().toISOString();
  return { id: s.id, version: 0, fields: { ...s } as Record<string, unknown>, createdAt: now, updatedAt: now };
}
function recordToSnapshot(fields: Record<string, unknown>): WorkflowSnapshot {
  return fields as unknown as WorkflowSnapshot;
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: DATASET, backend: 'cache', title: 'Mission Workflows',
      visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  ensured = true;
}

/** The live adapter over getDataService(). dataServiceEnabled off => isEnabled() false => no-op/empty. */
function livePort(): WorkflowPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return null;
      await ensureDataset(svc);
      const r = await svc.get(systemCtx(), DATASET, id);
      return r.ok && r.value ? recordToDoc(r.value.fields) : null;
    },
    list: async () => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureDataset(svc);
      const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any);
      return r.ok ? r.value.records.map((rec) => recordToDoc(rec.fields)) : [];
    },
    put: async (d) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureDataset(svc);
      await svc.put(systemCtx(), DATASET, docToRecord(d));
    },
  };
}

let _default: WorkflowPort | null = null;
function defaultPort(): WorkflowPort { return _default ?? (_default = livePort()); }

let snapEnsured = false;
async function ensureSnapshotDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (snapEnsured) return;
  try {
    await svc.createDataset(systemCtx(), {
      id: SNAP_DATASET, backend: 'cache', title: 'Mission Workflow History',
      visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' },
    } as any);
  } catch { /* already exists — fine */ }
  snapEnsured = true;
}

function liveSnapshotPort(): WorkflowSnapshotPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    put: async (s) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureSnapshotDataset(svc);
      await svc.put(systemCtx(), SNAP_DATASET, snapshotToRecord(s));
    },
    get: async (docId, rev) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return null;
      await ensureSnapshotDataset(svc);
      const r = await svc.get(systemCtx(), SNAP_DATASET, `${docId}:${rev}`);
      return r.ok && r.value ? recordToSnapshot(r.value.fields) : null;
    },
    list: async (docId, opts) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      await ensureSnapshotDataset(svc);
      const filter: Array<{ field: string; op: string; value: unknown }> = [{ field: 'docId', op: 'eq', value: docId }];
      if (typeof opts.beforeRev === 'number') filter.push({ field: 'rev', op: 'lt', value: opts.beforeRev });
      const r = await svc.query(systemCtx(), SNAP_DATASET, { filter, sort: [{ field: 'rev', dir: 'desc' }], limit: opts.limit ?? 50 } as any);
      return r.ok ? r.value.records.map((rec) => recordToSnapshot(rec.fields)) : [];
    },
    del: async (id) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return;
      await ensureSnapshotDataset(svc);
      await svc.del(systemCtx(), SNAP_DATASET, id);
    },
  };
}

let _snapDefault: WorkflowSnapshotPort | null = null;
function defaultSnapshotPort(): WorkflowSnapshotPort { return _snapDefault ?? (_snapDefault = liveSnapshotPort()); }

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

export async function getWorkflow(id: string, port: WorkflowPort = defaultPort()): Promise<WorkflowDoc | null> {
  return port.get(id);
}

export async function listWorkflows(port: WorkflowPort = defaultPort()): Promise<WorkflowDoc[]> {
  return port.list();
}

export async function listWorkflowSnapshots(
  docId: string,
  opts: { limit?: number; beforeRev?: number } = {},
  snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<WorkflowSnapshot[]> {
  return snap.list(docId, opts);
}

export async function putWorkflow(
  input: { id: string; title: string; body: string; editPolicy: WorkflowEditPolicy },
  actor: MissionActor,
  port: WorkflowPort = defaultPort(),
  snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<{ doc: WorkflowDoc; changed: boolean }> {
  const vid = validateWorkflowId(input.id);
  if (!vid.ok) { const e = new Error(vid.message) as any; e.code = vid.code; throw e; }
  const vb = validateWorkflowBody(input.body);
  if (!vb.ok) { const e = new Error(vb.message) as any; e.code = vb.code; throw e; }
  const prev = await port.get(input.id);
  if (prev && !workflowChanged(prev, input)) return { doc: prev, changed: false };
  const now = Date.now();
  const rev = (prev?.rev ?? 0) + 1;
  const cap = getProjectSettings().missionHistoryInlineCap ?? 50;
  const change: WorkflowChange = {
    rev, at: now, actor,
    changes: {
      ...(prev?.title !== input.title ? { title: { from: prev?.title ?? null, to: input.title } } : {}),
      ...(prev?.body !== input.body ? { body: { from: `len:${prev?.body.length ?? 0}`, to: `len:${input.body.length}` } } : {}),
      ...(prev?.editPolicy !== input.editPolicy ? { editPolicy: { from: prev?.editPolicy ?? null, to: input.editPolicy } } : {}),
    },
  };
  const doc: WorkflowDoc = {
    id: input.id, title: input.title, body: input.body, editPolicy: input.editPolicy,
    rev, history: [...(prev?.history ?? []), change].slice(-cap),
    createdBy: prev?.createdBy ?? actor, lastUpdatedBy: actor,
    createdAt: prev?.createdAt ?? now, updatedAt: now,
  };
  await port.put(doc);
  try {
    await snap.put({ id: `${doc.id}:${rev}`, docId: doc.id, rev, at: now, actor, title: doc.title, body: doc.body, editPolicy: doc.editPolicy });
  } catch { /* best-effort durable snapshot */ }
  // I5 — retention: prune snapshots beyond the most recent SNAPSHOT_RETENTION per doc. Best-effort
  // and entirely optional (snap.del may be absent on an older/test port) — must never throw out of
  // putWorkflow, since a pruning hiccup must not block the actual edit that already succeeded above.
  if (snap.del) {
    try {
      const old = await snap.list(doc.id, { limit: 200 });
      const toPrune = old.slice(SNAPSHOT_RETENTION);
      for (const s of toPrune) await snap.del!(s.id);
    } catch { /* best-effort — never let pruning fail the edit */ }
  }
  return { doc, changed: true };
}

export async function rollbackWorkflow(
  id: string, toRev: number, actor: MissionActor,
  port: WorkflowPort = defaultPort(), snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<{ doc: WorkflowDoc } | { error: { code: string; message: string } }> {
  const target = await snap.get(id, toRev);
  if (!target) return { error: { code: 'NOT_FOUND', message: `no snapshot ${id}:${toRev}` } };
  const { doc } = await putWorkflow({ id, title: target.title, body: target.body, editPolicy: target.editPolicy }, actor, port, snap);
  return { doc };
}

export async function seedDefaultWorkflows(
  port: WorkflowPort = defaultPort(), snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<number> {
  if (!port.isEnabled()) return 0;
  let n = 0;
  const seedActor: MissionActor = { kind: 'user', channel: 'api', label: 'system-seed', at: Date.now() };
  for (const [id, d] of Object.entries(DEFAULT_WORKFLOWS)) {
    const existing = await port.get(id).catch(() => null);
    if (existing) continue;
    try { await putWorkflow({ id, ...d }, seedActor, port, snap); n++; } catch { /* per-doc best-effort */ }
  }
  return n;
}

export async function renderWorkflow(id: string, port: WorkflowPort = defaultPort()): Promise<string> {
  let body: string | null = null;
  try { body = (await port.get(id))?.body ?? null; } catch { body = null; }
  if (body == null) body = DEFAULT_WORKFLOWS[id]?.body ?? null;
  if (body == null) throw new Error(`unknown workflow "${id}" (no stored doc, no default)`);
  return renderWorkflowText(body);
}

export async function getWorkflowRaw(id: string, port: WorkflowPort = defaultPort()): Promise<{ doc: WorkflowDoc | null; defaultBody: string | null; rendered: string }> {
  let doc: WorkflowDoc | null = null;
  try { doc = await port.get(id); } catch { doc = null; }
  const defaultBody = DEFAULT_WORKFLOWS[id]?.body ?? null;
  const body = doc?.body ?? defaultBody;
  if (body == null) { const e = new Error(`unknown workflow "${id}"`) as any; e.code = 'NOT_FOUND'; throw e; }
  return { doc, defaultBody, rendered: renderWorkflowText(body) };
}
