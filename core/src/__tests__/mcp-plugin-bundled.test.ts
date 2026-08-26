/**
 * Bundled first-party plugins (mcp-server/plugins/bundled.ts).
 *
 * The property under test is the trust BOUNDARY, not the copying: a payload that is
 * byte-for-byte what the package shipped may auto-enable; ANY other tree — hand
 * installed, locally edited, or shipped with a stale index — falls back to the normal
 * human gate and is never overwritten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  seedBundledPlugins, readBundledIndex, deriveLangmartApiBase, isBundledPlugin,
  isBundledMirror, _resetBundledIndexCacheForTests,
} from '../mcp-server/plugins/bundled';
import { payloadChecksum, manifestDigest } from '../mcp-server/plugins/checksum';
import { readState, writeState } from '../mcp-server/plugins/state-store';
import { discoverPlugins } from '../mcp-server/plugins/discovery';

const HUB = { hubUrl: 'wss://assist-api.langmart.ai', apiKey: 'sk-langassist-testkey' };

interface Env { root: string; src: string; dst: string; stateFile: string }

function env(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-bundled-'));
  const e = {
    root,
    src: path.join(root, 'package', 'mcp-plugins'),
    dst: path.join(root, 'node', 'mcp-plugins'),
    stateFile: path.join(root, 'state.json'),
  };
  fs.mkdirSync(e.src, { recursive: true });
  fs.mkdirSync(e.dst, { recursive: true });
  _resetBundledIndexCacheForTests();
  return e;
}

/** Write a payload into the package source tree and index it the way gen-bundled-plugins does. */
function bundlePlugin(e: Env, name: string, opts: { version?: string; env?: string[]; body?: string } = {}): string {
  const dir = path.join(e.src, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), opts.body ?? '/* stdio server */\n');
  const manifest = {
    manifestVersion: 1,
    name,
    version: opts.version ?? '1.0.0',
    description: 'a bundled test plugin',
    author: 'lm-assist',
    entry: { command: 'node', args: ['server.js'] },
    tools: [{ name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object' } }],
    capabilities: { network: [], fs: [], env: opts.env ?? [] },
    checksum: 'sha256:' + '0'.repeat(64),
  };
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(manifest, null, 2));
  // The manifest carries the checksum of everything EXCEPT itself, so it can be
  // written once and then stamped — same two-pass shape as the real gen-manifest.js.
  const checksum = payloadChecksum(dir);
  const stamped = { ...manifest, checksum };
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify(stamped, null, 2));
  writeIndex(e, [{ name, version: manifest.version, checksum, manifestDigest: manifestDigest(stamped) }]);
  return checksum;
}

function writeIndex(
  e: Env, plugins: Array<{ name: string; version: string; checksum: string; manifestDigest: string }>,
): void {
  fs.writeFileSync(path.join(e.src, 'bundled.json'), JSON.stringify({ plugins }, null, 2));
  _resetBundledIndexCacheForTests();
}

function seed(e: Env, extra: Record<string, unknown> = {}) {
  return seedBundledPlugins({ sourceDir: e.src, targetDir: e.dst, stateFile: e.stateFile, hubConfig: HUB, ...extra });
}

// --- the happy path ---------------------------------------------------------------

test('a bundled plugin with no grants to fill is installed and auto-enabled from the package', () => {
  const e = env();
  const checksum = bundlePlugin(e, 'first-party');

  const [r] = seed(e);
  assert.equal(r.outcome, 'seeded');
  assert.equal(r.enabled, true);

  const st = readState('first-party', e.stateFile);
  assert.equal(st.enabled, true);
  assert.equal(st.approvedPayloadChecksum, checksum);
  assert.equal(st.bundledSeededChecksum, checksum);
  // Provenance must not masquerade as a human approval.
  assert.equal(st.enabledBy, 'bundled@1.0.0');

  // And the loader agrees: the pin resolves to a live plugin.
  const rec = discoverPlugins({ dir: e.dst, stateFile: e.stateFile }).find((p) => p.name === 'first-party');
  assert.equal(rec?.effective.phase, 'enabled');
});

