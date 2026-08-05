// Bootstrap routing at session start + the speak-names-not-ids rule.
// Design: docs/superpowers/specs/2026-07-25-bootstrap-session-start-routing-design.md
//
// The premise these tests defend: MCP has no session-start callback, so a session that
// never calls `bootstrap` must STILL receive the routing — through the auto-delivered
// `instructions` (layer 1) and through the per-result trailer (layer 2). If either
// regresses, the playbooks silently stop reaching sessions again, which is exactly the
// failure that produced this work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_TOOLS, playbookTopicForTool } from '../mcp-server/tool-topics';
import {
  formatResultOriginTag,
  resultCarriesIds,
  withOriginTag,
  NAMING_LINE,
} from '../mcp-server/result-origin';
import { LM_ASSIST_INSTRUCTIONS } from '../mcp-server/configure';
import { GUIDES_TEST_EXPORT, GUIDE_BLURBS, BOOTSTRAP_SECTION_ORDER } from '../mcp-server/tools/guide';
import { getContentCatalog } from '../mcp-server/registry/content-catalog';
import type { McpToolResult } from '../mcp-server/configure';

const textOf = (r: McpToolResult): string => String(r.content[0].text);
const textResult = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });

// ── tool → playbook mapping ────────────────────────────────────────────────

test('playbookTopicForTool — maps a tool to its governing playbook', () => {
  assert.equal(playbookTopicForTool('ccr_bridge_registry'), 'ccr');
  // pre-rename compat alias still routes to the ccr playbook
  assert.equal(playbookTopicForTool('ccr_remote_list'), 'ccr');
  assert.equal(playbookTopicForTool('data_get'), 'data');
  assert.equal(playbookTopicForTool('list_recent_sessions'), 'sessions');
  assert.equal(playbookTopicForTool('machine_access'), 'machine-access');
});

test('playbookTopicForTool — unmapped/absent names yield null, never a broken pointer', () => {
  assert.equal(playbookTopicForTool('bootstrap'), null);
  assert.equal(playbookTopicForTool('guide'), null);
  assert.equal(playbookTopicForTool('ext__mobile__mobile_speak'), null);
  assert.equal(playbookTopicForTool('no_such_tool'), null);
  assert.equal(playbookTopicForTool(''), null);
});

test('playbookTopicForTool — every tool named in TOPIC_TOOLS resolves to a real topic', () => {
  for (const [topic, tools] of Object.entries(TOPIC_TOOLS)) {
    assert.ok(GUIDES_TEST_EXPORT[topic], `topic "${topic}" has a playbook`);
    for (const tool of tools) {
      const resolved = playbookTopicForTool(tool);
      assert.ok(resolved, `${tool} resolves`);
      assert.ok(GUIDES_TEST_EXPORT[resolved], `${tool} → "${resolved}" is a real playbook`);
    }
  }
});

// ── layer 2: the result trailer ────────────────────────────────────────────

test('formatResultOriginTag — playbook folds into the tag, costing no extra line', () => {
  const parts = { hubHost: 'assist-api.langmart.ai', hostname: 'node-117', cluster: 'prod' };
  const withPlaybook = formatResultOriginTag(parts, true, 'ccr');
  assert.equal(
    withPlaybook,
    '⟦lm-assist@assist-api.langmart.ai · node:node-117 · cluster:prod · playbook: guide("ccr")⟧',
  );
  assert.equal(withPlaybook.split('\n').length, 1, 'still a single line');
  // Local form carries it too.
  assert.match(formatResultOriginTag(parts, false, 'data'), /· LOCAL ·.*playbook: guide\("data"\)⟧$/);
});

test('formatResultOriginTag — no topic ⇒ byte-identical to the pre-playbook tag', () => {
  const parts = { hubHost: 'assist-api.langmart.ai', hostname: 'node-117', cluster: 'prod' };
  assert.equal(
    formatResultOriginTag(parts, true),
    '⟦lm-assist@assist-api.langmart.ai · node:node-117 · cluster:prod⟧',
  );
  assert.equal(formatResultOriginTag(parts, true, null), formatResultOriginTag(parts, true));
});

test('resultCarriesIds — detects the id shapes lm-assist hands back', () => {
  assert.ok(resultCarriesIds('the bug is bl_2ec8bf24 and it is open'));
  assert.ok(resultCarriesIds('mission_38836df5'));
  assert.ok(resultCarriesIds('cse_01T4vuRjS5abcd'));
  assert.ok(resultCarriesIds('4e10ba65-1234-4abc-89ef-0123456789ab'));
  assert.ok(resultCarriesIds('node gw4-332c6620'));
});

test('resultCarriesIds — ordinary prose does not trip it', () => {
  assert.equal(resultCarriesIds('3 sessions are running on the prod node'), false);
  assert.equal(resultCarriesIds('the mission controller session, working in lm-assist'), false);
  // The origin tag's own node/cluster names must never look like ids.
  assert.equal(resultCarriesIds('⟦lm-assist · LOCAL · node:ubuntu-Virtual-Machine · cluster:prod⟧'), false);
});

