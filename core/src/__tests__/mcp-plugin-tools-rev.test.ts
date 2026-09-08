/**
 * Enabling or disabling a plugin must BUMP THE TOOLS REV.
 *
 * `bumpToolsRev()` documents its own contract: "Call from every funnel that can
 * alter what `tools/list` returns — overlay writes, content-overlay writes,
 * plugin enable/disable/sync. Over-calling is harmless (a client re-fetches);
 * UNDER-calling is the bug, because the client is never told and keeps a stale
 * list until it reconnects."
 *
 * Plugin enable/disable adds or removes `ext__<plugin>__<tool>` entries from
 * tools/list, but neither handler called it — so a local Claude Code session over
 * stdio kept advertising a disabled plugin's tools (and never learned about a
 * newly-enabled one) until the session was restarted. The claude.ai connector path
 * was wired (syncConnectorForPluginTools); the stdio notification path was not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handlePluginEnable, handlePluginDisable } from '../routes/core/mcp-plugins.routes';
import { currentToolsRev } from '../mcp-server/registry/tools-rev';

const LOOPBACK = '127.0.0.1';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-plugrev-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'demo');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify({
    manifestVersion: 1, name: 'demo', version: '1.0.0', description: 'demo', author: 't',
    entry: { command: 'node', args: ['dist/server.js'] },
    tools: [{ name: 'alpha', description: 'a', inputSchema: { type: 'object' } }],
    capabilities: { network: [], fs: [], env: [] },
    checksum: 'sha256:' + '0'.repeat(64),
  }, null, 2));
  return {
    opts: {
      dir: pluginsDir,
      stateFile: path.join(root, 'state.json'),
      auditFile: path.join(root, 'audit.jsonl'),
      scratchRoot: path.join(root, 'scratch'),
      // stateFile already suppresses the connector sync; be explicit.
      connectorSync: false as const,
    },
  };
}

test('enabling a plugin bumps the tools rev', async () => {
  const { opts } = setup();
  const before = currentToolsRev();

  const r = await handlePluginEnable('demo', { clientIp: LOOPBACK } as any, {}, opts);
  assert.equal(r.success, true, 'enable should succeed from loopback');

  assert.notEqual(currentToolsRev(), before,
    'enable adds ext__demo__alpha to tools/list — the rev must change or stdio clients keep a stale list');
});

test('disabling a plugin bumps the tools rev', async () => {
  const { opts } = setup();
  await handlePluginEnable('demo', { clientIp: LOOPBACK } as any, {}, opts);

  const afterEnable = currentToolsRev();
  const r = await handlePluginDisable('demo', { clientIp: LOOPBACK } as any, opts);
  assert.equal(r.success, true, 'disable should succeed from loopback');

  assert.notEqual(currentToolsRev(), afterEnable,
    'disable removes the plugin tools — the rev must change');
});

test('a REFUSED enable does not bump the rev', async () => {
  const { opts } = setup();
  const before = currentToolsRev();

  // LAN is refused by the loopback gate, so nothing about tools/list changed.
  const r = await handlePluginEnable('demo', { clientIp: '10.0.1.107' } as any, {}, opts);
  assert.equal(r.success, false, 'a LAN enable must be refused');

  assert.equal(currentToolsRev(), before,
    'a refused write changed nothing, so it must not tell every client to re-fetch');
});
