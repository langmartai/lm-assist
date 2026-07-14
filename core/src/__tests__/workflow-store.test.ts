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
    del: async (id) => { snaps.delete(id); },
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

// ── I5: snapshot retention ──

test('I5: 25 puts prune snapshots to <= 20, newest retained', async () => {
  const { port, snap, snaps } = fakes();
  for (let i = 1; i <= 25; i++) {
    await putWorkflow({ id: 'x.y', title: 'T', body: `B${i}`, editPolicy: 'open' }, user, port, snap);
  }
  const remaining = await snap.list('x.y', { limit: 200 });
  assert.ok(remaining.length <= 20, `expected <= 20 snapshots remaining, got ${remaining.length}`);
  // Newest (rev 25 down to rev 6) retained; oldest (rev 1..5) pruned.
  const revs = remaining.map((s) => s.rev).sort((a, b) => a - b);
  assert.equal(revs[0], 6, 'the oldest retained snapshot must be rev 6 (revs 1-5 pruned)');
  assert.equal(revs[revs.length - 1], 25, 'the newest snapshot (rev 25) must be retained');
  assert.equal(snaps.has('x.y:1'), false, 'rev 1 snapshot must have been pruned');
  assert.equal(snaps.has('x.y:25'), true, 'rev 25 (newest) snapshot must be retained');
});

test('I5: retention is scoped PER DOC — a second doc\'s snapshots are unaffected', async () => {
  const { port, snap } = fakes();
  for (let i = 1; i <= 25; i++) {
    await putWorkflow({ id: 'doc.a', title: 'T', body: `A${i}`, editPolicy: 'open' }, user, port, snap);
  }
  await putWorkflow({ id: 'doc.b', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  const bSnaps = await snap.list('doc.b', { limit: 200 });
  assert.equal(bSnaps.length, 1, 'doc.b (only 1 put) must be completely untouched by doc.a\'s pruning');
});

test('I5: pruning is best-effort — snap.del absent (older/legacy port) never throws, no cap enforced', async () => {
  const { port } = fakes(); // a real, doc-state-tracking port so `rev` increments correctly across puts
  const snapsMap = new Map<string, WorkflowSnapshot>();
  const legacySnap: WorkflowSnapshotPort = {
    // NOTE: no `del` — mirrors an older port implementation that predates I5.
    isEnabled: () => true,
    put: async (s) => { snapsMap.set(s.id, s); },
    get: async (docId, rev) => snapsMap.get(`${docId}:${rev}`) ?? null,
    list: async (docId, opts) => [...snapsMap.values()].filter((s) => s.docId === docId).sort((a, b) => b.rev - a.rev).slice(0, opts.limit ?? 50),
  };
  for (let i = 1; i <= 25; i++) {
    await assert.doesNotReject(() => putWorkflow({ id: 'legacy.doc', title: 'T', body: `L${i}`, editPolicy: 'open' }, user, port, legacySnap));
  }
  const all = await legacySnap.list('legacy.doc', { limit: 200 });
  assert.equal(all.length, 25, 'without snap.del, no pruning occurs — this documents the graceful-degrade behavior');
});

test('I5: pruning is best-effort — snap.list/del THROWING never blocks the edit itself', async () => {
  const { port } = fakes();
  const throwingSnap: WorkflowSnapshotPort = {
    isEnabled: () => true,
    put: async () => {},
    get: async () => null,
    list: async () => { throw new Error('list backend down'); },
    del: async () => { throw new Error('del backend down'); },
  };
  const r = await putWorkflow({ id: 'x.z', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, throwingSnap);
  assert.equal(r.changed, true, 'the edit must succeed even though the retention prune step failed');
});
