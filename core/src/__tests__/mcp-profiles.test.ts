/**
 * MCP tool loading profiles: which tools a node ADVERTISES.
 *
 * The invariants that matter are the ones that keep a narrowed surface usable — the
 * door back out, and the orientation tool the `node` selector tells every caller to
 * use. Getting either wrong strands a session in a profile it cannot leave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_DEFINITIONS, DEFAULT_PROFILE, resolveProfileTools, applyProfileToToolDefs,
  unmatchedSelectors, knownSelectors,
} from '../mcp-server/registry/profiles';
import { PROTECTED_TOOLS } from '../mcp-server/registry/model';
import { LM_ASSIST_TOOL_DEFS } from '../mcp-server/configure';

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
  const keep = resolveProfileTools(PROFILE_DEFINITIONS.langmart, WITH_EXT);
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
