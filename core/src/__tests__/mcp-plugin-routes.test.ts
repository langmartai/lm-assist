/**
 * /mcp-plugins routes: the loopback-only human enable gate (design §Security 2)
 * and the relay allow-list entry the page needs.
 *
 * Enabling third-party code execution is an OWNER action at the console — never
 * reachable over the LAN, never through the hub relay, never by an agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handlePluginList, handlePluginGet, handlePluginEnable, handlePluginDisable,
  handlePluginGrant, handlePluginAudit, createMcpPluginsRoutes,
} from '../routes/core/mcp-plugins.routes';
import { readState } from '../mcp-server/plugins/state-store';
import { isApiPathAllowed } from '../hub-client/api-relay-handler';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-plugroutes-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'demo');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify({
    manifestVersion: 1, name: 'demo', version: '1.0.0', description: 'demo', author: 't',
    entry: { command: 'node', args: ['dist/server.js'] },
    tools: [{ name: 'alpha', description: 'a', inputSchema: { type: 'object' } }],
    capabilities: { network: [], fs: [], env: ['DEMO_SECRET'] },
    checksum: 'sha256:' + '0'.repeat(64),
  }, null, 2));
  const opts = {
    dir: pluginsDir,
    stateFile: path.join(root, 'state.json'),
    auditFile: path.join(root, 'audit.jsonl'),
    scratchRoot: path.join(root, 'scratch'),
  };
  return { root, opts };
}
const LOOPBACK = '127.0.0.1';
const LAN = '10.0.1.107';

test('GET /mcp-plugins lists discovered plugins (read is not loopback-gated)', async () => {
  const { root, opts } = setup();
  const r = await handlePluginList({ clientIp: LAN } as any, opts);
  assert.equal(r.success, true);
  const data = r.data as { plugins: Array<{ name: string; phase: string }> };
  assert.equal(data.plugins.length, 1);
  assert.equal(data.plugins[0].phase, 'disabled');
  fs.rmSync(root, { recursive: true, force: true });
});

test('ENABLE is refused from a non-loopback client', async () => {
  const { root, opts } = setup();
  const r = await handlePluginEnable('demo', { clientIp: LAN } as any, {}, opts);
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'FORBIDDEN');
  assert.equal(readState('demo', opts.stateFile).enabled, false, 'refused enable must not persist');
  fs.rmSync(root, { recursive: true, force: true });
});

test('ENABLE from loopback records the checksum + manifest pin', async () => {
  const { root, opts } = setup();
  const r = await handlePluginEnable('demo', { clientIp: LOOPBACK } as any, {}, opts);
  assert.equal(r.success, true, JSON.stringify(r.error));
  const st = readState('demo', opts.stateFile);
  assert.equal(st.enabled, true);
  assert.match(st.approvedPayloadChecksum || '', /^sha256:[a-f0-9]{64}$/);
  assert.match(st.approvedManifestDigest || '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(st.enabledAt && st.enabledAt > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ENABLE refuses a plugin whose manifest is invalid', async () => {
  const { root, opts } = setup();
  const p = path.join(opts.dir, 'demo', 'mcp-plugin.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.entry = 'bash -c evil';
  fs.writeFileSync(p, JSON.stringify(m));
  const r = await handlePluginEnable('demo', { clientIp: LOOPBACK } as any, {}, opts);
  assert.equal(r.success, false);
  assert.equal(readState('demo', opts.stateFile).enabled, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('DISABLE is loopback-only and is instant', async () => {
  const { root, opts } = setup();
  await handlePluginEnable('demo', { clientIp: LOOPBACK } as any, {}, opts);
  const lan = await handlePluginDisable('demo', { clientIp: LAN } as any, opts);
  assert.equal(lan.success, false);
  assert.equal(readState('demo', opts.stateFile).enabled, true, 'LAN disable must not take effect');
  const ok = await handlePluginDisable('demo', { clientIp: LOOPBACK } as any, opts);
  assert.equal(ok.success, true);
  assert.equal(readState('demo', opts.stateFile).enabled, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('GRANT is loopback-only, accepts only DECLARED names, and never echoes secrets', async () => {
  const { root, opts } = setup();
  const lan = await handlePluginGrant('demo', { clientIp: LAN } as any, { env: { DEMO_SECRET: 's' } }, opts);
  assert.equal(lan.success, false, 'secrets may not be written over the LAN');

  const undeclared = await handlePluginGrant('demo', { clientIp: LOOPBACK } as any, { env: { OTHER: 'x' } }, opts);
  assert.equal(undeclared.success, false, 'a grant for an undeclared variable is refused');

  const ok = await handlePluginGrant('demo', { clientIp: LOOPBACK } as any, { env: { DEMO_SECRET: 'super-secret' } }, opts);
  assert.equal(ok.success, true);
  assert.equal(readState('demo', opts.stateFile).grants?.DEMO_SECRET, 'super-secret');
  assert.ok(!JSON.stringify(ok.data).includes('super-secret'), 'the response must not echo the secret back');
  fs.rmSync(root, { recursive: true, force: true });
});

test('GET /mcp-plugins/:name never returns grant VALUES (only which names are granted)', async () => {
  const { root, opts } = setup();
  await handlePluginGrant('demo', { clientIp: LOOPBACK } as any, { env: { DEMO_SECRET: 'super-secret' } }, opts);
  const r = await handlePluginGet('demo', { clientIp: LOOPBACK } as any, opts);
  assert.equal(r.success, true);
  const body = JSON.stringify(r.data);
  assert.ok(!body.includes('super-secret'), 'SECRET LEAK through the read route');
  assert.match(body, /DEMO_SECRET/, 'the granted NAME should still be visible for review');
  fs.rmSync(root, { recursive: true, force: true });
});

test('audit tail is readable for the page', async () => {
  const { root, opts } = setup();
  fs.writeFileSync(opts.auditFile,
    JSON.stringify({ ts: new Date().toISOString(), plugin: 'demo', tool: 'alpha', argDigest: 'deadbeef', durationMs: 5, outcome: 'ok' }) + '\n');
  const r = await handlePluginAudit('demo', { clientIp: LOOPBACK } as any, {}, opts);
  assert.equal(r.success, true);
  assert.equal((r.data as { entries: unknown[] }).entries.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown plugin name yields NOT_FOUND, not a crash', async () => {
  const { root, opts } = setup();
  const r = await handlePluginGet('nosuch', { clientIp: LOOPBACK } as any, opts);
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'NOT_FOUND');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a traversal-shaped plugin name cannot escape the plugins directory', async () => {
  const { root, opts } = setup();
  for (const evil of ['../../etc', '..', 'demo/../../x', '/etc/passwd']) {
    const r = await handlePluginGet(evil, { clientIp: LOOPBACK } as any, opts);
    assert.equal(r.success, false, `name "${evil}" must be refused`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('routes are registered with literals before the :name patterns', () => {
  const routes = createMcpPluginsRoutes({} as any);
  const paths = routes.map((r) => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some((p) => p.startsWith('GET') && p.includes('mcp-plugins')));
  assert.ok(paths.some((p) => p.startsWith('POST') && p.includes('enable')));
  assert.ok(paths.some((p) => p.startsWith('POST') && p.includes('disable')));
});

test('/mcp-plugins is on the hub relay allow-list (the page must reach a remote node)', () => {
  for (const p of ['/mcp-plugins', '/mcp-plugins/demo', '/mcp-plugins/demo/audit']) {
    assert.equal(isApiPathAllowed(p), true, `expected relay-allowed: ${p}`);
  }
  assert.equal(isApiPathAllowed('/mcp-pluginsx'), false);
});
