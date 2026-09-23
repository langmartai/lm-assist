/**
 * Profile-aware bootstrap and guide (one connector per profile, spec §6).
 *
 * Under the EFFECTIVE profile (the call's pin, else the node default):
 *   - a section is left out when the profile hides ALL of its governed tools;
 *   - the manifest lists what was delivered;
 *   - one closing line names what is hidden and where it lives. WHERE depends on the
 *     profile's source: under a pin, the unpinned or `admin` connector; under the node
 *     default, the unpinned connector is this narrowed one, so an `admin`-pinned connector;
 *   - the claude.ai-first mandate appears only when the profile lists
 *     `list_claudeai_conversations`.
 * The identity block at the top of page 1 stays profile-unaware.
 *
 * 🔴 The compatibility contract comes first: no pin + node default `admin` must be
 * byte-identical to the pre-profile builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GUIDE_HANDLERS, GUIDES_TEST_EXPORT, BOOTSTRAP_SECTION_ORDER, BOOTSTRAP_HEADER_DEFAULT,
  INDEX_PREAMBLE_DEFAULT, BOOTSTRAP_WRAP_RESERVE, CLAUDEAI_MANDATE_SWAPS,
  bootstrapEntries, paginateEntries, buildBootstrapPage, bootstrapProfileView, sectionGovernedTools,
  profileHiddenLine, type BootstrapProfileView,
} from '../mcp-server/tools/guide';
import { fleetIdentity } from '../mcp-server/fleet-identity';
import { runWithMcpContext } from '../mcp-server/principal-context';
import {
  resolveEffectiveProfile, getProfile, resolveProfileTools, setActiveProfile, _resetProfileCacheForTests,
  type EffectiveProfile,
} from '../mcp-server/registry/profiles';
import { capToolResult, maxResultBytes } from '../mcp-server/result-cap';

// Keep the operator's real node-default file out of this test. getDataDir() is read
// lazily, so setting the env var here, before the first bootstrap call, takes effect.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bprof-'));
_resetProfileCacheForTests();

const BASIC = resolveEffectiveProfile('basic');
const EXTENDED = resolveEffectiveProfile('extended');
const ADMIN_PIN = resolveEffectiveProfile('admin');

/** sha256 of the PRE-profile builder's full output: every page, fixed identity/auth/cluster,
 *  no content overrides, the default 64 KiB ceiling — rendered exactly as renderFixed()
 *  below does with `view` undefined. Measured on the pre-profile guide.ts at 536d6a6 and
 *  re-checked at d78c159. It pins "admin ⇒ byte-identical to today" across all 25
 *  sections, the header, the manifest and the footers. Re-pin it only when guide prose is
 *  changed on purpose, from that change's parent. */
const PRE_PROFILE_SHA256 = 'edb76bb1151169d972025e6ebf6dc35cdf68f64dbd601b2140887d6e5e7aa4e6';

/** A claude.ai-first mandate, in any of the four wordings the defaults use. */
const MANDATE = /FIRST[^\n]*`list_claudeai_conversations`|`list_claudeai_conversations` FIRST|start with `list_claudeai_conversations`/;

const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const heading = (k: string): string => GUIDES_TEST_EXPORT[k].split('\n')[0];
const under = <T>(profile: EffectiveProfile, fn: () => Promise<T>): Promise<T> =>
  runWithMcpContext({ principal: { type: 'local' }, profile }, fn);
const guideText = async (args: Record<string, unknown>): Promise<string> =>
  (await GUIDE_HANDLERS.guide(args)).content[0].text as string;

async function bootstrapPages(): Promise<string[]> {
  const first = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  const n = parseInt(first.match(/page 1 of (\d+)/i)?.[1] ?? '1', 10);
  const pages = [first];
  for (let p = 2; p <= n; p++) pages.push((await GUIDE_HANDLERS.bootstrap({ page: p })).content[0].text as string);
  return pages;
}

/** The manifest block on page 1 (from its heading to the first section separator), and
 *  its `- \`topic\` … (pN)` entries. */
