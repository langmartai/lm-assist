/**
 * Docs for one MCP connector per tool loading profile
 * (docs/superpowers/specs/2026-09-23-mcp-profile-connectors-design.md §10).
 *
 * Structural guards, not prose checks: the sections exist and every link into them resolves,
 * the endpoint rows are there, the CLAUDE.md index row keeps the index's three-cell shape, and
 * what the assist-mcp-tools README says about its grant is what the grant does. (That README
 * is written by the pane task; these tests pin it against the pane's real lmui.config.json.)
 *
 * Three regression guards:
 *  - These docs used to say the claude.ai connector is "provisioned automatically" once a node
 *    connects to the hub. No code did that. Claude Code's entry IS written by `lm-assist login`;
 *    a claude.ai connector is added once per account and connected in a browser. The claim must
 *    not come back.
 *  - `mcp_profile get` makes no claude.ai call (it is a protected, always-listed tool). The docs
 *    must send readers to `mcp_connectors {action:"list"}`, not promise per-profile status.
 *  - The per-request tools/list line goes to the Core log, not to mcp-calls.jsonl (a capped
 *    fleet dataset whose tool-call history it would push out).
 *
 * NOTE (Task 15 deviation from the task brief, recorded per task instructions): the task brief's
 * Step 1 draft of the api-endpoints test asserted `/mcp-tools/profile-connectors` rows. That
 * conflicts with this task's controller ruling (spec §7.3 amended d7a4d0c) and with the routes
 * Task 11 actually shipped (`core/src/routes/core/mcp-tools.routes.ts`): the routes are
 * `/mcp/profile-connectors` and `/mcp/profile-connectors/:profile`, documented next to the other
 * `/mcp/*` rows — not the `/mcp-tools/*` rows — because an older Core has no catch-all under
 * `/mcp/<x>` (a clean 404) while a one-segment path under `/mcp-tools` is read as a tool name.
 * Task 14's pane README (`ui-apps/assist-mcp-tools/README.md`) already documents this exact
 * routing choice for its grant. This test asserts the real, shipped path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { readDeclaredGrant, grantAllows } from '../ui-pages/local-tier/grants';

// dist-test/__tests__ → dist-test → core → repo root
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** GitHub's heading → anchor rule: lowercase; drop everything but letters, digits, spaces,
 *  `-` and `_`; each space becomes one `-` (runs are not collapsed). */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Anchors of every ATX heading outside fenced code blocks. */
