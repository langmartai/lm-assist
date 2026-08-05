/**
 * Bootstrap gate (soft-block once) — the decision core and its refusal text.
 *
 * The behavior under test: a playbook-governed tool called by a caller that
 * never bootstrapped is refused ONCE with the instruction to bootstrap; every
 * uncertainty (unknown caller, degraded resolution, exempt tool, no topic)
 * fails OPEN. The pure core takes the registry as a lookup fn, so these tests
 * need no live resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBootstrapGate,
  buildBootstrapRefusal,
  bootstrapGateCheck,
  GATE_EXEMPT_TOOLS,
  type CallerCandidates,
} from '../mcp-server/mcp-session-resolver';
import { playbookTopicForTool } from '../mcp-server/tool-topics';

type St = { bootstrappedAt?: number; gateRefusedAt?: number };
const reg = (m: Record<string, St>) => (id: string): St | undefined => m[id];
const caller = (over: Partial<CallerCandidates> = {}): CallerCandidates =>
  ({ claudeAi: { id: 'conv-1' }, resolvedAt: Date.now(), ...over });

test('uncovered tool never blocks (no playbook topic)', () => {
  for (const name of ['bootstrap', 'guide', 'session_status', 'no_such_tool', 'ext__mobile__mobile_speak']) {
    const v = evaluateBootstrapGate(name, playbookTopicForTool(name), caller(), reg({}));
    assert.equal(v.block, false, name);
    assert.equal(v.reason, 'not-covered', name);
  }
});

test('exempt stdio-surface tools never block despite having a topic', () => {
  for (const name of GATE_EXEMPT_TOOLS) {
    const topic = playbookTopicForTool(name);
    assert.ok(topic, `${name} is expected to be topic-mapped — if it lost its topic, the exemption is dead code`);
    const v = evaluateBootstrapGate(name, topic, caller(), reg({}));
    assert.equal(v.block, false, name);
    assert.equal(v.reason, 'exempt', name);
  }
});

test('unknown or degraded identity fails open', () => {
  const topic = playbookTopicForTool('mission_list');
  assert.equal(evaluateBootstrapGate('mission_list', topic, null, reg({})).block, false);
  assert.equal(evaluateBootstrapGate('mission_list', topic, caller({ degraded: true }), reg({})).block, false);
  const noCands: CallerCandidates = { resolvedAt: Date.now() };
  assert.equal(evaluateBootstrapGate('mission_list', topic, noCands, reg({})).reason, 'no-identity');
});

test('a bootstrapped candidate silences the gate — including when only ONE of two candidates bootstrapped', () => {
  const topic = playbookTopicForTool('mission_list');
  const both = caller({ claudeCode: { id: 'sess-9' } });
  assert.equal(evaluateBootstrapGate('mission_list', topic, both, reg({ 'conv-1': { bootstrappedAt: 1 } })).reason, 'bootstrapped');
  assert.equal(evaluateBootstrapGate('mission_list', topic, both, reg({ 'sess-9': { bootstrappedAt: 1 } })).reason, 'bootstrapped');
});

test('first offence blocks; a previously-refused caller proceeds (soft-block ONCE)', () => {
  const topic = playbookTopicForTool('mission_list');
  const first = evaluateBootstrapGate('mission_list', topic, caller(), reg({}));
  assert.equal(first.block, true);
  assert.equal(first.reason, 'first-offence');
  assert.equal(first.topic, 'missions');
  const second = evaluateBootstrapGate('mission_list', topic, caller(), reg({ 'conv-1': { gateRefusedAt: 1 } }));
  assert.equal(second.block, false);
  assert.equal(second.reason, 'already-refused');
});

test('the refusal instructs bootstrap + names the playbook, and is an error result', () => {
  const r = buildBootstrapRefusal('ccr_live_list', 'ccr');
  assert.equal(r.isError, true);
  const text = String((r.content[0] as { text: string }).text);
  assert.match(text, /BOOTSTRAP_REQUIRED/);
  assert.match(text, /bootstrap\(\)/);
  assert.match(text, /guide\("ccr"\)/);
  assert.match(text, /ccr_live_list/);
  // The fail-open retry is a safety property, not an advertised bypass.
  assert.doesNotMatch(text, /retry (will|would) (proceed|succeed|work)/i);
});

test('LM_BOOTSTRAP_GATE=off short-circuits the seam hook without touching the resolver', async () => {
  const prev = process.env.LM_BOOTSTRAP_GATE;
  process.env.LM_BOOTSTRAP_GATE = 'off';
  try {
    assert.equal(await bootstrapGateCheck('mission_list'), null);
  } finally {
    if (prev === undefined) delete process.env.LM_BOOTSTRAP_GATE; else process.env.LM_BOOTSTRAP_GATE = prev;
  }
});

test('uncovered tools skip the seam hook entirely (no resolution cost)', async () => {
  // bootstrap/guide have no topic — the hook must return null without needing identity.
  assert.equal(await bootstrapGateCheck('bootstrap'), null);
  assert.equal(await bootstrapGateCheck('guide'), null);
  assert.equal(await bootstrapGateCheck('search'), null);
});
