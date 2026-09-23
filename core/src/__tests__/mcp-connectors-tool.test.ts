/**
 * mcp_connectors — the MCP face of /mcp/profile-connectors (spec §7.3, amended d7a4d0c: under
 * /mcp/, not /mcp-tools/, so an older Core 404s instead of misrouting the request). Registered in
 * all four places a
 * new tool needs (a missing TOOL_SCOPES entry CRASHES Core on tools/list), admin-only by category,
 * and its output is one line per profile, never tool names.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_CONNECTORS_HANDLERS } from '../mcp-server/tools/mcp-connectors';
import { TOOL_SCOPES, LM_ASSIST_TOOL_NAMES, LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import { categoryOf } from '../mcp-server/registry/categories';
import { EXPANDED_HANDLERS } from '../mcp-server/tools/expanded';
import { NOT_MEASURED, MEASURED_BUDGETS } from '../mcp-server/tool-output-budget';
import { applyProfileToToolDefs } from '../mcp-server/registry/profiles';
import { playbookTopicForTool } from '../mcp-server/tool-topics';

test('mcp_connectors is registered in all four places a new tool needs', () => {
  assert.ok(LM_ASSIST_TOOL_NAMES.includes('mcp_connectors'));
  assert.equal(TOOL_SCOPES.mcp_connectors, 'admin', 'it writes the user\'s claude.ai account');
  assert.equal(categoryOf('mcp_connectors'), 'claudeai');
  assert.equal(typeof EXPANDED_HANDLERS.mcp_connectors, 'function');
  assert.ok('mcp_connectors' in NOT_MEASURED && !('mcp_connectors' in MEASURED_BUDGETS));
  assert.equal(playbookTopicForTool('mcp_connectors'), 'claude-ai');
});

test('only admin advertises it (claudeai category)', () => {
  const names = (p: string) => applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], p).map((d: any) => d.name);
  assert.ok(names('admin').includes('mcp_connectors'));
  assert.ok(!names('basic').includes('mcp_connectors'));
  assert.ok(!names('extended').includes('mcp_connectors'));
});

const realFetch = global.fetch;
const calls: Array<{ method: string; url: string; body?: any }> = [];
function stub(data: () => unknown): void {
  // @ts-expect-error test stub
  global.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
    calls.push({ method: opts?.method || 'GET', url: String(url), body: opts?.body ? JSON.parse(opts.body) : undefined });
    const env = { success: true, data: data() };
    const text = JSON.stringify(env);
    return { ok: true, status: 200, async text() { return text; }, async json() { return env; } };
  };
}
afterEach(() => { global.fetch = realFetch; calls.length = 0; });

const LIST = {
  base: 'https://mcp.langmart.ai', hub: 'langmart', nodeDefault: 'admin', claudeai: { ok: true },
  unpinned: { url: 'https://mcp.langmart.ai/mcp', suggestedName: 'lm-assist langmart', duplicates: 0,
    connector: { uuid: 'u-1', name: 'lm-assist langmart', connected: true, authStatus: 'authenticated', toolCount: 320 } },
  profiles: [
    { profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic', suggestedName: 'lm-assist langmart basic', duplicates: 0,
      connector: { uuid: 'b-1', name: 'lm-assist langmart basic', connected: false, authStatus: 'auth_required', toolCount: null } },
    { profile: 'extended', url: 'https://mcp.langmart.ai/mcp/extended', suggestedName: 'lm-assist langmart extended', duplicates: 0, connector: null },
  ],
  unknownPins: [],
};

test('list renders one line per profile — URL and claude.ai status', async () => {
  stub(() => LIST);
  const res = await MCP_CONNECTORS_HANDLERS.mcp_connectors({});
  const t = res.content[0].text;
  assert.notEqual(res.isError, true, t);
  assert.match(t, /unpinned\s+https:\/\/mcp\.langmart\.ai\/mcp → "lm-assist langmart" \[connected, authenticated\] 320 tools/);
  assert.match(t, /basic\s+https:\/\/mcp\.langmart\.ai\/mcp\/basic → "lm-assist langmart basic" \[NOT connected, auth_required\]/);
  assert.match(t, /extended\s+https:\/\/mcp\.langmart\.ai\/mcp\/extended → no claude\.ai connector/);
  assert.ok(calls.every((c) => c.method === 'GET'), 'list never writes');
  assert.match(calls[0].url, /\/mcp\/profile-connectors$/);
});

test('create requires a profile and posts exactly {profile}', async () => {
  stub(() => ({
    created: true, profile: 'extended', url: 'https://mcp.langmart.ai/mcp/extended',
    connector: { uuid: 'e-1', name: 'lm-assist langmart extended', connected: false, authStatus: null, toolCount: null },
    nextStep: 'Connect it once in a browser: claude.ai → Customize → Connectors.',
  }));
  const missing = await MCP_CONNECTORS_HANDLERS.mcp_connectors({ action: 'create' });
  assert.equal(missing.isError, true);
  assert.equal(calls.length, 0);
  const res = await MCP_CONNECTORS_HANDLERS.mcp_connectors({ action: 'create', profile: 'extended' });
  assert.notEqual(res.isError, true, res.content[0].text);
  const post = calls.find((c) => c.method === 'POST');
  assert.match(post!.url, /\/mcp\/profile-connectors$/);
  assert.deepEqual(post!.body, { profile: 'extended' });
  assert.match(res.content[0].text, /NEXT: Connect it once in a browser/);
});

test('delete calls DELETE /mcp/profile-connectors/<profile>', async () => {
  stub(() => ({ profile: 'basic', url: 'https://mcp.langmart.ai/mcp/basic', removed: [{ uuid: 'b-1', name: 'lm-assist langmart basic' }], failed: [] }));
  const res = await MCP_CONNECTORS_HANDLERS.mcp_connectors({ action: 'delete', profile: 'basic' });
  assert.notEqual(res.isError, true, res.content[0].text);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del!.url, /\/mcp\/profile-connectors\/basic$/);
  assert.match(res.content[0].text, /Removed 1 claude\.ai connector/);
});

test('an unknown action is refused without a call', async () => {
  stub(() => ({}));
  const res = await MCP_CONNECTORS_HANDLERS.mcp_connectors({ action: 'wipe' });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});
