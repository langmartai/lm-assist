import { test } from 'node:test';
import assert from 'node:assert';
import { handleWorkflowList, handleWorkflowGet, handleWorkflowSet, handleWorkflowHistory, handleWorkflowRollback } from '../routes/core/mission.routes';
import type { WorkflowPort, WorkflowSnapshotPort, WorkflowSnapshot } from '../mission/workflow-store';
import type { WorkflowDoc } from '../mission/workflow-model';
import type { MissionActor } from '../mission/mission-model';

// reuse the fakes() pair from workflow-store.test — copied here (tests must be self-contained).
function fakes() {
  const docs = new Map<string, WorkflowDoc>();
  const snaps = new Map<string, WorkflowSnapshot>();
  const port: WorkflowPort = {
    isEnabled: () => true,
    get: async (id) => docs.get(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null,
    list: async () => [...docs.values()].map((d) => JSON.parse(JSON.stringify(d))),
    put: async (d) => { docs.set(d.id, JSON.parse(JSON.stringify(d))); },
  };
  const snap: WorkflowSnapshotPort = {
    isEnabled: () => true,
    put: async (s) => { snaps.set(s.id, s); },
    get: async (docId, rev) => snaps.get(`${docId}:${rev}`) ?? null,
    list: async (docId, opts) => [...snaps.values()].filter((s) => s.docId === docId && (opts.beforeRev == null || s.rev < opts.beforeRev)).sort((a, b) => b.rev - a.rev).slice(0, opts.limit ?? 50),
  };
  return { port, snap, docs, snaps };
}
const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 2 };

test('set/get/list roundtrip', async () => {
  const { port, snap } = fakes();
  const w = await handleWorkflowSet('a.b', { title: 'T', body: 'B', editPolicy: 'open' }, port, snap, user);
  assert.equal(w.success, true);
  const g = await handleWorkflowGet('a.b', port);
  assert.equal((g.data as any).doc.rev, 1);
  assert.ok((g.data as any).rendered.includes('B'));
  const l = await handleWorkflowList(port);
  assert.ok((l.data as any).workflows.some((d: any) => d.id === 'a.b'));
  assert.ok((l.data as any).defaults.includes('controller.pass'), 'unseeded defaults listed');
});

test('human-only doc rejects controller writes and controller editPolicy changes', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('h.doc', { title: 'T', body: 'B', editPolicy: 'human-only' }, port, snap, user);
  const denied = await handleWorkflowSet('h.doc', { title: 'T', body: 'B2', editPolicy: 'human-only' }, port, snap, ctrl);
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, 'FORBIDDEN');
  const flip = await handleWorkflowSet('o.doc', { title: 'T', body: 'B', editPolicy: 'human-only' }, port, snap, ctrl);
  assert.equal(flip.success, false, 'controller cannot set human-only on create either');
});

test('controller CAN edit an open doc', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('o.doc', { title: 'T', body: 'B', editPolicy: 'open' }, port, snap, user);
  const r = await handleWorkflowSet('o.doc', { title: 'T', body: 'B2', editPolicy: 'open' }, port, snap, ctrl);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.lastUpdatedBy.kind, 'controller');
});

test('history lists snapshot metadata without bodies; rollback restores', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('a.b', { title: 'T', body: 'B1', editPolicy: 'open' }, port, snap, user);
  await handleWorkflowSet('a.b', { title: 'T', body: 'B2', editPolicy: 'open' }, port, snap, user);
  const h = await handleWorkflowHistory('a.b', {}, snap);
  const rows = (h.data as any).snapshots;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rev, 2);
  assert.equal(rows[0].body, undefined);
  assert.equal(typeof rows[0].bodyBytes, 'number');
  const rb = await handleWorkflowRollback('a.b', { toRev: '1' }, port, snap, user); // string coercion!
  assert.equal(rb.success, true);
  assert.equal((rb.data as any).doc.body, 'B1');
});

test('invalid id/body surface structured errors', async () => {
  const { port, snap } = fakes();
  const bad = await handleWorkflowSet('BAD ID', { title: 't', body: 'b', editPolicy: 'open' }, port, snap, user);
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, 'INVALID_INPUT');
});
