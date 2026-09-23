/**
 * MCP tool loading profiles: which tools a node ADVERTISES.
 *
 * The invariants that matter are the ones that keep a narrowed surface usable — the
 * door back out, and the orientation tool the `node` selector tells every caller to
 * use. Getting either wrong strands a session in a profile it cannot leave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic: tests below write the node-default profile file. Never the developer's real one.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profiles-'));
process.env.LM_ASSIST_DATA_DIR = DATA_DIR;

import {
  PROFILE_DEFINITIONS, DEFAULT_PROFILE, resolveProfileTools, applyProfileToToolDefs,
  unmatchedSelectors, knownSelectors,
  PROFILE_ALIASES, PROFILE_PIN_HEADER, PROFILE_PIN_ENV, canonicalProfileName, getProfile,
  isValidPinSyntax, resolveEffectiveProfile, liveEffectiveProfile, isNarrowedProfile,
  profileNeedsExtTools, activeProfileName, setActiveProfile, readProfileState,
  _resetProfileCacheForTests,
} from '../mcp-server/registry/profiles';
import { PROTECTED_TOOLS } from '../mcp-server/registry/model';
import { LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';
import { isDevRepo } from '../utils/path-utils';

const AVAILABLE = LM_ASSIST_TOOL_DEFS.map((d) => d.name);
const WITH_EXT = [...AVAILABLE, 'ext__langmart__models_list', 'ext__langmart__quota_status', 'ext__other__thing'];

test('the default profile is admin — nothing regresses until someone chooses', () => {
  assert.equal(DEFAULT_PROFILE, 'admin');
  assert.equal(PROFILE_DEFINITIONS.admin.selectors, 'all');
  assert.equal(applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], 'admin').length, LM_ASSIST_TOOL_DEFS.length);
});

test('every profile keeps the protected tools — the door back out', () => {
  for (const [name, def] of Object.entries(PROFILE_DEFINITIONS)) {
    const keep = resolveProfileTools(def, AVAILABLE);
    for (const p of PROTECTED_TOOLS) {
      if (!AVAILABLE.includes(p)) continue;
      assert.ok(keep.has(p), `profile "${name}" dropped protected tool "${p}"`);
    }
  }
});

test('basic advertises list_nodes even though its category is excluded', () => {
  // Every tool carries a `node` selector saying "check list_nodes before concluding
  // absent". Advertising that advice while hiding list_nodes makes it unfollowable.
  const keep = resolveProfileTools(PROFILE_DEFINITIONS.basic, AVAILABLE);
  assert.ok(keep.has('list_nodes'), 'basic must pull list_nodes in by name');
  assert.ok(!keep.has('node_upgrade'), 'but NOT the rest of the fleet category');
});

test('basic is a real reduction and still carries orientation', () => {
  const keep = resolveProfileTools(PROFILE_DEFINITIONS.basic, AVAILABLE);
  assert.ok(keep.size < AVAILABLE.length / 3, `basic should be well under a third: ${keep.size}/${AVAILABLE.length}`);
  for (const n of ['bootstrap', 'guide', 'search', 'search_memory', 'backlog_list', 'list_recent_sessions']) {
    assert.ok(keep.has(n), `basic must keep "${n}"`);
  }
  for (const n of ['gmail_send', 'linkedin_post', 'vm_create']) {
    assert.ok(!keep.has(n), `basic must not advertise "${n}"`);
  }
});

test('an ext__<plugin> selector takes the whole plugin and nothing else', () => {
  const keep = resolveProfileTools(PROFILE_DEFINITIONS.platform, WITH_EXT);
  assert.ok(keep.has('ext__langmart__models_list'));
  assert.ok(keep.has('ext__langmart__quota_status'));
  assert.ok(!keep.has('ext__other__thing'), 'a different plugin must not be pulled in');
});

test('a plugin selector does not match a plugin whose name merely starts the same', () => {
  const keep = resolveProfileTools(
    { description: '', selectors: ['ext__langmart'] },
    ['ext__langmart__a', 'ext__langmart-admin__b'],
  );
  assert.ok(keep.has('ext__langmart__a'));
  assert.ok(!keep.has('ext__langmart-admin__b'), 'ext__langmart must not swallow ext__langmart-admin');
});

test('platform keeps the superseded `langmart-design` tools and still drops `langmart-admin`', () => {
  // The predecessor can stay enabled indefinitely (it is retired only once `langmart` is
  // enabled), and 0.2.4 peers keep advertising it through the fleet fan-out. Matching
  // only the new name would leave `platform` with none of the LangMart tools there.
  const names = [
    ...AVAILABLE,
    'ext__langmart-design__models_list', 'ext__langmart-admin__x', 'ext__langmart-designer__y',
  ];
  const keep = resolveProfileTools(PROFILE_DEFINITIONS.platform, names);
  assert.ok(keep.has('ext__langmart-design__models_list'), 'the superseded name is the same plugin');
  assert.ok(!keep.has('ext__langmart-admin__x'), 'a different plugin must not be pulled in');
  assert.ok(!keep.has('ext__langmart-designer__y'), 'a superseded name is matched by exact segment too');
  // …and the connector-sync / tools/list path, which goes through applyProfileToToolDefs.
  const kept = applyProfileToToolDefs(names.map((name) => ({ name })), 'platform').map((d) => d.name);
  assert.ok(kept.includes('ext__langmart-design__models_list'));
  assert.ok(!kept.includes('ext__langmart-admin__x'));
  // A node with ONLY the predecessor does not report `ext__langmart` as unmatched.
  assert.deepEqual(unmatchedSelectors(PROFILE_DEFINITIONS.platform, names), []);
});

test('every rename in bundled.json is honoured by the ext__ selector of its successor', () => {
  // PLUGIN_SUPERSEDES in profiles.ts must stay in step with the index the generator writes.
  const ROOT = path.resolve(__dirname, '..', '..');
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mcp-plugins', 'bundled.json'), 'utf-8'));
  let checked = 0;
  for (const p of index.plugins as Array<{ name: string; supersedes?: string[] }>) {
    for (const old of p.supersedes ?? []) {
      const keep = resolveProfileTools({ description: '', selectors: [`ext__${p.name}`] }, [`ext__${old}__t`]);
      assert.ok(keep.has(`ext__${old}__t`), `ext__${p.name} does not take its predecessor "${old}"`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'bundled.json lists no rename — was this test pointed at the wrong file?');
});

test('extended is a superset of basic, and admin of extended', () => {
  const basic = resolveProfileTools(PROFILE_DEFINITIONS.basic, AVAILABLE);
  const ext = resolveProfileTools(PROFILE_DEFINITIONS.extended, AVAILABLE);
  const admin = resolveProfileTools(PROFILE_DEFINITIONS.admin, AVAILABLE);
  for (const n of basic) assert.ok(ext.has(n), `extended lost "${n}" from basic`);
  for (const n of ext) assert.ok(admin.has(n), `admin lost "${n}" from extended`);
  assert.ok(ext.size > basic.size);
});

test('an unknown profile name fails OPEN — never a blank tool surface', () => {
  const out = applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], 'no-such-profile');
  assert.equal(out.length, LM_ASSIST_TOOL_DEFS.length,
    'a bad profile name must advertise everything, not nothing');
});

test('every shipped profile resolves — no selector names nothing', () => {
  for (const [name, def] of Object.entries(PROFILE_DEFINITIONS)) {
    // ext__langmart only resolves when the plugin is installed, so check against WITH_EXT.
    const dead = unmatchedSelectors(def, WITH_EXT);
    assert.deepEqual(dead, [], `profile "${name}" has selectors matching nothing: ${dead.join(', ')}`);
  }
});

test('knownSelectors reports the categories and the installed plugins', () => {
  const k = knownSelectors(WITH_EXT);
  assert.ok(k.categories.includes('memory'));
  assert.deepEqual(k.plugins, ['ext__langmart', 'ext__other']);
});

test('filtering preserves the def objects untouched', () => {
  const out = applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], 'basic');
  const boot = out.find((d: any) => d.name === 'bootstrap');
  assert.ok(boot, 'bootstrap survives');
  assert.equal(boot, LM_ASSIST_TOOL_DEFS.find((d) => d.name === 'bootstrap'),
    'defs must be passed through by reference, never rebuilt');
});

/**
 * The point of the feature, guarded as a number.
 *
 * mcp-catalog-size.test.ts measures the FULL built-in surface — what `admin` costs, and
 * the ceiling this repo is currently over. That number is worth keeping honest, but it
 * is not what a conversation pays once a profile is chosen. This is.
 */
