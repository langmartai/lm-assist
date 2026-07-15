/**
 * Origin-anchoring for assist-content WRITES — the third consumer of the SHARED
 * origin-anchor (design §2b): proxy to the dataset origin, land locally on the origin
 * node, fail CLOSED when unreachable, relay origin refusals VERBATIM, never re-proxy a
 * hopped request. Mirrors workflow-origin-anchor / mcp-tools-origin-anchor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleContentSet, handleContentRollback } from '../routes/core/assist-content.routes';
import type { OriginAnchorDeps } from '../routes/core/origin-anchor';
import type { ContentPort } from '../mcp-server/registry/content-store';
import type { ContentDoc } from '../mcp-server/registry/content-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ContentPort & { puts: () => number } {
  const docs = new Map<string, ContentDoc>();
  let puts = 0;
  return {
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

test('set proxies to the dataset-origin node and passes its envelope through', async () => {
  const port = memPort();
  const remote = { success: true, data: { doc: { name: 'guide.data', rev: 5 }, changed: true } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleContentSet('guide.data', { contentOverride: 'x' }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.rev, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'gw-123');
  assert.equal(calls[0].path, '/assist-content/guide.data');
  assert.deepEqual(calls[0].body, { contentOverride: 'x', _originHop: true });
  assert.equal(port.puts(), 0, 'local replica must not be written when proxying');
});

test('set lands locally when this node IS the origin / dataset unstamped', async () => {
  for (const origin of ['gw-117', null]) {
    const port = memPort();
    const { deps, calls } = originDeps({ origin, self: 'gw-117' });
    const r = await handleContentSet('guide.data', { contentOverride: 'x' }, port, actor, deps);
    assert.equal(r.success, true);
    assert.equal((r.data as any).doc.rev, 1);
    assert.equal(calls.length, 0);
  }
});

test('set is fail-closed when the origin is unreachable (no silent local fallback)', async () => {
  const port = memPort();
  const { deps } = originDeps({ origin: 'gw-123' }); // onProxy absent -> proxyPost throws
  const r = await handleContentSet('guide.data', { contentOverride: 'x' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'ORIGIN_UNREACHABLE');
  assert.equal(port.puts(), 0);
});

test('an ORIGIN-side refusal relays VERBATIM (the improved shared-anchor semantics)', async () => {
  const port = memPort();
  const refusal = { success: false, error: { code: 'OVERRIDE_TOO_LARGE', message: 'contentOverride exceeds 16384 bytes' } };
  const { deps } = originDeps({ origin: 'gw-123', onProxy: () => refusal });
  const r = await handleContentSet('guide.data', { contentOverride: 'x' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'OVERRIDE_TOO_LARGE', 'real refusal, not ORIGIN_UNREACHABLE');
});

test('a refusal WITHOUT a proper code cannot masquerade as an origin envelope', async () => {
  const port = memPort();
  const { deps } = originDeps({ origin: 'gw-123', onProxy: () => ({ success: false, error: 'relay text error' }) });
  const r = await handleContentSet('guide.data', { contentOverride: 'x' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'ORIGIN_UNREACHABLE');
});

test('rollback proxies with the same body + hop flag', async () => {
  const port = memPort();
  const remote = { success: true, data: { doc: { name: 'guide.data', rev: 4 } } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleContentRollback('guide.data', { toRev: 2 }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal(calls[0].path, '/assist-content/guide.data/rollback');
  assert.deepEqual(calls[0].body, { toRev: 2, _originHop: true });
});
