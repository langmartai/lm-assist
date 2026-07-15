import { test } from 'node:test';
import assert from 'node:assert';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

// Origin-anchored registry writes proxy POST /mcp-tools/:name(/rollback) through the
// hub machine-relay, and the web UI reads GET /mcp-tools when viewing a remote node —
// all of it dies with "Path not allowed" unless the prefix is allow-listed
// (matching is segment-aware: '/mcp' does NOT cover '/mcp-tools').
test('/mcp-tools paths are relay-allowed', () => {
  for (const p of [
    '/mcp-tools',
    '/mcp-tools/overlay',
    '/mcp-tools/detail',
    '/mcp-tools/detail/history',
    '/mcp-tools/detail/rollback',
    '/mcp-tools/zz-e2e-probe',
  ]) {
    assert.equal(isApiPathAllowed(p), true, `expected allowed: ${p}`);
  }
  assert.equal(isApiPathAllowed('/mcp-toolsx'), false, 'prefix-only match should not allow /mcp-toolsx');
});
