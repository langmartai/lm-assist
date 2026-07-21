import { test } from 'node:test';
import assert from 'node:assert';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

// Origin-anchored backlog writes proxy POST /backlog(/:id/...) through the hub
// machine-relay, and the web UI reads GET /backlog(/graph) when viewing a remote
// node — all of it dies with "Path not allowed" unless the prefix is allow-listed.
// Mandatory checklist item for every new relayed route family (the mcp-registry
// max-review lesson: its own family shipped without it and every cross-node write
// died 400 at the relay while unit tests passed via fake proxyPost).
test('/backlog paths are relay-allowed', () => {
  for (const p of [
    '/backlog',
    '/backlog/graph',
    '/backlog/bl_aaaa1111',
    '/backlog/bl_aaaa1111/history',
    '/backlog/bl_aaaa1111/link',
    '/backlog/bl_aaaa1111/discuss',
    '/backlog/bl_aaaa1111/rollback',
  ]) {
    assert.equal(isApiPathAllowed(p), true, `expected allowed: ${p}`);
  }
  assert.equal(isApiPathAllowed('/backlogx'), false, 'prefix-only match should not allow /backlogx');
});
