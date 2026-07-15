/**
 * Origin-anchoring for tool-registry WRITES — exact mirror of
 * workflow-origin-anchor.test.ts (spec §4.5): the mcp-tool-registry dataset lives
 * on its origin node; replicas' writes proxy there (`_originHop`), reads stay
 * local, proxy failures are fail-CLOSED (no silent local fallback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleToolSet, handleToolRollback, type ToolOriginAnchorDeps } from '../routes/core/mcp-tools.routes';
import type { ToolRegistryPort } from '../mcp-server/registry/store';
import type { ToolRegistryDoc } from '../mcp-server/registry/model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ToolRegistryPort & { puts: () => number; docs: Map<string, ToolRegistryDoc> } {
  const docs = new Map<string, ToolRegistryDoc>();
  let puts = 0;
  return {
    docs,
    puts: () => puts,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { puts++; docs.set(d.name, d); },
  };
}

function originDeps(opts: {
  origin: string | null;
  self?: string;
  onProxy?: (node: string, path: string, body: unknown) => unknown;
}): { deps: ToolOriginAnchorDeps; calls: Array<{ node: string; path: string; body: unknown }> } {
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

test('handleToolSet proxies the write to the dataset-origin node and passes its envelope through', async () => {
  const port = memPort();
  const remote = { success: true, data: { doc: { name: 'detail', rev: 7 }, changed: true } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleToolSet('detail', { descriptionOverride: 'o' }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'gw-123');
  assert.equal(calls[0].path, '/mcp-tools/detail');
  assert.deepEqual(calls[0].body, { descriptionOverride: 'o', _originHop: true });
  assert.equal(port.puts(), 0, 'local replica must not be written when proxying');
});

test('handleToolSet handles locally when this node IS the origin (loop-safe landing)', async () => {
  const port = memPort();
  const { deps, calls } = originDeps({ origin: 'gw-117', self: 'gw-117' });
  const r = await handleToolSet('detail', { descriptionOverride: 'o' }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 1);
  assert.equal(calls.length, 0);
});

test('handleToolSet handles locally when the dataset is unstamped (owned here)', async () => {
  const port = memPort();
  const { deps, calls } = originDeps({ origin: null });
  const r = await handleToolSet('detail', { descriptionOverride: 'o' }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal(calls.length, 0);
});

test('handleToolSet is fail-closed when the origin node is unreachable (no silent local fallback)', async () => {
  const port = memPort();
  const { deps } = originDeps({ origin: 'gw-123' }); // onProxy absent -> proxyPost throws
  const r = await handleToolSet('detail', { descriptionOverride: 'o' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'ORIGIN_UNREACHABLE');
  assert.equal(port.puts(), 0);
});

test('handleToolRollback proxies to the dataset-origin node with the same body', async () => {
  const port = memPort();
  const remote = { success: true, data: { doc: { name: 'detail', rev: 4 } } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleToolRollback('detail', { toRev: 1 }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/mcp-tools/detail/rollback');
  assert.deepEqual(calls[0].body, { toRev: 1, _originHop: true });
});

test('handleToolRollback stays local on the origin node', async () => {
  const port = memPort();
  await handleToolSet('detail', { descriptionOverride: 'v1' }, port, actor);
  await handleToolSet('detail', { descriptionOverride: 'v2' }, port, actor);
  const { deps, calls } = originDeps({ origin: 'gw-117', self: 'gw-117' });
  const r = await handleToolRollback('detail', { toRev: 1 }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.descriptionOverride, 'v1');
  assert.equal(calls.length, 0);
});

test('a hopped set request is NEVER re-proxied (mixed-version loop guard) and the flag is not persisted', async () => {
  const port = memPort();
  const { deps, calls } = originDeps({ origin: 'gw-123', self: 'gw-117' });
  const r = await handleToolSet('detail', { descriptionOverride: 'o', _originHop: true }, port, actor, deps);
  assert.equal(calls.length, 0, 'must not re-proxy a hopped request');
  assert.equal(r.success, true);
  const doc = (r.data as any).doc;
  assert.equal(doc.rev, 1);
  assert.equal('_originHop' in doc, false);
});

test('a hopped rollback request is NEVER re-proxied (mixed-version loop guard)', async () => {
  const port = memPort();
  await handleToolSet('detail', { descriptionOverride: 'v1' }, port, actor);
  await handleToolSet('detail', { descriptionOverride: 'v2' }, port, actor);
  const { deps, calls } = originDeps({ origin: 'gw-123', self: 'gw-117' });
  const r = await handleToolRollback('detail', { toRev: 1, _originHop: true }, port, actor, deps);
  assert.equal(calls.length, 0, 'must not re-proxy a hopped request');
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.descriptionOverride, 'v1');
});
