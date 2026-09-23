// core/src/__tests__/data-bundle/dl-origin-anchor-offline.test.ts
// origin-anchor fix-alongside: the hub answers a proxy to an OFFLINE machine with a 503
// whose body says so. That is decided BEFORE anything is forwarded, so nothing can have
// been written — ORIGIN_UNREACHABLE ("retry freely"), not ORIGIN_TIMEOUT ("may have
// landed"). Any other >=500 stays ORIGIN_TIMEOUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-oa-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-oa-data-'));
process.env.TIER_AGENT_HUB_URL = 'wss://hub.invalid';

import { anchorToOrigin, realOriginAnchor, type OriginAnchorDeps } from '../../routes/core/origin-anchor';

/** Real proxyPost (the part that turns an HTTP answer into a throw/value) with a stubbed
 *  fetch — no network — and a fixed origin/self pair. */
async function anchorWithHubAnswer(status: number, body: string): Promise<{ code: string; message: string }> {
  const real = realOriginAnchor('backlog');
  const deps: OriginAnchorDeps = { getOrigin: async () => 'gw-origin', thisNode: () => 'gw-caller', proxyPost: real.proxyPost };
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    const r = await anchorToOrigin(deps, '/backlog', { title: 'x' }, 'backlog');
    assert.ok(r && !r.success);
    return r!.error!;
  } finally {
    globalThis.fetch = saved;
  }
}

test('hub 503 "Machine offline" (JSON without success) → ORIGIN_UNREACHABLE', async () => {
  const e = await anchorWithHubAnswer(503, JSON.stringify({ error: 'Machine offline' }));
  assert.equal(e.code, 'ORIGIN_UNREACHABLE');
  assert.match(e.message, /NOT applied/);
  assert.match(e.message, /offline/i, 'the reason names the offline machine');
});

test('offline match is case-insensitive and tolerates a plain-text body', async () => {
  assert.equal((await anchorWithHubAnswer(503, 'target machine is OFFLINE')).code, 'ORIGIN_UNREACHABLE');
  assert.equal((await anchorWithHubAnswer(503, JSON.stringify({ message: 'Worker offline' }))).code, 'ORIGIN_UNREACHABLE');
});

test('a 503 with success:false + offline string error is also ORIGIN_UNREACHABLE', async () => {
  const e = await anchorWithHubAnswer(503, JSON.stringify({ success: false, error: 'machine offline' }));
  assert.equal(e.code, 'ORIGIN_UNREACHABLE');
  assert.match(e.message, /offline/i);
});

test('any other >=500 stays ORIGIN_TIMEOUT (it may have landed)', async () => {
  assert.equal((await anchorWithHubAnswer(503, JSON.stringify({ error: 'Service Unavailable' }))).code, 'ORIGIN_TIMEOUT');
  assert.equal((await anchorWithHubAnswer(502, '<html>Bad Gateway</html>')).code, 'ORIGIN_TIMEOUT');
  assert.equal((await anchorWithHubAnswer(500, JSON.stringify({ error: 'boom' }))).code, 'ORIGIN_TIMEOUT');
});

test('"offline" only counts on a 503 — a 500 mentioning offline is still ambiguous', async () => {
  assert.equal((await anchorWithHubAnswer(500, JSON.stringify({ error: 'upstream went offline mid-request' }))).code, 'ORIGIN_TIMEOUT');
});

test('injected deps: a thrown 503 carrying an offline body is unreachable; bare 503 is a timeout', async () => {
  const base = { getOrigin: async () => 'gw-origin', thisNode: () => 'gw-caller' };
  const offline = await anchorToOrigin(
    { ...base, proxyPost: async () => { throw Object.assign(new Error('Proxy POST returned 503'), { status: 503, body: '{"error":"Machine offline"}' }); } },
    '/x', {}, 'backlog',
  );
  assert.equal(offline!.error!.code, 'ORIGIN_UNREACHABLE');
  const bare = await anchorToOrigin(
    { ...base, proxyPost: async () => { throw Object.assign(new Error('Proxy POST returned 503'), { status: 503 }); } },
    '/x', {}, 'backlog',
  );
  assert.equal(bare!.error!.code, 'ORIGIN_TIMEOUT');
});
