import { test } from 'node:test';
import assert from 'node:assert';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

// Origin-anchored content writes proxy POST /assist-content/:id(/rollback) through the
// hub machine-relay, and the web UI reads GET /assist-content when viewing a remote
// node — all of it dies with "Path not allowed" unless the prefix is allow-listed.
// The mcp-registry max-review made this a MANDATORY checklist item for every new
// relayed route family (its own family shipped without it and every cross-node write
// died 400 at the relay while unit tests passed via fake proxyPost).
test('/assist-content paths are relay-allowed', () => {
  for (const p of [
    '/assist-content',
    '/assist-content/overlay',
    '/assist-content/guide.data',
    '/assist-content/guide.cross-node/history',
    '/assist-content/bootstrap.header/rollback',
    '/assist-content/guide.zz-e2e-probe',
  ]) {
    assert.equal(isApiPathAllowed(p), true, `expected allowed: ${p}`);
  }
  assert.equal(isApiPathAllowed('/assist-contentx'), false, 'prefix-only match should not allow /assist-contentx');
});
