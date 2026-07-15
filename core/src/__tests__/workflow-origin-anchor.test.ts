/**
 * Origin-anchoring for workflow-registry WRITES (remediation option 2, 2026-07-15).
 *
 * The registry datasets live wherever ensureDataset() first ran (their `origin`);
 * every other node holds a read-only replica. Mission-leader anchoring is the wrong
 * authority for these writes — handleWorkflowSet/-Rollback must anchor to the
 * DATASET ORIGIN instead: proxy the same request to origin.machineId when it is a
 * different node, handle locally when unstamped/owned-here (which also makes the
 * proxied hop loop-safe on the origin node). Reads stay leader/local as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkflowSet, handleWorkflowRollback, type OriginAnchorDeps } from '../routes/core/mission.routes';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'gw-117', at: 1 };

function memPorts() {
  const docs = new Map<string, any>();
  const snaps = new Map<string, any>();
  let docPuts = 0;
  const port = {
    isEnabled: () => true,
    get: async (id: string) => docs.get(id) ?? null,
    list: async () => [...docs.values()],
    put: async (d: any) => { docPuts++; docs.set(d.id, d); },
  };
  const snap = {
    isEnabled: () => true,
    put: async (s: any) => { snaps.set(s.id, s); },
    get: async (docId: string, rev: number) => snaps.get(`${docId}:${rev}`) ?? null,
    list: async () => [],
    del: async () => {},
  };
  return { port, snap, snaps, docPuts: () => docPuts };
}

function originDeps(opts: {
  origin: string | null;
  self?: string;
  onProxy?: (node: string, path: string, body: unknown) => unknown;
}): { deps: OriginAnchorDeps; calls: Array<{ node: string; path: string; body: unknown }> } {
  const calls: Array<{ node: string; path: string; body: unknown }> = [];
  return {
    calls,
    deps: {
      getOrigin: async () => opts.origin,
      thisNode: () => opts.self ?? 'gw-117',
      proxyPost: async (node, path, body) => {
        calls.push({ node, path, body });
        if (!opts.onProxy) throw new Error('unexpected proxy');
        return opts.onProxy(node, path, body);
      },
    },
  };
}

test('handleWorkflowSet proxies the write to the dataset-origin node and passes its envelope through', async () => {
  const { port, snap, docPuts } = memPorts();
  const remote = { success: true, data: { doc: { id: 'case.x', rev: 7 }, changed: true } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleWorkflowSet('case.x', { title: 't', body: 'b' }, port as any, snap as any, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'gw-123');
  assert.equal(calls[0].path, '/mission/workflows/case.x');
  assert.deepEqual(calls[0].body, { title: 't', body: 'b', _originHop: true });
  assert.equal(docPuts(), 0, 'local replica must not be written when proxying');
});

test('handleWorkflowSet handles locally when this node IS the origin (loop-safe landing)', async () => {
  const { port, snap } = memPorts();
  const { deps, calls } = originDeps({ origin: 'gw-117', self: 'gw-117' });
  const r = await handleWorkflowSet('case.x', { title: 't', body: 'b' }, port as any, snap as any, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 1);
  assert.equal(calls.length, 0);
});

test('handleWorkflowSet handles locally when the dataset is unstamped (owned here)', async () => {
  const { port, snap } = memPorts();
  const { deps, calls } = originDeps({ origin: null });
  const r = await handleWorkflowSet('case.x', { title: 't', body: 'b' }, port as any, snap as any, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 1);
  assert.equal(calls.length, 0);
});

test('handleWorkflowSet is fail-closed when the origin node is unreachable (no silent local fallback)', async () => {
  const { port, snap, docPuts } = memPorts();
  const { deps } = originDeps({ origin: 'gw-123' }); // onProxy absent -> proxyPost throws
  const r = await handleWorkflowSet('case.x', { title: 't', body: 'b' }, port as any, snap as any, actor, deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'ORIGIN_UNREACHABLE');
  assert.equal(docPuts(), 0);
});

test('handleWorkflowRollback proxies to the dataset-origin node with the same body', async () => {
  const { port, snap } = memPorts();
  const remote = { success: true, data: { doc: { id: 'case.x', rev: 4 } } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleWorkflowRollback('case.x', { toRev: 1 }, port as any, snap as any, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/mission/workflows/case.x/rollback');
  assert.deepEqual(calls[0].body, { toRev: 1, _originHop: true });
});

test('handleWorkflowRollback stays local on the origin node', async () => {
  const { port, snap, snaps } = memPorts();
  snaps.set('case.x:1', { id: 'case.x:1', docId: 'case.x', rev: 1, at: 1, actor, title: 't1', body: 'b1', editPolicy: 'open' });
  const { deps, calls } = originDeps({ origin: 'gw-117', self: 'gw-117' });
  const r = await handleWorkflowRollback('case.x', { toRev: 1 }, port as any, snap as any, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.body, 'b1');
  assert.equal(calls.length, 0);
});

test('a hopped set request is NEVER re-proxied (mixed-version loop guard) and the flag is not persisted', async () => {
  const { port, snap } = memPorts();
  // Origin deps say "elsewhere" — but the request already carries the hop flag
  // (it arrived via another node's anchor). Re-proxying here would loop.
  const { deps, calls } = originDeps({ origin: 'gw-123', self: 'gw-117' });
  const r = await handleWorkflowSet('case.x', { title: 't', body: 'b', _originHop: true }, port as any, snap as any, actor, deps);
  assert.equal(calls.length, 0, 'must not re-proxy a hopped request');
  assert.equal(r.success, true);
  const doc = (r.data as any).doc;
  assert.equal(doc.rev, 1);
  assert.equal('_originHop' in doc, false);
});

test('a hopped rollback request is NEVER re-proxied (mixed-version loop guard)', async () => {
  const { port, snap, snaps } = memPorts();
  snaps.set('case.x:1', { id: 'case.x:1', docId: 'case.x', rev: 1, at: 1, actor, title: 't1', body: 'b1', editPolicy: 'open' });
  const { deps, calls } = originDeps({ origin: 'gw-123', self: 'gw-117' });
  const r = await handleWorkflowRollback('case.x', { toRev: 1, _originHop: true }, port as any, snap as any, actor, deps);
  assert.equal(calls.length, 0, 'must not re-proxy a hopped request');
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.body, 'b1');
});
