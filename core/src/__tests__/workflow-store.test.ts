import { test } from 'node:test';
import assert from 'node:assert';
import { putWorkflow, rollbackWorkflow, seedDefaultWorkflows, renderWorkflow, getWorkflowRaw,
  type WorkflowPort, type WorkflowSnapshotPort, type WorkflowSnapshot } from '../mission/workflow-store';
import { WORKFLOW_INVARIANT_PREAMBLE, type WorkflowDoc } from '../mission/workflow-model';
import { DEFAULT_WORKFLOWS } from '../mission/workflow-defaults';
import type { MissionActor } from '../mission/mission-model';

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

test('putWorkflow creates rev1 with snapshot, bumps on change, no-ops on identical', async () => {
  const { port, snap, snaps } = fakes();
  const r1 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  assert.equal(r1.doc.rev, 1); assert.equal(r1.changed, true);
  assert.ok(snaps.get('x.y:1'), 'snapshot spilled');
  const r2 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  assert.equal(r2.changed, false); assert.equal(r2.doc.rev, 1);
  const r3 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B2', editPolicy: 'open' }, ctrl, port, snap);
  assert.equal(r3.doc.rev, 2); assert.equal(r3.doc.lastUpdatedBy.kind, 'controller');
  assert.equal(snaps.get('x.y:2')!.body, 'B2');
});

test('putWorkflow validates id and body', async () => {
  const { port, snap } = fakes();
  await assert.rejects(() => putWorkflow({ id: 'BAD ID', title: 't', body: 'b', editPolicy: 'open' }, user, port, snap));
  await assert.rejects(() => putWorkflow({ id: 'a.b', title: 't', body: '', editPolicy: 'open' }, user, port, snap));
});

test('rollback writes the old body as a NEW rev', async () => {
  const { port, snap } = fakes();
  await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  await putWorkflow({ id: 'x.y', title: 'T', body: 'B2', editPolicy: 'open' }, user, port, snap);
  const r = await rollbackWorkflow('x.y', 1, user, port, snap);
  assert.ok(!('error' in r));
  assert.equal((r as any).doc.rev, 3);
  assert.equal((r as any).doc.body, 'B1');
  const missing = await rollbackWorkflow('x.y', 99, user, port, snap);
  assert.equal((missing as any).error.code, 'NOT_FOUND');
});

test('seed inserts only missing docs and is idempotent', async () => {
  const { port, snap } = fakes();
  const n1 = await seedDefaultWorkflows(port, snap);
  assert.equal(n1, Object.keys(DEFAULT_WORKFLOWS).length);
  const n2 = await seedDefaultWorkflows(port, snap);
  assert.equal(n2, 0);
});

test('renderWorkflow: store body wins, default falls back, always preambled', async () => {
  const { port, snap } = fakes();
  const viaDefault = await renderWorkflow('controller.pass', port);
  assert.ok(viaDefault.startsWith(WORKFLOW_INVARIANT_PREAMBLE));
  assert.ok(viaDefault.includes('Run a controller pass now.'));
  await putWorkflow({ id: 'controller.pass', title: 'T', body: 'CUSTOM', editPolicy: 'open' }, user, port, snap);
  const viaStore = await renderWorkflow('controller.pass', port);
  assert.ok(viaStore.endsWith('CUSTOM'));
  await assert.rejects(() => renderWorkflow('no.such.doc', port));
});

test('getWorkflowRaw returns doc+rendered', async () => {
  const { port, snap } = fakes();
  const r = await getWorkflowRaw('controller.pass', port);
  assert.equal(r.doc, null);
  assert.ok(r.rendered.includes('Run a controller pass now.'));
});
