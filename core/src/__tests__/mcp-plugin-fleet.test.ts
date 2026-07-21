// Fleet node-affinity for ext__ plugin tools (fleet-plugins.ts): owner
// resolution from peer probes, local-first execution, one-hop forwarding with
// the noForward loop guard, fail-open peer errors, and cache behavior.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  _configureFleetPlugins,
  fleetExtToolDefs,
  callExtToolFleetAware,
  type FleetPluginDeps,
} from '../mcp-server/plugins/fleet-plugins';

const CHART = 'ext__chart-context__get_view_summary';

function makeDeps(over: Partial<FleetPluginDeps> = {}): FleetPluginDeps & {
  calls: { forwarded: Array<{ node: string; body: unknown }>; localCalls: string[] };
} {
  const calls = { forwarded: [] as Array<{ node: string; body: unknown }>, localCalls: [] as string[] };
  const deps: FleetPluginDeps = {
    listNodes: async () => ['gw-self', 'gw-owner', 'gw-other'],
    fetchDefs: async (node) =>
      node === 'gw-owner'
        ? { success: true, data: { tools: [{ name: CHART, description: 'chart', inputSchema: { type: 'object' } }] } }
        : { success: true, data: { tools: [] } },
    postCall: async (node, body) => {
      calls.forwarded.push({ node, body });
      return { success: true, data: { content: [{ type: 'text', text: 'NATGAS summary' }] } };
    },
    selfNode: () => 'gw-self',
    localDefs: async () => [],
    localCall: async (tool) => {
      calls.localCalls.push(tool);
      return { content: [{ type: 'text', text: `local:${tool}` }] };
    },
    now: () => 1_000_000,
    ...over,
  };
  return Object.assign(deps, { calls });
}

beforeEach(() => _configureFleetPlugins(null));

test('remote defs merge: peer-owned ext tools are listed, local names win', async () => {
  const deps = makeDeps();
  _configureFleetPlugins(deps);
  const defs = await fleetExtToolDefs();
  assert.deepStrictEqual(defs.map((d) => d.name), [CHART]);

  // A locally-present tool of the same name is NOT duplicated from remote.
  _configureFleetPlugins(makeDeps({
    localDefs: async () => [{ name: CHART, description: 'local copy', inputSchema: {} }],
  }));
  assert.deepStrictEqual(await fleetExtToolDefs(), []);
});

test('self node is excluded from probing', async () => {
  const probed: string[] = [];
  const deps = makeDeps({
    fetchDefs: async (node) => { probed.push(node); return { data: { tools: [] } }; },
  });
  _configureFleetPlugins(deps);
  await fleetExtToolDefs();
  assert.ok(!probed.includes('gw-self'), `probed self: ${probed}`);
});

test('local plugin executes locally — never forwarded', async () => {
  const deps = makeDeps({
    localDefs: async () => [{ name: CHART, description: '', inputSchema: {} }],
  });
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware(CHART, {});
  assert.strictEqual(r.content[0].text ?? '', `local:${CHART}`);
  assert.strictEqual(deps.calls.forwarded.length, 0);
});

test('non-owner forwards one hop to the owner with noForward:true', async () => {
  const deps = makeDeps();
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware(CHART, { a: 1 });
  assert.strictEqual(deps.calls.forwarded.length, 1);
  assert.strictEqual(deps.calls.forwarded[0].node, 'gw-owner');
  assert.deepStrictEqual(deps.calls.forwarded[0].body, { tool: CHART, args: { a: 1 }, noForward: true });
  assert.ok(r.content.some((c) => c.text?.includes('NATGAS summary')));
  assert.ok(r.content.some((c) => c.text?.includes('executed on gw-owner')), 'provenance note missing');
});

test('noForward call never bounces — executes (fails) locally', async () => {
  const deps = makeDeps();
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware(CHART, {}, { noForward: true });
  assert.strictEqual(deps.calls.forwarded.length, 0);
  assert.strictEqual(r.content[0].text ?? '', `local:${CHART}`);
});

test('no owner anywhere → falls back to the local aggregator error', async () => {
  const deps = makeDeps({
    fetchDefs: async () => ({ data: { tools: [] } }),
    localCall: async () => ({ content: [{ type: 'text', text: '⛔ no plugin named "chart-context" is installed.' }], isError: true }),
  });
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware(CHART, {});
  assert.strictEqual(r.isError, true);
  assert.ok(r.content[0].text?.includes('no plugin named'));
});

test('forward failure reports the owner + reason as a tool error', async () => {
  const deps = makeDeps({
    postCall: async () => { throw new Error('relay down'); },
  });
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware(CHART, {});
  assert.strictEqual(r.isError, true);
  assert.ok(r.content[0].text?.includes('gw-owner'));
  assert.ok(r.content[0].text?.includes('relay down'));
});

test('peer probe errors fail open and are negative-cached briefly', async () => {
  let t = 1_000_000;
  let probes = 0;
  const deps = makeDeps({
    listNodes: async () => { probes++; throw new Error('hub unreachable'); },
    now: () => t,
  });
  _configureFleetPlugins(deps);
  assert.deepStrictEqual(await fleetExtToolDefs(), []);
  const after = probes;
  await fleetExtToolDefs();           // within negative TTL — no new probe
  assert.strictEqual(probes, after);
  t += 21_000;                        // past the 20s negative TTL
  await fleetExtToolDefs();
  assert.ok(probes > after, 'expected re-probe after negative TTL');
});

test('non-ext names pass straight to local dispatch', async () => {
  const deps = makeDeps();
  _configureFleetPlugins(deps);
  const r = await callExtToolFleetAware('not_a_plugin_tool', {});
  assert.strictEqual(r.content[0].text ?? '', 'local:not_a_plugin_tool');
  assert.strictEqual(deps.calls.forwarded.length, 0);
});