function manifestOf(p1: string): { block: string; entries: Array<{ key: string; page: number }> } {
  const start = p1.indexOf('## Manifest — ');
  assert.ok(start >= 0, 'page 1 carries a manifest');
  const end = p1.indexOf('\n\n---\n\n', start);
  const block = p1.slice(start, end < 0 ? undefined : end);
  const entries = [...block.matchAll(/^- `([a-z-]+)`.*\(p(\d+)\)$/gm)].map((m) => ({ key: m[1], page: Number(m[2]) }));
  return { block, entries };
}

/** Render every page through the pure builder with fixed wrapper parts. With `view`
 *  undefined this calls the builders exactly as the pre-profile handler did. */
function renderFixed(view?: BootstrapProfileView | null): string {
  const entries = view === undefined ? bootstrapEntries(null) : bootstrapEntries(null, view);
  const pages = paginateEntries(entries, maxResultBytes() - BOOTSTRAP_WRAP_RESERVE);
  return pages
    .map((_, i) => buildBootstrapPage(i + 1, {
      entries, pages, lookup: null, identity: 'ID', auth: '\nAUTH', cluster: '\nCL',
      ...(view === undefined ? {} : { view }),
    }))
    .join('\n=====\n');
}

test('no pin + node default admin: the builder is byte-identical to the pre-profile one', () => {
  const prev = process.env.MCP_RESULT_MAX_BYTES;
  delete process.env.MCP_RESULT_MAX_BYTES;
  try {
    assert.equal(bootstrapProfileView('admin'), null, 'admin hides nothing ⇒ no view ⇒ the pre-profile path');
    assert.equal(sha(renderFixed()), PRE_PROFILE_SHA256);
    assert.equal(sha(renderFixed(bootstrapProfileView('admin'))), PRE_PROFILE_SHA256);
  } finally {
    if (prev === undefined) delete process.env.MCP_RESULT_MAX_BYTES; else process.env.MCP_RESULT_MAX_BYTES = prev;
  }
});

test('the handlers serve identical bytes with no context, the node default, and an admin pin', async () => {
  const plain = await bootstrapPages();
  assert.deepEqual(await under(resolveEffectiveProfile(undefined), bootstrapPages), plain);
  assert.deepEqual(await under(ADMIN_PIN, bootstrapPages), plain);
  assert.equal(manifestOf(plain[0]).entries.length, BOOTSTRAP_SECTION_ORDER.length, 'admin delivers every section');
  assert.doesNotMatch(plain.join('\n'), /hides these tool categories/);
  const index = await guideText({});
  assert.equal(await under(ADMIN_PIN, () => guideText({})), index);
  assert.doesNotMatch(index, /hides these tool categories/);
});

test('basic leaves out exactly the sections whose governed tools it hides ALL of', () => {
  const view = bootstrapProfileView('basic');
  assert.ok(view, 'basic narrows ⇒ a view');
  const def = getProfile('basic')!;
  for (const k of BOOTSTRAP_SECTION_ORDER) {
    const governed = sectionGovernedTools(k);
    const allHidden = governed.length > 0 && resolveProfileTools(def, governed).size === 0;
    assert.equal(view.omitted.includes(k), allHidden, `section "${k}" (governs ${governed.length} tools)`);
  }
  for (const k of ['missions', 'data', 'agents', 'ccr', 'claude-ai', 'desktop', 'login', 'roles', 'clusters', 'machine-access']) {
    assert.ok(view.omitted.includes(k), `basic must leave out "${k}"`);
  }
  // terminals is KEPT: it also governs send_session_message / get_message_status, which
  // are `session` tools that basic lists. A partly hidden section is delivered.
  for (const k of ['orientation', 'speaking', 'cross-node', 'connectors', 'workflows', 'sessions', 'knowledge', 'nodes', 'terminals']) {
    assert.ok(!view.omitted.includes(k), `basic must keep "${k}"`);
  }
  assert.equal(view.claudeAiListed, false);
  for (const c of ['mission', 'terminal', 'claudeai', 'desktop']) assert.ok(view.hiddenCategories.includes(c), `hides ${c}`);
  // fleet is only partly hidden: basic pulls list_nodes in by name.
  for (const c of ['core', 'session', 'memory', 'backlog', 'fleet']) assert.ok(!view.hiddenCategories.includes(c), `lists ${c}`);
});

