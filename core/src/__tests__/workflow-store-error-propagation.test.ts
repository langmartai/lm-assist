/**
 * Workflow-registry writes must SURFACE data-service failures, not silently no-op.
 *
 * Regression tests for the live-observed defect (2026-07-15, node 117): the
 * `mission-workflows` dataset was a remote replica, dataService.put() returned
 * { ok:false, code:'READ_ONLY_REPLICA' } — and livePort()/liveSnapshotPort()
 * discarded the result, so POST /mission/workflows/:id fabricated success
 * (rev bump in the response, nothing persisted, empty history).
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dataService from '../data/data-service';
import { putWorkflow } from '../mission/workflow-store';
import { handleWorkflowSet, handleWorkflowRollback } from '../routes/core/mission.routes';
import type { MissionActor } from '../mission/mission-model';

afterEach(() => mock.restoreAll());

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
const DOC_DS = 'mission-workflows';
const SNAP_DS = 'mission-workflow-history';

const replicaRefusal = (ds: string) =>
  ({ ok: false as const, code: 'READ_ONLY_REPLICA', reason: `dataset "${ds}" is a remote replica (read-only)` });

/** Minimal fake DataService: in-memory records, per-dataset injectable put refusal. */
function stubSvc(opts: { enabled?: boolean; refusePut?: (dataset: string) => boolean } = {}) {
  const store = new Map<string, any>();
  const svc = {
    isEnabled: () => opts.enabled !== false,
    createDataset: async () => ({ ok: true }),
    get: async (_c: unknown, ds: string, id: string) => ({ ok: true, value: store.get(`${ds}/${id}`) ?? null }),
    query: async () => ({ ok: true, value: { records: [] } }),
    put: async (_c: unknown, ds: string, rec: { id: string }) => {
      if (opts.refusePut?.(ds)) return replicaRefusal(ds);
      store.set(`${ds}/${rec.id}`, rec);
      return { ok: true, value: { id: rec.id } };
    },
    del: async () => ({ ok: true, value: true }),
  };
  mock.method(dataService, 'getDataService', () => svc as any);
  return { svc, store };
}

const input = { id: 'case.test-probe', title: 't', body: 'b', editPolicy: 'open' as const };

test('putWorkflow rejects when the doc write is refused (READ_ONLY_REPLICA)', async () => {
  stubSvc({ refusePut: (ds) => ds === DOC_DS });
  await assert.rejects(
    putWorkflow(input, actor),
    (e: any) => e.code === 'READ_ONLY_REPLICA' && /replica/.test(e.message),
  );
});

test('putWorkflow rejects when the data service is disabled (no fake success)', async () => {
  stubSvc({ enabled: false });
  await assert.rejects(putWorkflow(input, actor), (e: any) => e.code === 'DATA_SERVICE_DISABLED');
});

test('putWorkflow surfaces a refused snapshot write (doc already persisted) with context', async () => {
  const { store } = stubSvc({ refusePut: (ds) => ds === SNAP_DS });
  await assert.rejects(
    putWorkflow(input, actor),
    (e: any) => e.code === 'READ_ONLY_REPLICA' && /snapshot/i.test(e.message),
  );
  // the doc write itself landed before the snapshot refusal
  assert.ok(store.get(`${DOC_DS}/${input.id}`), 'doc record should be persisted');
});

test('putWorkflow happy path persists doc AND snapshot', async () => {
  const { store } = stubSvc();
  const r = await putWorkflow(input, actor);
  assert.equal(r.changed, true);
  assert.equal(r.doc.rev, 1);
  assert.ok(store.get(`${DOC_DS}/${input.id}`));
  assert.ok(store.get(`${SNAP_DS}/${input.id}:1`));
});

test('handleWorkflowSet returns a clean error envelope on a refused write', async () => {
  stubSvc({ refusePut: (ds) => ds === DOC_DS });
  const r = await handleWorkflowSet(input.id, { title: 't', body: 'b' }, undefined, undefined, actor, undefined);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'READ_ONLY_REPLICA');
});

test('handleWorkflowRollback returns a clean error envelope (not an unhandled throw) on a refused write', async () => {
  const { store } = stubSvc({ refusePut: (ds) => ds === DOC_DS });
  store.set(`${SNAP_DS}/${input.id}:1`, {
    id: `${input.id}:1`,
    fields: { id: `${input.id}:1`, docId: input.id, rev: 1, at: 1, actor, title: 't', body: 'b', editPolicy: 'open' },
  });
  const r = await handleWorkflowRollback(input.id, { toRev: 1 }, undefined, undefined, actor, undefined);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'READ_ONLY_REPLICA');
});