test('seeding is idempotent — a second pass reports up-to-date and re-enables nothing', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  seed(e);
  const [second] = seed(e);
  assert.equal(second.outcome, 'up-to-date');
  assert.equal(second.enabled, false, 'a quiet boot must not report a tool-surface change');
});

// --- the trust boundary -----------------------------------------------------------

test('a locally EDITED payload is never overwritten and never auto-enabled', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  seed(e);

  // The owner hacks on the installed tree.
  const edited = path.join(e.dst, 'first-party', 'server.js');
  fs.writeFileSync(edited, '/* local debugging */\n');
  const editedChecksum = payloadChecksum(path.join(e.dst, 'first-party'));

  const [r] = seed(e);
  assert.equal(r.outcome, 'kept-local');
  assert.equal(r.enabled, false);
  assert.equal(fs.readFileSync(edited, 'utf8'), '/* local debugging */\n', 'the package must not clobber local edits');
  // The pin is what the loader falls back on: an edited tree stops matching approval.
  assert.notEqual(editedChecksum, readState('first-party', e.stateFile).approvedPayloadChecksum);
  const rec = discoverPlugins({ dir: e.dst, stateFile: e.stateFile }).find((p) => p.name === 'first-party');
  assert.equal(rec?.effective.phase, 'disabled');
});

test('a hand-installed plugin that merely shares the name is left completely alone', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  // Someone already installed their OWN plugin under that name, before any seed.
  const dst = path.join(e.dst, 'first-party');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'mcp-plugin.json'), '{"mine":true}');
  fs.writeFileSync(path.join(dst, 'server.js'), '/* theirs */\n');

  const [r] = seed(e);
  assert.equal(r.outcome, 'kept-local');
  assert.equal(fs.readFileSync(path.join(dst, 'mcp-plugin.json'), 'utf8'), '{"mine":true}');
  assert.equal(readState('first-party', e.stateFile).enabled, false);
});

test('a STALE index (payload edited without regenerating bundled.json) seeds nothing', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  // Edit the package payload but leave the index pointing at the old checksum.
  fs.writeFileSync(path.join(e.src, 'first-party', 'server.js'), '/* changed after indexing */\n');

  const [r] = seed(e);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail ?? '', /bundled\.json is stale/);
  assert.equal(fs.existsSync(path.join(e.dst, 'first-party')), false, 'an unverifiable payload must not be installed');
});

// --- upgrades ---------------------------------------------------------------------

test('an upgrade replaces the tree WE seeded and re-pins it, dropping files the new version removed', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  seed(e);
  fs.writeFileSync(path.join(e.src, 'first-party', 'legacy.js'), '/* v1 only */\n');
  let cs = payloadChecksum(path.join(e.src, 'first-party'));
  // re-stamp + re-index so v1 ships legacy.js
  stamp(e, 'first-party', '1.0.0');
  seed(e);
  assert.equal(fs.existsSync(path.join(e.dst, 'first-party', 'legacy.js')), true);

  // v2 drops legacy.js.
  fs.rmSync(path.join(e.src, 'first-party', 'legacy.js'));
  cs = stamp(e, 'first-party', '2.0.0');

  const [r] = seed(e);
  assert.equal(r.outcome, 'updated');
  assert.equal(r.enabled, true);
  assert.equal(fs.existsSync(path.join(e.dst, 'first-party', 'legacy.js')), false,
    'a leftover file would change the checksum and block the pin');
  const st = readState('first-party', e.stateFile);
  assert.equal(st.approvedPayloadChecksum, cs);
  assert.equal(st.enabledBy, 'bundled@2.0.0');
});

test('an owner disable is STICKY across upgrades', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  seed(e);

  // What POST /mcp-plugins/<name>/disable records.
  writeState('first-party', { enabled: false, revertedReason: 'disabled by the owner', bundledOptOut: true }, e.stateFile);

  stamp(e, 'first-party', '2.0.0');
  const [r] = seed(e);
  assert.equal(r.outcome, 'updated', 'the payload still tracks the package');
  assert.equal(r.enabled, false);
  assert.equal(readState('first-party', e.stateFile).enabled, false, 'an upgrade must not undo the owner');
  assert.match(r.detail ?? '', /owner disabled/);
});

