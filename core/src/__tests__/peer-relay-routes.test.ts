import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerForwardPath, createPeerRelayRoutes } from '../routes/core/peer-relay.routes';
import type { ParsedRequest } from '../routes/index';

test('peerForwardPath allows only /memory and /rules, blocks traversal', () => {
  assert.equal(peerForwardPath('memory/projects'), '/memory/projects');
  assert.equal(peerForwardPath('/memory/by-project/x/file/a.md'), '/memory/by-project/x/file/a.md');
  assert.equal(peerForwardPath('rules/list'), '/rules/list');
  assert.equal(peerForwardPath('memory-cache/clear'), null);   // prefix must be a path segment
  assert.equal(peerForwardPath('hub/config'), null);
  assert.equal(peerForwardPath('lifecycle/exit'), null);
  assert.equal(peerForwardPath('memory/../hub/config'), null);
  assert.equal(peerForwardPath('rules\\..\\x'), null);
  assert.equal(peerForwardPath('data/put'), null);
});

test('relayed requests are refused (no chaining)', async () => {
  const route = createPeerRelayRoutes({} as any).find(r => r.method === 'GET')!;
  const req = {
    method: 'GET', path: '/peer-relay/gw4-x/memory/projects',
    params: { node: 'gw4-x', rest: 'memory/projects' }, query: {},
    headers: { 'x-relay-source': 'hub' }, clientIp: '127.0.0.1',
  } as unknown as ParsedRequest;
  const r: any = await route.handler(req, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'PEER_RELAY_CHAIN');
});

test('bad node id and non-allow-listed path are refused before any network use', async () => {
  const route = createPeerRelayRoutes({} as any).find(r => r.method === 'PUT')!;
  const bad = (params: Record<string, string>) => ({
    method: 'PUT', path: '/peer-relay/x/y', params, query: {}, headers: {}, clientIp: '127.0.0.1',
  }) as unknown as ParsedRequest;
  const r1: any = await route.handler(bad({ node: 'gw/evil', rest: 'memory/x' }), {} as any);
  assert.equal(r1.error.code, 'INVALID_INPUT');
  const r2: any = await route.handler(bad({ node: 'gw4-ok', rest: 'sessions' }), {} as any);
  assert.equal(r2.error.code, 'INVALID_INPUT');
});
