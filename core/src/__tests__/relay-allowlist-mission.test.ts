import { test } from 'node:test';
import assert from 'node:assert';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

test('/mission paths are relay-allowed', () => {
  for (const p of [
    '/mission',
    '/mission/sessions',
    '/mission/session/abc/read',
    '/mission/controller',
    '/mission/controller/',
    '/mission/session/cse_123/drive',
    '/mission/session/cse_123/control',
  ]) {
    assert.equal(isApiPathAllowed(p), true, `expected allowed: ${p}`);
  }
  assert.equal(isApiPathAllowed('/totally-unknown'), false, 'unknown path should be rejected');
  assert.equal(isApiPathAllowed('/missionxyz'), false, 'prefix-only match should not allow /missionxyz');
});