test('extended leaves out only the playbooks for the connector surfaces it hides', () => {
  const view = bootstrapProfileView('extended');
  assert.ok(view);
  for (const k of ['desktop', 'claude-ai', 'ui-pages']) assert.ok(view.omitted.includes(k), `extended must leave out "${k}"`);
  for (const k of ['missions', 'terminals', 'data', 'ccr', 'agents', 'account', 'login', 'clusters']) {
    assert.ok(!view.omitted.includes(k), `extended must keep "${k}"`);
  }
});

test('an unknown or prototype-key name yields no view (fail open to the full bootstrap)', () => {
  for (const n of ['no-such-profile', 'constructor', '__proto__', 'toString']) assert.equal(bootstrapProfileView(n), null, n);
});

test('under a basic pin the manifest lists exactly what was delivered, each on the page it names', async () => {
  const view = bootstrapProfileView('basic')!;
  const pages = await under(BASIC, bootstrapPages);
  // The identity block stays profile-unaware (the banner, session_status, the footer and
  // the closing manifest line carry the profile): page 1 still opens with the unpinned block.
  assert.ok(pages[0].startsWith(fleetIdentity()), 'page 1 opens with the profile-unaware identity block');
  const { block, entries } = manifestOf(pages[0]);
  const expected = BOOTSTRAP_SECTION_ORDER.filter((k) => GUIDES_TEST_EXPORT[k] && !view.omitted.includes(k));
  assert.deepEqual(entries.map((e) => e.key), expected);
  assert.match(block, new RegExp(`^## Manifest — ${expected.length} topics across ${pages.length} pages?$`, 'm'));
  for (const { key, page } of entries) {
    assert.ok(pages[page - 1]?.includes(heading(key)), `"${key}" is on the page the manifest names (p${page})`);
  }
  for (const key of view.omitted) {
    for (const p of pages) assert.ok(!p.includes(heading(key)), `left-out section "${key}" must not be delivered`);
  }
});

test('one closing line names the hidden categories, the left-out playbooks and the connector that has them', async () => {
  const view = bootstrapProfileView('basic')!;
  const { block } = manifestOf((await under(BASIC, bootstrapPages))[0]);
  const last = block.trimEnd().split('\n').pop()!;
  assert.match(last, /^🔒 Profile `basic` hides these tool categories: /);
  assert.ok(last.includes(`hides these tool categories: ${view.hiddenCategories.join(', ')}.`), 'every hidden category, in order');
  assert.ok(last.includes(`Playbooks left out of bootstrap: ${view.omitted.join(', ')}.`), 'every left-out playbook, in order');
  assert.match(last, /unpinned or `admin` lm-assist connector/);
  assert.equal(block.split('\n').filter((l) => l.startsWith('🔒')).length, 1, 'exactly one closing line');
  // The guide index keeps every topic (guide(topic) serves any of them) and ends with the same line.
  const index = await under(BASIC, () => guideText({}));
  assert.equal(index.trimEnd().split('\n').pop(), last);
});