// --- grants -----------------------------------------------------------------------

test('declared env is derived from local config, and a human grant is never overwritten', () => {
  const e = env();
  bundlePlugin(e, 'langmart-design', { env: ['LANGMART_API_BASE', 'LANGMART_API_KEY'] });

  const [r] = seed(e);
  assert.deepEqual(r.grantedEnv.sort(), ['LANGMART_API_BASE', 'LANGMART_API_KEY']);
  assert.equal(r.enabled, true);
  const st = readState('langmart-design', e.stateFile);
  assert.equal(st.grants?.LANGMART_API_BASE, 'https://api.langmart.ai');
  assert.equal(st.grants?.LANGMART_API_KEY, HUB.apiKey);

  // A human sets their own key; a later seed must respect it.
  writeState('langmart-design', { grants: { ...st.grants, LANGMART_API_KEY: 'sk-langmart-humanchoice' } }, e.stateFile);
  stamp(e, 'langmart-design', '2.0.0');
  seed(e);
  assert.equal(readState('langmart-design', e.stateFile).grants?.LANGMART_API_KEY, 'sk-langmart-humanchoice');
});

test('a plugin whose declared env cannot be derived is installed but left OFF with an actionable reason', () => {
  const e = env();
  // No grant provider is registered for this name, so nothing can fill SOME_SECRET.
  bundlePlugin(e, 'needs-secret', { env: ['SOME_SECRET'] });

  const [r] = seed(e);
  assert.equal(r.outcome, 'seeded');
  assert.equal(r.enabled, false, 'enabling it would spawn a child that fails every call');
  assert.match(r.detail ?? '', /SOME_SECRET not granted/);
  assert.match(r.detail ?? '', /grant/);
});

test('an unknown hub host yields NO api base — a derived grant never guesses where the key goes', () => {
  assert.equal(deriveLangmartApiBase('wss://assist-api.langmart.ai'), 'https://api.langmart.ai');
  assert.equal(deriveLangmartApiBase('wss://assist-api.xeenhub.com'), 'https://api.xeenhub.com');
  assert.equal(deriveLangmartApiBase('wss://someone-elses-hub.example.com'), null);
  assert.equal(deriveLangmartApiBase('not a url'), null);
  assert.equal(deriveLangmartApiBase(undefined), null);

  const e = env();
  bundlePlugin(e, 'langmart-design', { env: ['LANGMART_API_BASE', 'LANGMART_API_KEY'] });
  const [r] = seed(e, { hubConfig: { hubUrl: 'wss://someone-elses-hub.example.com', apiKey: 'sk-langassist-x' } });
  assert.deepEqual(r.grantedEnv, [], 'half a grant is worse than none');
  assert.equal(r.enabled, false);
});

// --- kill switches + dry run ------------------------------------------------------

test('LM_BUNDLED_PLUGINS=0 stops seeding without touching the wider plugin subsystem', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  const prev = process.env.LM_BUNDLED_PLUGINS;
  process.env.LM_BUNDLED_PLUGINS = '0';
  try {
    assert.deepEqual(seed(e), []);
    assert.equal(fs.existsSync(path.join(e.dst, 'first-party')), false);
  } finally {
    if (prev === undefined) delete process.env.LM_BUNDLED_PLUGINS; else process.env.LM_BUNDLED_PLUGINS = prev;
  }
});

test('LM_MCP_PLUGINS=0 also stops it (the subsystem kill switch outranks the bundled one)', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  const prev = process.env.LM_MCP_PLUGINS;
  process.env.LM_MCP_PLUGINS = '0';
  try {
    assert.deepEqual(seed(e), []);
  } finally {
    if (prev === undefined) delete process.env.LM_MCP_PLUGINS; else process.env.LM_MCP_PLUGINS = prev;
  }
});

