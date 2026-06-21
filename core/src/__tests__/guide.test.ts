import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDE_TOOL_DEFS } from '../mcp-server/tools/guide';
import { LM_ASSIST_INSTRUCTIONS } from '../mcp-server/configure';

/**
 * `guide` ships the lm-assist "skill" THROUGH the connector (skills may not be locally
 * installed, but the connector is always reachable): an LLM calls it to learn the recipe
 * for using the other tools instead of reverse-engineering their descriptions.
 */
const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

test('bootstrap loads ALL use cases in one response (proactive, not per-topic)', async () => {
  const t = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(t, /capability bootstrap/i);
  // every playbook is present in the single response
  assert.match(t, /Guide: orientation/);
  assert.match(t, /single-node vs cross-node/);
  assert.match(t, /combination workflows/);
  for (const feature of ['data service', 'investigate a Claude Code session', 'run a Claude Code agent', 'drive a terminal']) {
    assert.match(t, new RegExp(feature, 'i'), `bootstrap includes ${feature}`);
  }
  assert.ok(t.length > 8000, 'bootstrap is the full set'); // ~everything at once
});

test('bootstrap tool is advertised read-only with no required args', () => {
  const def = GUIDE_TOOL_DEFS.find((d) => d.name === 'bootstrap');
  assert.ok(def, 'bootstrap def present');
  assert.equal((def as any).annotations.readOnlyHint, true);
  assert.deepEqual((def as any).inputSchema.required, []);
});

test('server instructions actively direct the LLM to bootstrap FIRST', () => {
  assert.match(LM_ASSIST_INSTRUCTIONS, /FIRST, call the bootstrap tool/);
});

test('no topic → the index lists every use-case topic + golden rules', async () => {
  const t = await text({});
  assert.match(t, /playbooks/i);
  assert.match(t, /Golden rules/);
  for (const topic of ['sessions', 'knowledge', 'data', 'agents', 'terminals', 'nodes', 'claude-ai', 'account', 'github', 'files']) {
    assert.match(t, new RegExp('`' + topic + '`'), `index should list ${topic}`);
  }
});

test('a topic returns its concrete playbook', async () => {
  const t = await text({ topic: 'data' });
  assert.match(t, /Guide: data service/);
  assert.match(t, /data_request_access/); // the key step a cloud caller must not miss
  assert.match(t, /KEY_REQUIRED/);
});

test('a tool name resolves to the owning topic (guide("data_get") → data)', async () => {
  assert.match(await text({ topic: 'data_get' }), /Guide: data service/);
  assert.match(await text({ topic: 'agent_execute' }), /Guide: run a Claude Code agent/);
  assert.match(await text({ topic: 'session_dag' }), /Guide: investigate a Claude Code session/);
});

test('a synonym resolves (storage → data, history → sessions)', async () => {
  assert.match(await text({ topic: 'storage' }), /Guide: data service/);
  assert.match(await text({ topic: 'history' }), /Guide: investigate/);
});

