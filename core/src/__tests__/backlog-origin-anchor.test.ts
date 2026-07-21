/** Origin-anchoring for backlog WRITES — fourth consumer of the SHARED origin-anchor:
 *  proxy to the dataset origin, land locally on the origin node, fail CLOSED when
 *  unreachable, relay origin refusals VERBATIM, never re-proxy a hopped request.
 *  Mirrors assist-content-origin-anchor.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleBacklogCreate, handleBacklogDiscuss, handleBacklogLink, handleBacklogRemove,
  handleBacklogRollback, handleBacklogUpdate,
} from '../routes/core/backlog.routes';
import type { OriginAnchorDeps } from '../routes/core/origin-anchor';
import type { BacklogPort } from '../mcp-server/registry/backlog-store';
import type { BacklogDoc } from '../mcp-server/registry/backlog-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): BacklogPort & { puts: () => number } {
  const docs = new Map<string, BacklogDoc>();
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

test('create proxies to the dataset-origin node and passes its envelope through', async () => {
  const port = memPort();
  const remote = { success: true, data: { item: { id: 'bl_aaaa1111', version: 1 }, changed: true } };
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => remote });
  const r = await handleBacklogCreate({ title: 'X' }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal((r.data as { item: { id: string } }).item.id, 'bl_aaaa1111');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'gw-123');
  assert.equal(calls[0].path, '/backlog');
  assert.deepEqual(calls[0].body, { title: 'X', _originHop: true });
  assert.equal(port.puts(), 0, 'local replica must not be written when proxying');
});

test('every write family proxies to its own path with the hop flag', async () => {
  const cases: Array<[string, (deps: OriginAnchorDeps, port: BacklogPort) => Promise<unknown>]> = [
    ['/backlog/bl_aaaa1111', (deps, port) => handleBacklogUpdate('bl_aaaa1111', { status: 'accepted' }, port, actor, deps)],
    ['/backlog/bl_aaaa1111/link', (deps, port) => handleBacklogLink('bl_aaaa1111', { to: 'bl_bbbb2222', kind: 'blocks' }, port, actor, deps)],
    ['/backlog/bl_aaaa1111/discuss', (deps, port) => handleBacklogDiscuss('bl_aaaa1111', { note: 'n' }, port, actor, deps)],
    ['/backlog/bl_aaaa1111/remove', (deps, port) => handleBacklogRemove('bl_aaaa1111', {}, port, actor, deps)],
    ['/backlog/bl_aaaa1111/rollback', (deps, port) => handleBacklogRollback('bl_aaaa1111', { toRev: 1 }, port, actor, deps)],
  ];
  for (const [path, run] of cases) {
    const port = memPort();
    const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => ({ success: true, data: { ok: 1 } }) });
    await run(deps, port);
    assert.equal(calls.length, 1, path);
    assert.equal(calls[0].path, path);
    assert.equal((calls[0].body as { _originHop?: boolean })._originHop, true, path);
    assert.equal(port.puts(), 0, path);
  }
});

test('writes land locally when this node IS the origin / dataset unstamped', async () => {
  for (const origin of ['gw-117', null]) {
    const port = memPort();
    const { deps, calls } = originDeps({ origin, self: 'gw-117' });
    const r = await handleBacklogCreate({ title: 'X' }, port, actor, deps);
    assert.equal(r.success, true);
    assert.equal(calls.length, 0);
    assert.equal(port.puts(), 1);
  }
});

test('a hopped request NEVER re-anchors (loop guard)', async () => {
  const port = memPort();
  const { deps, calls } = originDeps({ origin: 'gw-123', onProxy: () => { throw new Error('must not proxy'); } });
  const r = await handleBacklogCreate({ title: 'X', _originHop: true }, port, actor, deps);
  assert.equal(r.success, true);
  assert.equal(calls.length, 0, 'hop flag terminates the anchor');
  assert.equal(port.puts(), 1, 'handled locally on the origin');
});

test('fail-closed when the origin is unreachable (no silent local fallback)', async () => {
  const port = memPort();
  const { deps } = originDeps({ origin: 'gw-123' }); // onProxy absent -> proxyPost throws
  const r = await handleBacklogCreate({ title: 'X' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'ORIGIN_UNREACHABLE');
  assert.equal(port.puts(), 0);
});

test('an ORIGIN-side refusal relays VERBATIM', async () => {
  const port = memPort();
  const refusal = { success: false, error: { code: 'UNSUPPORTED_FIELD', message: 'unsupported update field(s): titel' } };
  const { deps } = originDeps({ origin: 'gw-123', onProxy: () => refusal });
  const r = await handleBacklogUpdate('bl_aaaa1111', { status: 'accepted' }, port, actor, deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'UNSUPPORTED_FIELD', 'real refusal, not ORIGIN_UNREACHABLE');
});
