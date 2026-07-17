import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerForwardPath, createPeerRelayRoutes } from '../routes/core/peer-relay.routes';
import type { ParsedRequest } from '../routes/index';

test('peerForwardPath allows only the relayable web surfaces, blocks traversal', () => {
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

test('peerForwardPath: CCR page surface is relayable, wider surfaces stay blocked', () => {
  // Allowed: the CCR page operating on a peer's sessions.
  assert.equal(peerForwardPath('ccr/remote'), '/ccr/remote');
  assert.equal(peerForwardPath('ccr/load'), '/ccr/load');
  assert.equal(peerForwardPath('terminal/cc-sessions'), '/terminal/cc-sessions');
  assert.equal(peerForwardPath('terminal/cc-sessions/abc/interrupt'), '/terminal/cc-sessions/abc/interrupt');
  assert.equal(
    peerForwardPath('sessions/00000000-0000-0000-0000-000000000000/conversation'),
    '/sessions/00000000-0000-0000-0000-000000000000/conversation',
  );
  assert.equal(peerForwardPath('mission/session/abc/drive'), '/mission/session/abc/drive');
  assert.equal(peerForwardPath('session-messages'), '/session-messages');
  // Blocked: everything beyond that surface.
  assert.equal(peerForwardPath('terminal/tmux/x/send-keys'), null); // only the cc-sessions subtree
  assert.equal(peerForwardPath('terminal/local'), null);
  assert.equal(peerForwardPath('mission/list'), null);              // mission CRUD is hub-relay only
  assert.equal(peerForwardPath('mission/abc/spawn'), null);
  assert.equal(peerForwardPath('session-search/ai'), null);
  assert.equal(peerForwardPath('ccr/../hub/config'), null);         // traversal still dies after the new prefixes
  assert.equal(peerForwardPath('terminal/cc-sessions/../../hub'), null);
});

test('peerForwardPath defeats percent-encoded and double-encoded traversal', () => {
  // Encoded `..` that would pass a raw includes('..') / PATH_RE check but
  // decodes to a traversal out of the /memory allow-list.
  assert.equal(peerForwardPath('/memory/%2e%2e/hub/config'), null);
  assert.equal(peerForwardPath('/memory/%2E%2E/hub/config'), null);
  assert.equal(peerForwardPath('/memory/..%2fhub/config'), null);
  // Encoded slash right after the prefix breaks the required `/memory/` shape once decoded.
  assert.equal(peerForwardPath('/rules%2f..%2fhub/config'), null);
  // Double-encoded traversal (iterative decode must catch it).
  assert.equal(peerForwardPath('/memory/%252e%252e/hub'), null);
  // A malformed %-escape is refused outright.
  assert.equal(peerForwardPath('/memory/%zz'), null);
  // Encoded but legitimate: %2d is '-', a valid slug char → decodes to canonical form.
  assert.equal(peerForwardPath('/memory/by-project/a%2db/file/x.md'), '/memory/by-project/a-b/file/x.md');
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
  const r2: any = await route.handler(bad({ node: 'gw4-ok', rest: 'data/put' }), {} as any);
  assert.equal(r2.error.code, 'INVALID_INPUT');
});