test('dry run reports the outcome and writes nothing', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  const [r] = seed(e, { dryRun: true });
  assert.equal(r.outcome, 'seeded');
  assert.equal(r.enabled, false);
  assert.equal(fs.existsSync(path.join(e.dst, 'first-party')), false);
  assert.equal(fs.existsSync(e.stateFile), false);
});

// --- the index --------------------------------------------------------------------

test('a missing or malformed index means nothing is bundled (fail closed)', () => {
  const e = env();
  assert.deepEqual(readBundledIndex(e.src).plugins, []);
  fs.writeFileSync(path.join(e.src, 'bundled.json'), 'not json');
  _resetBundledIndexCacheForTests();
  assert.deepEqual(readBundledIndex(e.src).plugins, []);
  assert.deepEqual(seed(e), []);
});

test('an index entry whose name is not a plain plugin id is discarded', () => {
  const e = env();
  bundlePlugin(e, 'first-party');
  // A name that would escape the plugins root, and one that is simply malformed.
  fs.writeFileSync(path.join(e.src, 'bundled.json'), JSON.stringify({
    plugins: [
      { name: '../../escape', version: '1.0.0', checksum: 'sha256:x', manifestDigest: 'sha256:y' },
      { name: 'Bad__Name', version: '1.0.0', checksum: 'sha256:x', manifestDigest: 'sha256:y' },
    ],
  }));
  _resetBundledIndexCacheForTests();
  assert.deepEqual(readBundledIndex(e.src).plugins, []);
  assert.deepEqual(seed(e), []);
});

test('the SHIPPED index matches the payloads actually vendored in this build', () => {
  // Guards the real package, not a fixture: if someone edits core/data/mcp-plugins
  // without re-running gen-bundled-plugins.js, every auto-enable silently stops.
  _resetBundledIndexCacheForTests();
  const shipped = readBundledIndex();
  for (const p of shipped.plugins) {
    const dir = path.join(__dirname, '..', '..', 'data', 'mcp-plugins', p.name);
    assert.equal(fs.existsSync(dir), true, `${p.name} is indexed but not vendored`);
    assert.equal(payloadChecksum(dir), p.checksum, `${p.name}: run node core/scripts/gen-bundled-plugins.js`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-plugin.json'), 'utf8'));
    assert.equal(manifest.checksum, p.checksum, `${p.name}: manifest pin disagrees with the payload`);
    assert.equal(manifest.version, p.version);
    assert.equal(isBundledPlugin(p.name), true);
    // Every payload here is a MIRROR of a repo lm-assist does not own. The recorded
    // upstream checksum must still describe the files on disk — if it does not, someone
    // edited lm-assist's copy instead of its source (gen-bundled-plugins.js refuses to
    // write such an index, so reaching this assertion means bundled.json was hand-edited).
    if (p.upstream) {
      assert.equal(p.upstream.checksum, p.checksum,
        `${p.name}: the mirror no longer matches what it was vendored from — fix it upstream and re-vendor with --from`);
      assert.equal(isBundledMirror(p.name), true);
      // The index is PUBLISHED. It must carry the provenance HASH and nothing that
      // identifies the upstream repository, which may be private.
      assert.deepEqual(Object.keys(p.upstream), ['checksum'],
        `${p.name}: bundled.json must record only the upstream checksum — never a repo URL, name or path`);
    }
  }
  assert.equal(isBundledPlugin('definitely-not-bundled'), false);
});

/** Re-stamp a package payload's manifest + index (what gen-manifest + gen-bundled do). */
function stamp(e: Env, name: string, version: string): string {
  const dir = path.join(e.src, name);
  const manifestPath = path.join(dir, 'mcp-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const checksum = payloadChecksum(dir);
  const stamped = { ...manifest, checksum };
  fs.writeFileSync(manifestPath, JSON.stringify(stamped, null, 2));
  writeIndex(e, [{ name, version, checksum, manifestDigest: manifestDigest(stamped) }]);
  return checksum;
}