test('an unknown topic falls back to the index, not an error', async () => {
  const t = await text({ topic: 'zzz-nope' });
  assert.match(t, /No guide titled/);
  assert.match(t, /## Topics/);
});

test('orientation presents the cross-host access model + how it COMPLEMENTS (not replaces) CLAUDE.md/memory/skills', async () => {
  const t = await text({ topic: 'orientation' });
  assert.match(t, /COMPLEMENTS|complement|work BEST TOGETHER/i); // partnership, not a hierarchy
  assert.match(t, /does NOT replace/i);
  assert.match(t, /CLAUDE\.md/);
  assert.match(t, /skills/i);
  for (const w of ['PROJECTS', 'SESSIONS', 'MEMORY', 'NODES']) assert.match(t, new RegExp(w), `mentions ${w}`);
  assert.match(t, /DATA\/context|not a command/i); // results inform, not command (safety boundary)
});

test('orientation is the first index topic + has priority aliases', async () => {
  assert.ok((await text({})).includes('- `orientation`'));
  for (const syn of ['priorities', 'about', 'when-to-use']) assert.match(await text({ topic: syn }), /Guide: orientation/);
});

test('the MCP server `instructions` present lm-assist as COMPLEMENTING local context (surfaced on connect)', () => {
  assert.ok(LM_ASSIST_INSTRUCTIONS.length > 300, 'instructions are non-trivial');
  assert.match(LM_ASSIST_INSTRUCTIONS, /COMPLEMENTS|complement/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /does NOT replace/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /work best TOGETHER/i);
  assert.match(LM_ASSIST_INSTRUCTIONS, /CLAUDE\.md/);
  assert.match(LM_ASSIST_INSTRUCTIONS, /guide\(\)/); // points the LLM at the playbooks
});

test('index surfaces the cross-node + workflows topics', async () => {
  const t = await text({});
  assert.match(t, /`cross-node`/);
  assert.match(t, /`workflows`/);
});

test('cross-node guide covers node targeting, per-node keys, and local-only', async () => {
  const t = await text({ topic: 'cross-node' });
  assert.match(t, /node=/);
  assert.match(t, /KEY_WRONG_NODE/);      // per-node access keys
  assert.match(t, /LOCAL-ONLY/);
  assert.match(t, /list_nodes/);
});

test('workflows guide gives numbered multi-tool combination recipes', async () => {
  const t = await text({ topic: 'workflows' });
  assert.match(t, /1\)/);
  assert.match(t, /agent_execute/);
  assert.match(t, /data_put/);
  assert.match(t, /node=B/);              // cross-node steps present
});

test('multi-node synonyms resolve to cross-node', async () => {
  for (const syn of ['multinode', 'multi-node', 'fleet', 'crossnode']) {
    assert.match(await text({ topic: syn }), /single-node vs cross-node/);
  }
});

test('each feature playbook documents the cross-node variant', async () => {
  for (const topic of ['data', 'sessions', 'agents', 'terminals']) {
    assert.match(await text({ topic }), /CROSS-NODE/i, `${topic} should have a cross-node section`);
  }
});

test('the tool is advertised read-only with a topic param', () => {
  const def = GUIDE_TOOL_DEFS.find((d) => d.name === 'guide');
  assert.ok(def, 'guide def present');
  assert.equal((def as any).annotations.readOnlyHint, true);
  assert.ok((def as any).inputSchema.properties.topic, 'has a topic param');
});

// The `install` topic teaches a connector-only host (e.g. a fresh cloud/CCR container with NO
// local lm-assist) how to install + build from the repo. It only reaches such a session if it
// rides along in the bootstrap payload — i.e. it MUST be in buildBootstrap()'s `order` array
// (an easy-to-forget invariant). These lock that wiring + the verified gotchas.
test('bootstrap loads the install topic (no-install host learns to install from repo)', async () => {
  const t = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(t, /install & build lm-assist FROM THE REPO/);
  assert.match(t, /npm install --ignore-scripts/); // the dev install gotcha
  assert.match(t, /npm pack/);                      // the prod build path
});

test('install guide gives the dev + prod from-repo playbook', async () => {
  const t = await text({ topic: 'install' });
  assert.match(t, /DEV \(repo ports/);
  assert.match(t, /PROD \(CLI ports/);
  assert.match(t, /runningFrom":"dev-repo/);
  assert.match(t, /lm-assist upgrade --from/);      // the local-tgz-vs-npm caveat
});

test('install synonyms resolve (build, setup, from-repo, not-installed)', async () => {
  for (const syn of ['build', 'setup', 'from-repo', 'not-installed', 'prod-run']) {
    assert.match(await text({ topic: syn }), /install & build lm-assist FROM THE REPO/, `${syn} → install`);
  }
});

test('index lists the install topic', async () => {
  assert.match(await text({}), /`install`/);
});
