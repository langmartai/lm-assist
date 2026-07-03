// core/src/__tests__/data/rpc-allowlist.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRpcServer } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';

// Each test file is its own module context under `node --test` — the codec
// singleton in envelope.ts is NOT shared across files, so every file that
// calls encodeBody/decodeBody must load it independently (same pattern as
// bus/rpc-bus-allowlist.test.ts and fabric/rpc-server.test.ts).
before(async () => { await initEnvelopeCodec(); });

async function ask(path: string, method = 'GET', opts: { rpc?: boolean; data?: boolean } = {}) {
  const dispatched: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { dispatched.push(r.path); return { status: 200, data: { ok: true } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => opts.rpc ?? false,
    busEnabled: () => false,
    dataSyncEnabled: () => opts.data ?? false,
    peerNodeOf: () => 'gw-b',
  });
  const env: Envelope = { kind: 'req', id: 'x', headers: { method, path }, payload: encodeBody({}) };
  const res: Envelope = await new Promise((resolve) => server(env, resolve));
  return { status: (res.headers as any).status, code: (res.headers as any).code, dispatched };
}

test('sync routes dispatch under dataSyncEnabled even when fabricRpcEnabled is false', async () => {
  for (const [p, m] of [['/data/sync/manifest', 'GET'], ['/data/missions/export', 'POST'], ['/data/missions/fetch', 'POST']] as const) {
    const r = await ask(p, m, { data: true });
    assert.deepEqual(r.dispatched, [p], `${p} should dispatch`);
    assert.equal(r.status, 200);
  }
});

test('sync routes are REFUSED when dataSyncEnabled is false', async () => {
  const r = await ask('/data/sync/manifest', 'GET', { data: false });
  assert.equal(r.status, 503);
  assert.deepEqual(r.dispatched, []);
});

test('non-sync /data routes are REFUSED even with dataSyncEnabled (no bare prefix)', async () => {
  for (const p of ['/data/missions/records', '/data/datasets', '/data/missions/sql', '/data/missions/admin', '/data/sync']) {
    const r = await ask(p, 'POST', { data: true });
    assert.equal(r.status, 503, `${p} must be refused`);
  }
});

test('a traversal that normalizes out of the sync shape is REFUSED', async () => {
  const r = await ask('/data/../hub/config', 'GET', { data: true, rpc: false });
  assert.equal(r.status, 503);
  assert.deepEqual(r.dispatched, []);
});

// Percent-encoded sibling of the literal-dot traversal above (W3's
// rpc-bus-allowlist.test.ts proves both forms for the same reason: the
// allow-list decides on `routedPath = new URL(reqPath, 'http://localhost')
// .pathname`, which collapses a `%2e%2e` segment to `..` identically to a
// literal one — so BOTH must be refused pre-dispatch, not just the literal
// spelling an attacker is least likely to use).
test('a percent-encoded traversal that normalizes out of the sync shape is REFUSED', async () => {
  const r = await ask('/data/%2e%2e/claude-code/usage', 'GET', { data: true, rpc: false });
  assert.equal(r.status, 503);
  assert.equal(r.code, 'rpc_disabled');
  assert.deepEqual(r.dispatched, [], 'dispatch must never be invoked for an encoded traversal path');
});

test('general RPC (fabricRpcEnabled) still dispatches anything', async () => {
  const r = await ask('/data/missions/records', 'PUT', { rpc: true });
  assert.equal(r.status, 200);
});
