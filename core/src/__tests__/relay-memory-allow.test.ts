import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

function check(path: string): string | null {
  const h = new ApiRelayHandler({ localApiPort: 3200 } as any);
  return (h as any).validateRequest({ type: 'api_relay', requestId: 'r1', method: 'POST', path });
}

test('/memory/export is relay-allowed', () => {
  assert.equal(check('/memory/export'), null);
});

test('/memory/ingest is relay-allowed', () => {
  assert.equal(check('/memory/ingest'), null);
});

test('an unlisted path is still rejected', () => {
  assert.match(String(check('/totally-unknown')), /not allowed/i);
});