function anchors(md: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

function assertLinkResolves(fromRel: string, href: string): void {
  const hash = href.indexOf('#');
  const file = hash === -1 ? href : href.slice(0, hash);
  const anchor = hash === -1 ? '' : href.slice(hash + 1);
  const target = file ? path.normalize(path.join(path.dirname(fromRel), file)) : fromRel;
  assert.ok(fs.existsSync(path.join(ROOT, target)), `${fromRel} links to ${target}, which does not exist`);
  if (anchor) {
    assert.ok(anchors(read(target)).has(anchor), `${fromRel} links to ${target}#${anchor}, which has no such heading`);
  }
}

/** Resolve every link in `rel` that points at a heading of mcp-connector.md or mcp-surfaces.md
 *  (or, inside mcp-connector.md, at one of its own headings). Returns how many there were. */
function checkProfileLinks(rel: string): number {
  const hrefs = [...read(rel).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((h) => /mcp-(connector|surfaces)\.md#/.test(h) || (h.startsWith('#') && rel === 'docs/mcp-connector.md'));
  for (const h of hrefs) assertLinkResolves(rel, h);
  return hrefs.length;
}

test('mcp-connector.md: "One connector per profile" — URL contract, create flow, Connect, one per conversation', () => {
  const md = read('docs/mcp-connector.md');
  assert.ok(anchors(md).has('one-connector-per-profile'), 'missing ## One connector per profile');
  assert.ok(anchors(md).has('adding-the-connector'), 'missing ## Adding the connector');
  for (const s of [
    '`https://mcp.<domain>/mcp/<profile>`',
    '`/mcp?profile=<profile>`',
    '`LM_MCP_PROFILE=<profile>`',
    '/.well-known/oauth-protected-resource/mcp/<profile>',
    '`/mcp/profile-connectors`',
    '`mcp_connectors`',
    '`lm-assist langmart basic`',
    'lm-assist mcp add --profile',
  ]) {
    assert.ok(md.includes(s), `mcp-connector.md is missing ${s}`);
  }
  assert.match(md, /\*Connect\*/, 'the browser Connect step is named');
  assert.match(md, /one per conversation/i);
  // The rename is stated where the profiles are listed.
  assert.match(md, /`platform`[^\n]*`langmart`/);
  assert.ok(checkProfileLinks('docs/mcp-connector.md') >= 2);
});

test('the docs tell the truth about adding the connector — no "provisioned automatically"', () => {
  const md = read('docs/mcp-connector.md');
  assert.ok(md.includes('`lm-assist login <keypack>`') && md.includes('`~/.claude.json`'),
    'the Claude Code entry IS written by lm-assist login — say so');
  assert.match(md, /once per account/i);
  const FALSE_CLAIM = /provisioned (automatically|for you|on the hub)|auto-provision|installed for you|provisioned after the hub connect/i;
  for (const rel of ['docs/mcp-connector.md', 'docs/README.md', 'README.md', 'examples/mcp-connector-install/README.md']) {
    const lines = read(rel).split('\n');
    const hit = lines.findIndex((l) => FALSE_CLAIM.test(l));
    assert.equal(hit, -1, `${rel}:${hit + 1} still claims the connector is provisioned for you: ${lines[hit] ?? ''}`);
  }
  assert.ok(checkProfileLinks('examples/mcp-connector-install/README.md') >= 1);
});

test('mcp-surfaces.md: the pin — resolution, threading, hot path, byte identity, advertise-only', () => {
  const md = read('docs/mcp-surfaces.md');
  assert.ok(anchors(md).has('tool-loading-profiles-and-the-per-request-pin'));
  for (const s of [
    'resolveEffectiveProfile', 'canonicalProfileName', 'isValidPinSyntax', 'parseProfilePin',
    'runWithMcpContext', 'currentEffectiveProfile', 'liveEffectiveProfile', 'LM_MCP_PROFILE',
    'x-lm-mcp-profile', 'profileNeedsExtTools', 'gateKeyFor', 'isNarrowedProfile',
    'result-origin.test.ts', 'fleet-identity.test.ts', 'session-start-routing.test.ts',
  ]) {
    assert.ok(md.includes(s), `mcp-surfaces.md is missing ${s}`);
  }
  assert.match(md, /byte-identical/i);
  assert.match(md, /advertise-only/i);
  // The tools/list line goes to the Core log, and says so.
  assert.ok(md.includes('`[mcp] tools/list`'), 'names the Core-log line prefix');
  assert.match(md, /does NOT go to `mcp-calls\.jsonl`/);
  // mcp_profile get makes no claude.ai call; it points at mcp_connectors.
  assert.ok(md.includes('`connectorsHint`'));
  assert.ok(md.includes('`mcp_connectors {action:"list"}`'));
  assert.doesNotMatch(md, /whether a claude\.ai connector exists/i);
  assert.ok(checkProfileLinks('docs/mcp-surfaces.md') >= 1);
});

test('api-endpoints.md: rows for the profile-connector routes and the /mcp ?profile= pin', () => {
  const md = read('docs/api-endpoints.md');
  assert.match(md, /^\| GET \| `\/mcp\/profile-connectors` \|/m);
  assert.match(md, /^\| POST \| `\/mcp\/profile-connectors` \|/m);
  assert.match(md, /^\| DELETE \| `\/mcp\/profile-connectors\/:profile` \|/m);
  assert.match(md, /^\| [A-Z, ]+ \| `\/mcp\?profile=<name>` \|/m);
  assert.ok(checkProfileLinks('docs/api-endpoints.md') >= 2);
});

test('CLAUDE.md: one index row — the index shape, the triggers, the tripwire, a link that resolves', () => {
  const claude = read('CLAUDE.md');
  const rows = claude.split('\n').filter((l) => l.startsWith('| [MCP profiles'));
  assert.equal(rows.length, 1, 'exactly one index row');
  const row = rows[0];
  assert.ok(row.endsWith(' |'), 'row ends with " |"');
  const cells = row.slice(2, -2).split(' | ');
  assert.equal(cells.length, 3, 'topic | triggers | tripwire — a stray pipe splits the row');
  const [topic, triggers, tripwire] = cells;
  const href = /^\[[^\]]+\]\(([^)]+)\)$/.exec(topic)?.[1];
  assert.ok(href, 'topic cell is a plain markdown link (never an @import)');
  assertLinkResolves('CLAUDE.md', href);
  for (const t of ['`mcp_profile`', '`?profile=`', '`LM_MCP_PROFILE`', '`profile-connectors`', '`mcp_connectors`', '"one connector per profile"']) {
    assert.ok(triggers.includes(t), `trigger ${t}`);
  }
  assert.match(tripwire, /advertise-only/i);
  assert.match(tripwire, /byte-identical/i);
  assert.match(tripwire, /silently/i);
  // The index's own rule: it is loaded into every session and must stay under 40 KB.
  assert.ok(Buffer.byteLength(claude) < 40_000, `CLAUDE.md is ${Buffer.byteLength(claude)} bytes`);
});

test('README.md: a line pointing at "One connector per profile"', () => {
  assert.ok(checkProfileLinks('README.md') >= 1);
  assert.match(read('README.md'), /`https:\/\/mcp\.<domain>\/mcp\/<profile>`/);
});

test('assist-mcp-tools README: its grant block IS the pane grant, the rule count in words, no "node-global" profile', () => {
  const md = read('ui-apps/assist-mcp-tools/README.md');
  const block = /## Grant\s+```json\n([\s\S]*?)\n```/.exec(md)?.[1];
  assert.ok(block, 'the README carries a ```json grant block under ## Grant');
  const config = JSON.parse(read('ui-apps/assist-mcp-tools/lmui.config.json')) as { grant: unknown[] };
  assert.deepEqual(JSON.parse(block), config.grant, 'README grant block must be lmui.config.json grant, verbatim and in order');
  const WORDS: Record<number, string> = { 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen' };
  const word = WORDS[config.grant.length];
  assert.ok(word, `add a word for ${config.grant.length}`);
  assert.ok(md.includes(`these ${word} rules`), `README says "these ${word} rules"`);
  assert.ok(md.includes(`the ${word} rules are evaluated`), `README says "the ${word} rules are evaluated"`);
  assert.ok(md.includes('/mcp/profile-connectors'));
  assert.doesNotMatch(md, /\*\*node-global\*\*/, 'the profile is the node DEFAULT now, not node-global');
});

test('assist-mcp-tools README: its profile-connector grant claims hold under the real evaluator', () => {
  const grant = readDeclaredGrant(path.join(ROOT, 'ui-apps', 'assist-mcp-tools'));
  const cases: Array<[string, string, boolean]> = [
    ['GET', '/mcp/profile-connectors', true],
    ['POST', '/mcp/profile-connectors', true],
    ['DELETE', '/mcp/profile-connectors/basic', true],
    ['DELETE', '/mcp/profile-connectors', false],
    ['DELETE', '/mcp/profile-connectors/basic/extra', false],
    ['POST', '/claude-ai/mcp/servers', false],
  ];
  for (const [verb, p, want] of cases) {
    assert.equal(grantAllows(grant, 'node', p, verb), want, `${verb} ${p} should be ${want ? 'allowed' : 'denied'}`);
  }
});
