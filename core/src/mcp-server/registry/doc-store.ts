/** Generic fleet-synced overlay-doc store factory (assist-content design §2a).
 *
 *  Extracted verbatim from the MCP tool-registry store so a second registry (assist
 *  content) does not fork a third copy of the pattern; `store.ts` (tools) and
 *  `content-store.ts` are thin instantiations. Carries the arc's hard-won behaviors:
 *  - writes NEVER silently no-op (coded throws on refusal/disabled);
 *  - READS NEVER CREATE THE DATASET (a read-side create on a fresh node would claim
 *    local ownership before the fleet replica descriptor syncs in — permanent split);
 *  - per-name in-process write locks (writes are origin-anchored, so one process sees
 *    all of them — enough to stop two writers both minting rev N+1);
 *  - inline FULL-STATE history capped per spec, rollback restores as a NEW rev. */
import {
  type OverlayChange, type OverlayDoc, type OverlayDocPort, type OverlayStoreSpec,
  overlayStateChanged,
} from './doc-model';
import type { MissionActor } from '../../mission/mission-model';
import { getDataService } from '../../data/data-service';
import type { CallCtx } from '../../data/data-service';
import type { DataRecord } from '../../data/types';

function systemCtx(): CallCtx { return { principal: { type: 'local' } }; }

function throwCoded(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
}

export interface OverlayDocStore<S extends Record<string, unknown>> {
  get(name: string, port?: OverlayDocPort<S>): Promise<OverlayDoc<S> | null>;
  list(port?: OverlayDocPort<S>): Promise<OverlayDoc<S>[]>;
  put(input: { name: string } & Partial<S>, actor: MissionActor, port?: OverlayDocPort<S>): Promise<{ doc: OverlayDoc<S>; changed: boolean }>;
  rollback(name: string, toRev: number, actor: MissionActor, port?: OverlayDocPort<S>): Promise<{ doc: OverlayDoc<S> } | { error: { code: string; message: string } }>;
  /** The live dataset-backed port (exposed so routes can pass it explicitly if needed). */
  livePort(): OverlayDocPort<S>;
}

