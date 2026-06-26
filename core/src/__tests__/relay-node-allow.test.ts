import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

function check(path: string, method = 'GET'): string | null {
  const h = new ApiRelayHandler({ localApiPort: 3200 } as any);
  return (h as any).validateRequest({ type: 'api_relay', requestId: 'r1', method, path });
}

// node_builds fans out GET /node/build to every node via the hub proxy relay.
// If /node is not relay-allowed, remote nodes are rejected ("Path not allowed")
// and node_builds shows them as "v?" even when they ARE upgraded.
test('/node/build is relay-allowed', () => {
  assert.equal(check('/node/build'), null);
});

test('/node prefix is relay-allowed', () => {
  assert.equal(check('/node'), null);
});

test('isApiPathAllowed accepts /node/build', () => {
  assert.equal(ApiRelayHandler.isApiPathAllowed('/node/build'), true);
});

test('an unlisted path is still rejected', () => {
  assert.match(String(check('/totally-unknown')), /not allowed/i);
});