test('withOriginTag — an id-bearing result gets the naming rule; a plain one does not', () => {
  const withIds = textOf(withOriginTag(textResult('found bl_2ec8bf24'), 'backlog_list'));
  assert.ok(withIds.includes(NAMING_LINE), 'naming line present when ids are present');
  assert.match(withIds, /never read an id aloud/);

  const plain = textOf(withOriginTag(textResult('2 nodes are online'), 'list_nodes'));
  assert.equal(plain.includes(NAMING_LINE), false, 'silent when there are no ids to misread');
});

test('withOriginTag — carries the playbook for the tool that just answered', () => {
  // The incident tool: its result now names the CCR playbook, so a session that never
  // bootstrapped can still find the cross-check flow.
  assert.match(textOf(withOriginTag(textResult('no sessions'), 'ccr_bridge_registry')), /playbook: guide\("ccr"\)/);
  // Unmapped tool ⇒ no pointer, and nothing broken.
  const unmapped = textOf(withOriginTag(textResult('hello'), 'no_such_tool'));
  assert.equal(/playbook:/.test(unmapped), false);
  assert.match(unmapped, /⟦lm-assist/);
});

test('withOriginTag — errors and identity-block results are still left alone', () => {
  const err: McpToolResult = { content: [{ type: 'text', text: 'Error: boom' }], isError: true };
  assert.equal(withOriginTag(err, 'data_get'), err);

  const identity = textResult('FLEET / CONNECTOR IDENTITY\nnode: x\nsession bl_2ec8bf24');
  const out = textOf(withOriginTag(identity, 'bootstrap'));
  assert.equal(out, 'FLEET / CONNECTOR IDENTITY\nnode: x\nsession bl_2ec8bf24', 'untouched');
  assert.equal(out.includes(NAMING_LINE), false);
});

// ── layer 1: the auto-delivered instructions ───────────────────────────────

test('instructions — carry situation→playbook routing for a session that never bootstraps', () => {
  assert.match(LM_ASSIST_INSTRUCTIONS, /FIRST, call the bootstrap tool/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /ROUTING/);
  // The incident's route: "what is running" must point at cc_sessions and warn that a
  // registry listing can be stale — the exact wrong turn taken in conversation 4e10ba65.
  assert.match(LM_ASSIST_INSTRUCTIONS, /cc_sessions/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /stale/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /guide\("sessions"\)/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /guide\("cross-node"\)/);
});

test('instructions — carry the speaking rule, so voice gets it without calling bootstrap', () => {
  assert.match(LM_ASSIST_INSTRUCTIONS, /SPEAKING \(voice\) never read one aloud/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /handles for TOOLS/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /guide\("speaking"\)/);
});

test('instructions — the pre-existing complements-your-local-context contract survives', () => {
  assert.ok(LM_ASSIST_INSTRUCTIONS.length > 300);
  assert.match(LM_ASSIST_INSTRUCTIONS, /COMPLEMENTS|complement/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /does NOT replace/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /work best TOGETHER/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /CLAUDE\.md/);
});

// ── layer 3: the fleet-editable content unit ───────────────────────────────

test('guide.speaking — ships in EVERY bootstrap, early, and is a real playbook', () => {
  assert.ok(GUIDES_TEST_EXPORT.speaking, 'the playbook exists');
  assert.ok(BOOTSTRAP_SECTION_ORDER.includes('speaking'), 'ships in bootstrap');
  assert.ok(
    BOOTSTRAP_SECTION_ORDER.indexOf('speaking') <= 2,
    'lands early — a rule about talking is useless if it arrives after the reply',
  );
  assert.ok(GUIDE_BLURBS.speaking, 'listed with a one-liner in the guide index');
});

test('guide.speaking — states the rule and keeps ids legitimate in text', () => {
  const body = GUIDES_TEST_EXPORT.speaking;
  assert.match(body, /never read an id aloud|never say an id/i);
  assert.match(body, /In TEXT, ids are fine/);
  assert.match(body, /NAME and WHAT IT IS ABOUT/i);
});

test('guide.speaking — is fleet-editable: enumerated in the content catalog', () => {
  // The catalog is generated from the guide exports, so a new topic must appear on
  // /assist-content automatically — that is what makes the rule editable with no deploy.
  const unit = getContentCatalog().get('guide.speaking');
  assert.ok(unit, 'catalogued');
  assert.equal(unit!.group, 'guide');
  assert.ok(unit!.renderedIn.includes('bootstrap'), 'rendered in bootstrap');
  assert.ok(unit!.renderedIn.includes('guide'), 'rendered in guide');
  assert.ok(unit!.defaultBody.length > 200, 'carries the real body');
});