export function createOverlayDocStore<S extends Record<string, unknown>>(spec: OverlayStoreSpec<S>): OverlayDocStore<S> {
  const throwDisabled = (what: string): never =>
    throwCoded('DATA_SERVICE_DISABLED', `${what}: data service is disabled (dataServiceEnabled) — registry writes cannot persist`);
  const throwWriteRefused = (what: string, r: { code?: string; reason?: string }): never =>
    throwCoded(r.code ?? 'DATA_WRITE_FAILED', `${what}: ${r.reason ?? r.code ?? 'data-service write failed'}`);

  function docToRecord(d: OverlayDoc<S>): DataRecord {
    const now = new Date().toISOString();
    return { id: d.name, version: 0, fields: { ...d } as Record<string, unknown>, createdAt: now, updatedAt: now };
  }
  function recordToDoc(fields: Record<string, unknown>): OverlayDoc<S> {
    const f = fields as unknown as OverlayDoc<S>;
    // Records can be hand-authored around the store (data_put, foreign builds) —
    // normalize the one field whose absence breaks readers (rollback's history scan).
    return Array.isArray(f.history) ? f : { ...f, history: [] };
  }

  let ensured = false;
  async function ensureDataset(svc: ReturnType<typeof getDataService>): Promise<void> {
    if (ensured) return;
    const r = await svc.createDataset(systemCtx(), {
      id: spec.dataset, backend: 'cache', title: spec.datasetTitle,
      visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' },
    } as any).catch(() => ({ ok: false as const, reason: 'createDataset threw' }));
    // Created (or already there) ⇒ done. Any other refusal is treated as transient:
    // the flag stays down so the NEXT write retries instead of failing forever.
    ensured = (r as { ok?: boolean }).ok === true || /exist/i.test(String((r as { reason?: string }).reason ?? ''));
  }

  /** The live adapter over getDataService(). dataServiceEnabled off => isEnabled()
   *  false => no-op reads / coded-throw writes. Creation happens on the WRITE path
   *  only: the first write establishes the origin, exactly like the workflow registry.
   *  (Hot-path construction avoidance lives in the PROVIDERS — overlay-live /
   *  content-live gate on peekDataService() — not here: the store is the explicit
   *  management surface, and its tests mock getDataService directly.) */
  function makeLivePort(): OverlayDocPort<S> {
    return {
      isEnabled: () => getDataService().isEnabled(),
      get: async (name) => {
        const svc = getDataService();
        if (!svc.isEnabled()) return null;
        const r = await svc.get(systemCtx(), spec.dataset, name);
        return r.ok && r.value ? recordToDoc(r.value.fields) : null;
      },
      list: async () => {
        const svc = getDataService();
        if (!svc.isEnabled()) return [];
        const r = await svc.query(systemCtx(), spec.dataset, { limit: 10000 } as any);
        return r.ok ? r.value.records.map((rec) => recordToDoc(rec.fields)) : [];
      },
      put: async (d) => {
        const svc = getDataService();
        if (!svc.isEnabled()) throwDisabled(`${spec.label} doc write "${d.name}"`);
        await ensureDataset(svc);
        const r = await svc.put(systemCtx(), spec.dataset, docToRecord(d));
        if (!r.ok) throwWriteRefused(`${spec.label} doc write "${d.name}" refused`, r);
      },
    };
  }

  let _default: OverlayDocPort<S> | null = null;
  const defaultPort = (): OverlayDocPort<S> => _default ?? (_default = makeLivePort());

  /** Serialize read-modify-write per doc name. */
  const writeLocks = new Map<string, Promise<unknown>>();
  function withNameLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeLocks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    writeLocks.set(name, tail);
    void tail.finally(() => { if (writeLocks.get(name) === tail) writeLocks.delete(name); });
    return run;
  }

  async function put(
    input: { name: string } & Partial<S>,
    actor: MissionActor,
    port: OverlayDocPort<S> = defaultPort(),
  ): Promise<{ doc: OverlayDoc<S>; changed: boolean }> {
    const vn = spec.validateName(input.name);
    if (!vn.ok) throwCoded(vn.code, vn.message);
    for (const f of spec.fields) {
      const provided = (input as Record<string, unknown>)[f.key];
      if (provided !== undefined) {
        const vf = f.validate(provided);
        if (!vf.ok) throwCoded(vf.code, vf.message);
      }
    }
    if (!port.isEnabled()) throwDisabled(`${spec.label} doc write "${input.name}"`);
    return withNameLock(input.name, async () => {
      const prev = await port.get(input.name);
      // Merge semantics: an omitted field keeps its current value (new docs start from
      // the spec defaults = "pure default").
      const next = {} as S;
      for (const f of spec.fields) {
        const provided = (input as Record<string, unknown>)[f.key];
        (next as Record<string, unknown>)[f.key] =
          provided !== undefined ? provided : (prev ? (prev as Record<string, unknown>)[f.key] : f.defaultValue);
      }
      if (spec.refuseWrite) {
        const rw = spec.refuseWrite(input.name, next);
        if (!rw.ok) throwCoded(rw.code, rw.message);
      }
      if (prev && !overlayStateChanged(spec.fields, prev, next)) return { doc: prev, changed: false };
      const now = Date.now();
      const rev = (prev?.rev ?? 0) + 1;
      const summarize = (f: (typeof spec.fields)[number], v: unknown): unknown =>
        f.summarize ? f.summarize(v as never) : v;
      const change: OverlayChange<S> = {
        rev, at: now, actor,
        state: { ...next },
        changes: Object.fromEntries(
          spec.fields
            .filter((f) => (prev ? (prev as Record<string, unknown>)[f.key] : f.defaultValue) !== next[f.key])
            .map((f) => [f.key, {
              from: summarize(f, prev ? (prev as Record<string, unknown>)[f.key] : f.defaultValue),
              to: summarize(f, next[f.key]),
            }]),
        ),
      };
      const doc: OverlayDoc<S> = {
        ...(next as S),
        name: input.name,
        rev,
        history: [...(prev?.history ?? []), change].slice(-spec.historyCap),
        createdBy: prev?.createdBy ?? actor,
        lastUpdatedBy: actor,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      } as OverlayDoc<S>;
      await port.put(doc);
      return { doc, changed: true };
    });
  }

  async function rollback(
    name: string, toRev: number, actor: MissionActor,
    port: OverlayDocPort<S> = defaultPort(),
  ): Promise<{ doc: OverlayDoc<S> } | { error: { code: string; message: string } }> {
    const doc = await port.get(name);
    const target = (doc?.history ?? []).find((h) => h.rev === toRev);
    if (!target) {
      return { error: { code: 'NOT_FOUND', message: `no history entry ${name}:${toRev} (inline history keeps the last ${spec.historyCap} revs)` } };
    }
    const { doc: next } = await put({ name, ...(target.state as Partial<S>) } as { name: string } & Partial<S>, actor, port);
    return { doc: next };
  }

  return {
    get: (name, port = defaultPort()) => port.get(name),
    list: (port = defaultPort()) => port.list(),
    put,
    rollback,
    livePort: defaultPort,
  };
}