test('basic costs a fraction of admin', () => {
  const B = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? ''), 'utf8');
  const bytes = (profile: string) =>
    applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], profile).reduce((s, d) => s + B(d), 0);

  const admin = bytes('admin');
  const basic = bytes('basic');

  assert.ok(basic < admin * 0.25,
    `basic must stay under a quarter of admin — basic ${basic}B vs admin ${admin}B (${Math.round(100 * basic / admin)}%)`);
  // Roughly 63K tokens back on every conversation, at ~4 bytes/token.
  assert.ok(admin - basic > 200_000,
    `the saving must stay material: ${admin - basic}B`);
});

// --- review findings, 2026-09-11 ---------------------------------------------------

test('an Object.prototype key is not a profile and cannot break tools/list', () => {
  // Found in review: `PROFILE_DEFINITIONS[name]` was a bare bracket lookup, so
  // "constructor" / "__proto__" / "toString" passed the name check, were WRITTEN to
  // disk, and the filter then threw inside tools/list — a persistent, node-wide
  // outage of the entire MCP surface from one POST.
  const { getProfile } = require('../mcp-server/registry/profiles') as typeof import('../mcp-server/registry/profiles');
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(getProfile(bad), undefined, `"${bad}" must not resolve to a profile`);
    // and the filter must fail OPEN, never throw
    const out = applyProfileToToolDefs(LM_ASSIST_TOOL_DEFS as any[], bad);
    assert.equal(out.length, LM_ASSIST_TOOL_DEFS.length, `"${bad}" must leave the surface untouched`);
  }
});

