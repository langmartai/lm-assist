/**
 * Discovery, enable-state and the pin (contract §1, §2; design §Security 1/2/8).
 *
 * The load-bearing property: DISCOVERY IS NOT EXECUTION. A dropped-in plugin is
 * parsed, checksummed and listed for review WITHOUT anything being spawned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverPlugins, effectivePhase } from '../mcp-server/plugins/discovery';
import { readState, writeState } from '../mcp-server/plugins/state-store';
import { payloadChecksum } from '../mcp-server/plugins/checksum';

/** A plugin whose server would SCREAM if it were ever executed during discovery. */
function makePluginDir(root: string, name: string, manifestPatch: Record<string, unknown> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'dist', 'server.js'),
    `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'EXECUTED'))}, 'boom');\n`,
  );
  const manifest = {
    manifestVersion: 1,
    name,
    version: '1.0.0',
    description: 'test plugin',
    author: 'test',
    entry: { command: 'node', args: ['dist/server.js'] },
    tools: [{ name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object' } }],
    checksum: 'sha256:' + '0'.repeat(64),
    ...manifestPatch,
  };
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function env(): { root: string; stateFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-plugins-'));
  return { root, stateFile: path.join(root, 'state.json') };
}

test('a dropped-in plugin is DISCOVERED but lands disabled and is never executed', () => {
  const { root, stateFile } = env();
  makePluginDir(root, 'chart');
  const found = discoverPlugins({ dir: root, stateFile });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'chart');
  assert.equal(found[0].effective.phase, 'disabled', 'landing state must be disabled');
  assert.ok(found[0].manifest, 'manifest parsed without executing');
  assert.match(found[0].payloadChecksum || '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(root, 'EXECUTED')), false, 'DISCOVERY MUST NOT EXECUTE THE PLUGIN');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an invalid manifest is surfaced for review, not silently skipped, and never enabled', () => {
  const { root, stateFile } = env();
  makePluginDir(root, 'bad', { entry: 'bash -c evil' });
  const [rec] = discoverPlugins({ dir: root, stateFile });
  assert.equal(rec.effective.phase, 'invalid');
  assert.ok(rec.manifestErrors.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('directory-name / manifest-name mismatch is invalid', () => {
  const { root, stateFile } = env();
  const dir = makePluginDir(root, 'chart');
  fs.renameSync(dir, path.join(root, 'renamed'));
  const [rec] = discoverPlugins({ dir: root, stateFile });
  assert.equal(rec.effective.phase, 'invalid');
  fs.rmSync(root, { recursive: true, force: true });
});

test('enabling pins the payload checksum + manifest digest and yields phase enabled', () => {
  const { root, stateFile } = env();
  const dir = makePluginDir(root, 'chart');
  const sum = payloadChecksum(dir);
  const [before] = discoverPlugins({ dir: root, stateFile });
  writeState('chart', {
    enabled: true,
    approvedPayloadChecksum: sum,
    approvedManifestDigest: before.manifestDigest!,
  }, stateFile);
  const [after] = discoverPlugins({ dir: root, stateFile });
  assert.equal(after.effective.phase, 'enabled');
  fs.rmSync(root, { recursive: true, force: true });
});

test('PAYLOAD SWAP after approval auto-reverts to disabled (the pin)', () => {
  const { root, stateFile } = env();
  const dir = makePluginDir(root, 'chart');
  const [rec0] = discoverPlugins({ dir: root, stateFile });
  writeState('chart', {
    enabled: true,
    approvedPayloadChecksum: payloadChecksum(dir),
    approvedManifestDigest: rec0.manifestDigest!,
  }, stateFile);
  assert.equal(discoverPlugins({ dir: root, stateFile })[0].effective.phase, 'enabled');

  fs.appendFileSync(path.join(dir, 'dist', 'server.js'), '\n// swapped payload\n');
  const [rec] = discoverPlugins({ dir: root, stateFile });
  assert.equal(rec.effective.phase, 'disabled', 'a changed payload must not run');
  assert.match(rec.effective.reason || '', /payload|checksum/i);
  assert.equal(readState('chart', stateFile).enabled, false, 'the revert is persisted, not just computed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MANIFEST EDIT after approval (capability escalation) auto-reverts to disabled', () => {
  const { root, stateFile } = env();
  const dir = makePluginDir(root, 'chart');
  const [rec0] = discoverPlugins({ dir: root, stateFile });
  writeState('chart', {
    enabled: true,
    approvedPayloadChecksum: payloadChecksum(dir),
    approvedManifestDigest: rec0.manifestDigest!,
  }, stateFile);

  const m = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-plugin.json'), 'utf8'));
  m.capabilities = { network: ['evil.example.com'], fs: [], env: [] };
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(m, null, 2));

  const [rec] = discoverPlugins({ dir: root, stateFile });
  assert.equal(rec.effective.phase, 'disabled', 'silently widened capabilities must not run');
  assert.match(rec.effective.reason || '', /manifest/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('state is stored OUTSIDE the plugin directory (so recording it cannot move the pin)', () => {
  const { root, stateFile } = env();
  const dir = makePluginDir(root, 'chart');
  const before = payloadChecksum(dir);
  writeState('chart', { enabled: true, approvedPayloadChecksum: before }, stateFile);
  assert.equal(payloadChecksum(dir), before, 'writing enable-state must not perturb the payload hash');
  assert.equal(fs.existsSync(stateFile), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the state file is written 0600 (it holds capability grants/secrets)', () => {
  const { root, stateFile } = env();
  makePluginDir(root, 'chart');
  writeState('chart', { enabled: false, grants: { CHART_API_KEY: 'super-secret' } }, stateFile);
  const mode = fs.statSync(stateFile).mode & 0o777;
  assert.equal(mode, 0o600, `state file mode ${mode.toString(8)} must be 600`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('effectivePhase is fail-closed for every unknown/partial state', () => {
  const base = {
    name: 'x', dir: '/tmp/x', manifest: { name: 'x' } as any, manifestErrors: [],
    payloadChecksum: 'sha256:aaa', manifestDigest: 'sha256:bbb',
  };
  // enabled but nothing pinned => must NOT run
  assert.equal(effectivePhase({ ...base, state: { enabled: true } } as any).phase, 'disabled');
  // pinned to a different payload => must NOT run
  assert.equal(effectivePhase({
    ...base, state: { enabled: true, approvedPayloadChecksum: 'sha256:zzz', approvedManifestDigest: 'sha256:bbb' },
  } as any).phase, 'disabled');
  // quarantined => unhealthy
  assert.equal(effectivePhase({
    ...base,
    state: {
      enabled: true, approvedPayloadChecksum: 'sha256:aaa', approvedManifestDigest: 'sha256:bbb',
      health: { failures: 3, quarantinedUntil: Date.now() + 60000 },
    },
  } as any).phase, 'unhealthy');
});

test('discovery tolerates junk in the plugins dir without throwing', () => {
  const { root, stateFile } = env();
  makePluginDir(root, 'chart');
  fs.writeFileSync(path.join(root, 'loose-file.txt'), 'not a plugin');
  fs.mkdirSync(path.join(root, 'empty-dir'));
  fs.writeFileSync(path.join(root, 'broken', 'mcp-plugin.json').replace('/mcp-plugin.json', '') + '.tmp', 'x');
  fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'broken', 'mcp-plugin.json'), '{ not json');
  const found = discoverPlugins({ dir: root, stateFile });
  const byName = new Map(found.map((f) => [f.name, f]));
  assert.equal(byName.get('chart')!.effective.phase, 'disabled');
  assert.equal(byName.get('broken')!.effective.phase, 'invalid', 'unparseable manifest => invalid, not a crash');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing plugins directory yields an empty list, not an error', () => {
  const { root, stateFile } = env();
  const found = discoverPlugins({ dir: path.join(root, 'does-not-exist'), stateFile });
  assert.deepEqual(found, []);
  fs.rmSync(root, { recursive: true, force: true });
});
