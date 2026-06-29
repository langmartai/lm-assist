import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

function check(path: string): string | null {
  const h = new ApiRelayHandler({ localApiPort: 3200 } as any);
  return (h as any).validateRequest({ type: 'api_relay', requestId: 'r1', method: 'POST', path });
}
test('/rules/export is relay-allowed', () => assert.equal(check('/rules/export'), null));
test('/rules/ingest is relay-allowed', () => assert.equal(check('/rules/ingest'), null));
test('/rules/map (existing CLI route) is now relay-allowed too', () => assert.equal(check('/rules/map'), null));
