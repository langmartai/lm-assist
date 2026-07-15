/** Fleet-synced MCP tool-registry store (dataset `mcp-tool-registry`, syncMode:'full', scope:'fleet').
 *  Mirrors mission/workflow-store.ts, minus the snapshot dataset: registry docs are tiny
 *  (override ≤ 2 KiB + a bool), so each inline history entry carries the FULL post-change
 *  state and rollback restores straight from it (spec §4.1/§4.2). */
import {
  ToolRegistryDoc, ToolRegistryChange, PROTECTED_TOOLS, TOOL_REGISTRY_HISTORY_CAP,
  validateToolName, validateDescriptionOverride, toolRegistryChanged,
} from './model';
import type { MissionActor } from '../../mission/mission-model';
import { getDataService } from '../../data/data-service';
import type { CallCtx } from '../../data/data-service';
import type { DataRecord } from '../../data/types';

/** Dataset id shared with the write-side origin-anchor in mcp-tools.routes.ts. */
export const TOOL_REGISTRY_DATASET = 'mcp-tool-registry';
const DATASET = TOOL_REGISTRY_DATASET;

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export interface ToolRegistryPort {
  isEnabled(): boolean;
  get(name: string): Promise<ToolRegistryDoc | null>;
  list(): Promise<ToolRegistryDoc[]>;
  put(d: ToolRegistryDoc): Promise<void>;
}

function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

/** Coded throw for a write the data service refused — registry writes must NEVER
 *  silently no-op (the live-observed fake-success defect the workflow arc fixed). */
function throwWriteRefused(what: string, r: { code?: string; reason?: string }): never {
  const e = new Error(`${what}: ${r.reason ?? r.code ?? 'data-service write failed'}`) as Error & { code: string };
  e.code = r.code ?? 'DATA_WRITE_FAILED';
  throw e;
}
function throwDisabled(what: string): never {
  const e = new Error(`${what}: data service is disabled (dataServiceEnabled) — registry writes cannot persist`) as Error & { code: string };
  e.code = 'DATA_SERVICE_DISABLED';
  throw e;
}
function throwCoded(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
}

function docToRecord(d: ToolRegistryDoc): DataRecord {
  const now = new Date().toISOString();
  return { id: d.name, version: 0, fields: { ...d } as Record<string, unknown>, createdAt: now, updatedAt: now };
}
function recordToDoc(fields: Record<string, unknown>): ToolRegistryDoc {
  const f = fields as unknown as ToolRegistryDoc;
  // Records can be hand-authored around the store (data_put, foreign builds) —
  // normalize the one field whose absence breaks readers (rollback's history scan).
  return Array.isArray(f.history) ? f : { ...f, history: [] };
}

let ensured = false;
async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
  if (ensured) return;
  const r = await svc.createDataset(systemCtx(), {
    id: DATASET, backend: 'cache', title: 'MCP Tool Registry',
    visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' },
  } as any).catch(() => ({ ok: false as const, reason: 'createDataset threw' }));
  // Created (or already there) ⇒ done. Any other refusal is treated as transient:
  // the flag stays down so the NEXT write retries instead of failing forever.
  ensured = (r as { ok?: boolean }).ok === true || /exist/i.test(String((r as { reason?: string }).reason ?? ''));
}

/** The live adapter over getDataService(). dataServiceEnabled off => isEnabled() false => no-op/empty.
 *
 *  READS NEVER CREATE THE DATASET. The overlay provider lists docs within seconds of
 *  boot on every node — a read-side create would claim LOCAL ownership of the fleet
 *  dataset before the replica descriptor syncs in, and upsertReplica refuses to
 *  convert a locally-owned dataset to a replica (permanent split from the fleet
 *  registry). Creation happens on the WRITE path only: the first write establishes
 *  the origin, exactly like the workflow registry. */
function livePort(): ToolRegistryPort {
  return {
    isEnabled: () => getDataService().isEnabled(),
    get: async (name) => {
      const svc = getDataService();
      if (!svc.isEnabled()) return null;
      const r = await svc.get(systemCtx(), DATASET, name);
      return r.ok && r.value ? recordToDoc(r.value.fields) : null;
    },
    list: async () => {
      const svc = getDataService();
      if (!svc.isEnabled()) return [];
      const r = await svc.query(systemCtx(), DATASET, { limit: 10000 } as any);
      return r.ok ? r.value.records.map((rec) => recordToDoc(rec.fields)) : [];
    },
    put: async (d) => {
      const svc = getDataService();
      if (!svc.isEnabled()) throwDisabled(`tool-registry doc write "${d.name}"`);
      await ensureDataset(svc);
      const r = await svc.put(systemCtx(), DATASET, docToRecord(d));
      if (!r.ok) throwWriteRefused(`tool-registry doc write "${d.name}" refused`, r);
    },
  };
}