test('the pointer follows the profile SOURCE: a pin names the unpinned connector, a node default an admin-pinned one', () => {
  const pin = bootstrapProfileView('basic', 'pin')!;
  const nd = bootstrapProfileView('basic', 'node-default')!;
  assert.ok(pin && nd);
  assert.equal(bootstrapProfileView('basic'), pin, 'no source ⇒ the pin view (memoised: the same object)');
  assert.equal(bootstrapProfileView('basic', 'node-default'), nd, 'memoised per (name, source)');
  assert.equal(pin.source, 'pin');
  assert.equal(nd.source, 'node-default');
  assert.deepEqual({ ...nd, source: 'pin' }, pin, 'the source changes only the pointer, never what is left out');
  assert.equal(bootstrapProfileView('admin', 'node-default'), null, 'admin has no view from either source');

  const head = `🔒 Profile \`basic\` hides these tool categories: ${pin.hiddenCategories.join(', ')}. Playbooks left out of bootstrap: ${pin.omitted.join(', ')}.`;
  const pinLine = profileHiddenLine(pin);
  const ndLine = profileHiddenLine(nd);
  assert.ok(pinLine.startsWith(head) && ndLine.startsWith(head), 'the same categories and playbooks either way');
  assert.match(pinLine, /The unpinned or `admin` lm-assist connector on this hub lists them/);
  // Under the node default the unpinned connector IS this narrowed one (the banner says
  // `[node default]`), so the line must not send the model there.
  assert.doesNotMatch(ndLine, /unpinned or `admin`/);
  assert.match(ndLine, /`basic` is this node's DEFAULT profile, so the unpinned connector is narrowed the same way/);
  assert.match(ndLine, /an `admin`-pinned lm-assist connector on this hub \(URL …\/mcp\/admin\) lists them/);
  assert.match(ndLine, /`mcp_profile set admin` widens the node default/);
});

test('the claude.ai-first mandate appears only when the profile lists list_claudeai_conversations', async () => {
  assert.match((await bootstrapPages()).join('\n'), MANDATE, 'admin keeps the mandate');
  assert.match(await guideText({}), MANDATE, 'admin guide index keeps the mandate');
  for (const p of [BASIC, EXTENDED]) {
    const all = (await under(p, bootstrapPages)).join('\n');
    assert.doesNotMatch(all, MANDATE, `${p.name}: bootstrap must not mandate a tool it does not list`);
    assert.match(all, /unpinned or `admin` lm-assist connector/);
    assert.doesNotMatch(await under(p, () => guideText({})), MANDATE, `${p.name}: guide index`);
    assert.doesNotMatch(await under(p, () => guideText({ topic: 'speaking' })), MANDATE, `${p.name}: guide("speaking")`);
    assert.doesNotMatch(await under(p, () => guideText({ topic: 'sessions' })), MANDATE, `${p.name}: guide("sessions")`);
  }
});

test('every mandate swap targets a sentence its default still contains (edit both together)', () => {
  const sources: Record<string, string> = {
    'bootstrap.header': BOOTSTRAP_HEADER_DEFAULT,
    'guide.speaking': GUIDES_TEST_EXPORT.speaking,
    'guide.sessions': GUIDES_TEST_EXPORT.sessions,
    'guide.index': INDEX_PREAMBLE_DEFAULT,
  };
  for (const s of CLAUDEAI_MANDATE_SWAPS) {
    assert.ok(sources[s.where]?.includes(s.from), `${s.where} no longer contains its mandate sentence`);
    assert.deepEqual(Object.keys(s.to).sort(), ['node-default', 'pin'], `${s.where}: one replacement per profile source`);
    for (const [src, to] of Object.entries(s.to)) {
      assert.doesNotMatch(to, /list_claudeai_conversations/, `${s.where} (${src}): the replacement must not name the hidden tool`);
    }
    assert.match(s.to.pin, /the unpinned or `admin` lm-assist connector/, `${s.where}: a pin points at the unpinned or admin connector`);
    // Under the node default the unpinned connector IS this narrowed one: never point at it.
    assert.doesNotMatch(s.to['node-default'], /unpinned or `admin`/, `${s.where}: the node-default text must not send the model to the unpinned connector`);
    assert.match(s.to['node-default'], /an `admin`-pinned lm-assist connector/, `${s.where}: the node-default text names an admin-pinned connector`);
    assert.match(s.to['node-default'], /…\/mcp\/admin/, `${s.where}: and its URL form`);
  }
  assert.deepEqual(CLAUDEAI_MANDATE_SWAPS.map((s) => s.where).sort(), Object.keys(sources).sort());
});

test('every narrowed bootstrap page stays under the result ceiling', async () => {
  // Both sources: the node-default pointer text is longer than the pin one.
  const asNodeDefault = (p: EffectiveProfile): EffectiveProfile => ({ name: p.name, source: 'node-default' });
  for (const p of [BASIC, EXTENDED, asNodeDefault(BASIC), asNodeDefault(EXTENDED)]) {
    for (const [i, page] of (await under(p, bootstrapPages)).entries()) {
      const { size } = capToolResult({ content: [{ type: 'text', text: page }] } as any, 'bootstrap');
      assert.equal(size.truncated, false, `${p.name} (${p.source}) page ${i + 1} must fit under the ceiling`);
    }
  }
});

test('no pin + node default narrowed to basic ⇒ the same sections as a basic pin, but the pointer names an admin-pinned connector; an admin pin still gets everything', async () => {
  setActiveProfile('basic', 'test');
  try {
    const plain = await bootstrapPages();
    const pinned = await under(BASIC, bootstrapPages);
    const pinView = bootstrapProfileView('basic', 'pin')!;
    const ndView = bootstrapProfileView('basic', 'node-default')!;
    // Same sections, manifest and pages as a basic pin: ONLY the pointer text differs.
    const asPinned = (s: string): string => {
      let out = s.split(profileHiddenLine(ndView)).join(profileHiddenLine(pinView));
      for (const sw of CLAUDEAI_MANDATE_SWAPS) out = out.split(sw.to['node-default']).join(sw.to.pin);
      return out;
    };
    assert.deepEqual(plain.map(asPinned), pinned, 'the same sections, manifest and pages as a basic pin');
    assert.notDeepEqual(plain, pinned, 'but a different pointer');

    // The unpinned connector IS this narrowed one here: nothing may send the model to it.
    const last = manifestOf(plain[0]).block.trimEnd().split('\n').pop()!;
    assert.equal(last, profileHiddenLine(ndView));
    assert.match(last, /^🔒 Profile `basic` hides these tool categories: /);
    assert.match(last, /`basic` is this node's DEFAULT profile/);
    assert.match(last, /`admin`-pinned lm-assist connector on this hub \(URL …\/mcp\/admin\)/);
    assert.match(last, /`mcp_profile set admin`/);
    const all = plain.join('\n');
    assert.doesNotMatch(all, /unpinned or `admin`/, 'bootstrap must not point at the unpinned connector');
    assert.doesNotMatch(all, MANDATE);
    assert.match(all, /read an unqualified "the conversation" \/ "the most recent one" through an `admin`-pinned lm-assist connector/);
    for (const args of [{}, { topic: 'speaking' }, { topic: 'sessions' }]) {
      const g = await guideText(args);
      const label = `guide(${JSON.stringify(args)})`;
      assert.doesNotMatch(g, /unpinned or `admin`/, `${label} must not point at the unpinned connector`);
      assert.doesNotMatch(g, MANDATE, label);
      assert.match(g, /an `admin`-pinned lm-assist connector/, label);
    }
    assert.equal((await guideText({})).trimEnd().split('\n').pop(), last, 'the guide index closes with the same line');

    // An unknown pin is served the node default (source 'node-default'): the same pointer.
    const typo = resolveEffectiveProfile('basci');
    assert.equal(typo.unknownPin, true);
    assert.equal(typo.source, 'node-default');
    assert.equal(typo.name, 'basic');
    assert.deepEqual(await under(typo, bootstrapPages), plain);

    // A basic PIN on the same node keeps the pin wording.
    assert.match(pinned.join('\n'), /unpinned or `admin` lm-assist connector/);
    const adminPinned = await under(ADMIN_PIN, bootstrapPages);
    assert.equal(manifestOf(adminPinned[0]).entries.length, BOOTSTRAP_SECTION_ORDER.length, 'the pin wins over the node default');
  } finally {
    setActiveProfile('admin', 'test');
    _resetProfileCacheForTests();
  }
});
