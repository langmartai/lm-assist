import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

function check(path: string, method = 'POST'): string | null {
  const h = new ApiRelayHandler({ localApiPort: 3200 } as any);
  return (h as any).validateRequest({ type: 'api_relay', requestId: 'r1', method, path });
}

// cluster_assign / cluster_unassign proxy a remote node's POST /cluster/self
// through the hub machine-proxy relay. If /cluster is not relay-allowed, the
// receiving node's ApiRelayHandler rejects it ("Path not allowed") and the
// proxy POST returns 500 — so cross-node cluster assignment silently fails.
test('/cluster/self is relay-allowed', () => {
  assert.equal(check('/cluster/self'), null);
});

test('/cluster prefix is relay-allowed', () => {
  assert.equal(check('/cluster', 'GET'), null);
});

test('isApiPathAllowed accepts /cluster/self', () => {
  assert.equal(ApiRelayHandler.isApiPathAllowed('/cluster/self'), true);
});

test('an unlisted path is still rejected', () => {
  assert.match(String(check('/totally-unknown')), /not allowed/i);
});