let _default: ToolRegistryPort | null = null;
function defaultPort(): ToolRegistryPort { return _default ?? (_default = livePort()); }

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

export async function getToolDoc(name: string, port: ToolRegistryPort = defaultPort()): Promise<ToolRegistryDoc | null> {
  return port.get(name);
}

export async function listToolDocs(port: ToolRegistryPort = defaultPort()): Promise<ToolRegistryDoc[]> {
  return port.list();
}

/** len-summarize an override for the `changes` diff (full text lives in `state`). */
function lenOf(v: string | null | undefined): string {
  return `len:${v == null ? 0 : v.length}`;
}

/** Serialize read-modify-write per tool name. Writes are origin-anchored, so this
 *  one process sees ALL of them — an in-process chain is sufficient to stop two
 *  concurrent writers from both minting rev N+1 and silently dropping one edit. */
const writeLocks = new Map<string, Promise<unknown>>();
function withNameLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  writeLocks.set(name, tail);
  void tail.finally(() => { if (writeLocks.get(name) === tail) writeLocks.delete(name); });
  return run;
}

export async function putToolDoc(
  input: { name: string; descriptionOverride?: string | null; enabled?: boolean },
  actor: MissionActor,
  port: ToolRegistryPort = defaultPort(),
): Promise<{ doc: ToolRegistryDoc; changed: boolean }> {
  const vn = validateToolName(input.name);
  if (!vn.ok) throwCoded(vn.code, vn.message);
  if (input.descriptionOverride !== undefined) {
    const vo = validateDescriptionOverride(input.descriptionOverride);
    if (!vo.ok) throwCoded(vo.code, vo.message);
  }
  if (!port.isEnabled()) throwDisabled(`tool-registry doc write "${input.name}"`);
  return withNameLock(input.name, async () => {
    const prev = await port.get(input.name);
    // Merge semantics: an omitted field keeps its current value (new docs default to
    // "pure default": no override, enabled).
    const next = {
      descriptionOverride: input.descriptionOverride !== undefined ? input.descriptionOverride : (prev?.descriptionOverride ?? null),
      enabled: input.enabled !== undefined ? input.enabled : (prev?.enabled ?? true),
    };
    if (next.enabled === false && PROTECTED_TOOLS.has(input.name)) {
      throwCoded('PROTECTED_TOOL', `"${input.name}" is protected and cannot be disabled (orientation surface — see the design brief)`);
    }
    if (prev && !toolRegistryChanged(prev, next)) return { doc: prev, changed: false };
    const now = Date.now();
    const rev = (prev?.rev ?? 0) + 1;
    const change: ToolRegistryChange = {
      rev, at: now, actor,
      state: { ...next },
      changes: {
        ...(prev?.descriptionOverride !== next.descriptionOverride
          ? { descriptionOverride: { from: lenOf(prev?.descriptionOverride), to: lenOf(next.descriptionOverride) } } : {}),
        ...((prev?.enabled ?? true) !== next.enabled ? { enabled: { from: prev?.enabled ?? true, to: next.enabled } } : {}),
      },
    };
    const doc: ToolRegistryDoc = {
      name: input.name, descriptionOverride: next.descriptionOverride, enabled: next.enabled,
      rev, history: [...(prev?.history ?? []), change].slice(-TOOL_REGISTRY_HISTORY_CAP),
      createdBy: prev?.createdBy ?? actor, lastUpdatedBy: actor,
      createdAt: prev?.createdAt ?? now, updatedAt: now,
    };
    await port.put(doc);
    return { doc, changed: true };
  });
}

/** Restore the full state of history entry `toRev` as a NEW revision. */
export async function rollbackToolDoc(
  name: string, toRev: number, actor: MissionActor,
  port: ToolRegistryPort = defaultPort(),
): Promise<{ doc: ToolRegistryDoc } | { error: { code: string; message: string } }> {
  const doc = await port.get(name);
  const target = (doc?.history ?? []).find((h) => h.rev === toRev);
  if (!target) return { error: { code: 'NOT_FOUND', message: `no history entry ${name}:${toRev} (inline history keeps the last ${TOOL_REGISTRY_HISTORY_CAP} revs)` } };
  const { doc: next } = await putToolDoc(
    { name, descriptionOverride: target.state.descriptionOverride, enabled: target.state.enabled },
    actor, port,
  );
  return { doc: next };
}
