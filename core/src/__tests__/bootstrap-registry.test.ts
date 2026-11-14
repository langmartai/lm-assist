/**
 * Fleet-shared bootstrap flags — the cross-node half of "one bootstrap per
 * conversation" (2026-09: a conversation that bootstrapped through node A was
 * refused BOOTSTRAP_REQUIRED when the hub routed a call to node B, ~35 KB per
 * re-bootstrap). The per-node persistence half is bootstrap-persist.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetBootstrappedAt, publishBootstrapToFleet, type FleetBootstrapStore } from '../mcp-server/bootstrap-registry';

function fakeFleet(): { store: FleetBootstrapStore; rows: Map<string, { bootstrappedAt: number; node?: string }>; puts: string[] } {
  const rows = new Map<string, { bootstrappedAt: number; node?: string }>();
  const puts: string[] = [];
  return {
    rows, puts,
    store: {
      async get(id) { return rows.get(id) ?? null; },
      async put(id, row) { puts.push(id); rows.set(id, row); },
    },
  };
}

test('a bootstrap on node A is published; node B reads it back from the fleet store', async () => {
  const fleet = fakeFleet();
  publishBootstrapToFleet('conv-9', 1_000, fleet.store);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fleet.puts, ['conv-9']);
  const row = await fleetBootstrappedAt('conv-9', fleet.store);
  assert.equal(row?.bootstrappedAt, 1_000);
  assert.equal(await fleetBootstrappedAt('unknown', fleet.store), null);
});

test('fleet failures and absence degrade to null — never a refusal reason, never a throw', async () => {
  const broken: FleetBootstrapStore = { async get() { throw new Error('sync down'); }, async put() { throw new Error('sync down'); } };
  assert.equal(await fleetBootstrappedAt('c', broken), null);
  assert.doesNotThrow(() => publishBootstrapToFleet('c', 1, broken));
  assert.equal(await fleetBootstrappedAt('c', null), null);
  assert.doesNotThrow(() => publishBootstrapToFleet('c', 1, null));
  // a row without a timestamp is not a bootstrap
  const empty: FleetBootstrapStore = { async get() { return { bootstrappedAt: 0 }; }, async put() {} };
  assert.equal(await fleetBootstrappedAt('c', empty), null);
});