// --- 2026-09-23: `langmart` → `platform`, and request-scoped profile PINS -------------

function stateFile(): string {
  return path.join(DATA_DIR, `mcp-profile${isDevRepo() ? '-dev' : ''}.json`);
}
function resetNodeDefault(): void {
  fs.rmSync(stateFile(), { force: true });
  _resetProfileCacheForTests();
}

test('`langmart` is now `platform`, and the old name still resolves to it', () => {
  assert.ok(Object.hasOwn(PROFILE_DEFINITIONS, 'platform'));
  assert.ok(!Object.hasOwn(PROFILE_DEFINITIONS, 'langmart'), 'the retired name must not be a second definition');
  assert.equal(PROFILE_ALIASES.langmart, 'platform');
  assert.equal(canonicalProfileName('langmart'), 'platform');
  assert.equal(getProfile('langmart'), PROFILE_DEFINITIONS.platform);
  const defs = WITH_EXT.map((name) => ({ name }));
  assert.deepEqual(
    applyProfileToToolDefs(defs, 'langmart').map((d) => d.name),
    applyProfileToToolDefs(defs, 'platform').map((d) => d.name),
  );
});

test('every alias points at a real profile, is not one itself, and is a legal pin', () => {
  for (const [alias, target] of Object.entries(PROFILE_ALIASES)) {
    assert.ok(Object.hasOwn(PROFILE_DEFINITIONS, target), `alias "${alias}" points at nothing`);
    assert.ok(!Object.hasOwn(PROFILE_DEFINITIONS, alias), `alias "${alias}" shadows a real profile`);
    assert.ok(isValidPinSyntax(alias), `alias "${alias}" could never arrive as a pin`);
  }
});

test('every shipped profile name is a legal pin — otherwise it could never be pinned', () => {
  for (const name of Object.keys(PROFILE_DEFINITIONS)) assert.ok(isValidPinSyntax(name), name);
});

test('canonicalProfileName uses own keys on BOTH maps', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'no-such']) {
    assert.equal(canonicalProfileName(bad), undefined, JSON.stringify(bad));
  }
  for (const n of Object.keys(PROFILE_DEFINITIONS)) assert.equal(canonicalProfileName(n), n);
});

test('pin grammar: lowercase, starts with a letter, ≤32 chars, `connectors` reserved', () => {
  for (const ok of ['basic', 'a', 'platform', 'with-dash', 'x1', 'a'.repeat(32)]) {
    assert.equal(isValidPinSyntax(ok), true, ok);
  }
  for (const bad of ['', 'Basic', '1abc', '-x', 'with space', 'under_score', 'a'.repeat(33), 'connectors', 'basic/x', 'basic?x']) {
    assert.equal(isValidPinSyntax(bad), false, JSON.stringify(bad));
  }
});

test('resolveEffectiveProfile: no pin ⇒ the node default, with no pin fields at all', () => {
  resetNodeDefault();
  for (const none of [undefined, null, '', '   ']) {
    assert.deepEqual(resolveEffectiveProfile(none), { name: 'admin', source: 'node-default' }, JSON.stringify(none));
  }
});

