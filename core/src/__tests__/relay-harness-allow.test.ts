import { test } from 'node:test';
import assert from 'node:assert';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

// /harness is deliberately NOT relay-allowed. PUT /harness/provider/:name stores a
// live credential, so a bare '/harness' prefix would make it writable from the hub;
// and the run history quotes whatever an agent printed. v1 keeps the Harness Runs
// page node-local. If cross-node viewing is added later it must be the NARROW
// read prefixes ('/harness/runs', '/harness/runners') — this pins that nothing
// widened the list by accident in the meantime.
test('/harness paths are not relay-allowed', () => {
  for (const p of [
    '/harness',
    '/harness/status',
    '/harness/runs',
    '/harness/runners',
    '/harness/runs/agent-1-abc',
    '/harness/runs/agent-1-abc/transcript',
    '/harness/provider/x',
  ]) {
    assert.equal(isApiPathAllowed(p), false, `expected NOT allowed: ${p}`);
  }
});