test('resolveEffectiveProfile: a known pin wins, an alias resolves, the pin is kept as sent', () => {
  resetNodeDefault();
  assert.deepEqual(resolveEffectiveProfile('basic'), { name: 'basic', source: 'pin', pin: 'basic' });
  assert.deepEqual(resolveEffectiveProfile('langmart'), { name: 'platform', source: 'pin', pin: 'langmart' });
  assert.deepEqual(resolveEffectiveProfile(' extended '), { name: 'extended', source: 'pin', pin: 'extended' });
});

test('resolveEffectiveProfile: an unknown pin fails OPEN to the node default, flagged', () => {
  resetNodeDefault();
  for (const bad of ['basci', 'constructor', '__proto__', 'connectors', 'Basic']) {
    assert.deepEqual(
      resolveEffectiveProfile(bad),
      { name: 'admin', source: 'node-default', pin: bad, unknownPin: true },
      bad,
    );
  }
});

test('resolveEffectiveProfile: the echoed pin is bounded — printable ASCII, ≤64 chars', () => {
  const r = resolveEffectiveProfile('x\n\u0000'.repeat(40) + 'tail');
  assert.equal(r.unknownPin, true);
  assert.ok(r.pin!.length <= 64, `echo is ${r.pin!.length} chars`);
  assert.match(r.pin!, /^[\x20-\x7e]*$/);
});

test('a pin is request-scoped: it never reaches the node-default file or cache', () => {
  resetNodeDefault();
  setActiveProfile('basic', 'test');
  assert.equal(resolveEffectiveProfile('extended').name, 'extended');
  assert.equal(activeProfileName(), 'basic', 'the cache still holds the node default');
  _resetProfileCacheForTests();
  assert.equal(activeProfileName(), 'basic', 'and so does the file');
  assert.equal(readProfileState().profile, 'basic');
  assert.deepEqual(resolveEffectiveProfile(undefined), { name: 'basic', source: 'node-default' });
  assert.deepEqual(
    resolveEffectiveProfile('basci'),
    { name: 'basic', source: 'node-default', pin: 'basci', unknownPin: true },
    'an unknown pin falls back to the node default IN FORCE, not to admin',
  );
  resetNodeDefault();
});

test('the node-default file accepts the retired name and reports the current one', () => {
  resetNodeDefault();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ profile: 'langmart' }));
  _resetProfileCacheForTests();
  assert.equal(activeProfileName(), 'platform', 'a file written before the rename still selects the profile');
  resetNodeDefault();
  assert.equal(setActiveProfile('langmart', 'test').profile, 'platform', 'an alias is stored as its target');
  assert.equal(readProfileState().profile, 'platform');
  assert.equal(activeProfileName(), 'platform');
  resetNodeDefault();
});

test('liveEffectiveProfile keeps a pin and re-reads a node-default resolution', () => {
  resetNodeDefault();
  const pinned = resolveEffectiveProfile('extended');
  const unpinned = resolveEffectiveProfile(undefined);
  const unknown = resolveEffectiveProfile('basci');
  setActiveProfile('basic', 'test');
  assert.equal(liveEffectiveProfile(pinned), pinned, 'a pin is fixed for the life of its connector');
  assert.deepEqual(liveEffectiveProfile(unpinned), { name: 'basic', source: 'node-default' });
  assert.deepEqual(liveEffectiveProfile(unknown), { name: 'basic', source: 'node-default', pin: 'basci', unknownPin: true });
  assert.deepEqual(liveEffectiveProfile(undefined), { name: 'basic', source: 'node-default' });
  resetNodeDefault();
});

test('isNarrowedProfile / profileNeedsExtTools', () => {
  assert.equal(isNarrowedProfile('basic'), true);
  assert.equal(isNarrowedProfile('platform'), true);
  assert.equal(isNarrowedProfile('langmart'), true);
  assert.equal(isNarrowedProfile('extended'), true);
  assert.equal(isNarrowedProfile('admin'), false);
  assert.equal(isNarrowedProfile('no-such'), false, 'an unknown name serves everything — not narrowed');

  assert.equal(profileNeedsExtTools('basic'), false);
  assert.equal(profileNeedsExtTools('extended'), false);
  assert.equal(profileNeedsExtTools('platform'), true);
  assert.equal(profileNeedsExtTools('langmart'), true);
  assert.equal(profileNeedsExtTools('admin'), true);
  assert.equal(profileNeedsExtTools('no-such'), true, 'fail open');
  assert.equal(profileNeedsExtTools('constructor'), true, 'fail open, never a throw');
});

test('the pin transport names are fixed', () => {
  assert.equal(PROFILE_PIN_HEADER, 'x-lm-mcp-profile');
  assert.equal(PROFILE_PIN_ENV, 'LM_MCP_PROFILE');
});
