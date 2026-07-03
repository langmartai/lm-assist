// core/src/__tests__/data/fabric-peer-client.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FabricPeerClient } from '../../data/fabric-peer-client';
import type { NodeInfo, ManifestEntry, DataRecord } from '../../data/types';

const hubStub = (over: Partial<Record<string, (...a: any[]) => any>> = {}) => ({
  listPeers: async (): Promise<NodeInfo[]> => [{ node: 'gw-b', hostname: 'b', platform: 'linux' }],
  manifest: async (): Promise<{ node: string; datasets: ManifestEntry[] }> => ({ node: 'gw-b', datasets: [{ id: 'HUB', syncMode: 'full', ownerNode: 'gw-b', backend: 'cache' }] }),
  exportFrom: async (): Promise<DataRecord[]> => [{ id: 'hub', version: 1, fields: {}, createdAt: '', updatedAt: '' }],
  getFrom: async (): Promise<DataRecord | null> => null,
  ...over,
}) as any;

test('when eligible, manifest goes over the fabric and unwraps {success,data}', async () => {
  const c = new FabricPeerClient('self', hubStub(), {
    settings: () => ({ dataSyncViaFabric: true }),
    eligible: () => true,
    request: async (_n, init) => {
      assert.equal(init.path, '/data/sync/manifest');
      return { status: 200, data: { success: true, data: { node: 'gw-b', datasets: [{ id: 'FAB', syncMode: 'full', ownerNode: 'gw-b', backend: 'cache' }] } } };
    },
  });
  const m = await c.manifest('gw-b');
  assert.equal(m.datasets[0].id, 'FAB'); // fabric path, not hub
});

test('when dataSyncViaFabric is off, everything uses the hub fallback', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: false }), eligible: () => true, request: async () => { throw new Error('must not be called'); } });
  const m = await c.manifest('gw-b');
  assert.equal(m.datasets[0].id, 'HUB');
});

test('when the peer lacks the data feature (ineligible), uses the hub fallback', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => false, request: async () => { throw new Error('must not be called'); } });
  const rows = await c.exportFrom('gw-b', 'd');
  assert.equal(rows[0].id, 'hub');
});

test('a fabric error falls back to the hub path for that call', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => true, request: async () => { throw new Error('link dropped'); } });
  const rows = await c.exportFrom('gw-b', 'd');
  assert.equal(rows[0].id, 'hub'); // fell back
});

test('listPeers always uses the hub roster', async () => {
  const c = new FabricPeerClient('self', hubStub(), { settings: () => ({ dataSyncViaFabric: true }), eligible: () => true, request: async () => ({ status: 200, data: {} }) });
  assert.deepEqual((await c.listPeers()).map((p) => p.node), ['gw-b']);
});

// fabricRequestManaged RESOLVES an app-level error (status>=400 or a `code`) instead of
// throwing — so, unlike a dropped link (which throws and is already caught above), a fabric
// 4xx/5xx must be explicitly detected or it would silently yield empty/null data instead of
// falling back to hub.

test('manifest: a fabric app-error (status 503) falls back to the hub path and returns hub data', async () => {
  const c = new FabricPeerClient('self', hubStub(), {
    settings: () => ({ dataSyncViaFabric: true }),
    eligible: () => true,
    request: async () => ({ status: 503 }),
  });
  const m = await c.manifest('gw-b');
  assert.equal(m.datasets[0].id, 'HUB'); // fell back — not an empty fabric result
});

test('exportFrom: a fabric app-error (code present) falls back to the hub path and returns hub data', async () => {
  const c = new FabricPeerClient('self', hubStub(), {
    settings: () => ({ dataSyncViaFabric: true }),
    eligible: () => true,
    request: async () => ({ status: 200, code: 'RESOURCE_NOT_FOUND', message: 'no such dataset' }),
  });
  const rows = await c.exportFrom('gw-b', 'd');
  assert.equal(rows[0].id, 'hub'); // fell back — not the (nonexistent) fabric data
});

test('getFrom: a fabric app-error (status 500) falls back to the hub path and returns hub data', async () => {
  const c = new FabricPeerClient('self', hubStub({
    getFrom: async (): Promise<DataRecord | null> => ({ id: 'hub-rec', version: 1, fields: {}, createdAt: '', updatedAt: '' }),
  }), {
    settings: () => ({ dataSyncViaFabric: true }),
    eligible: () => true,
    request: async () => ({ status: 500, message: 'internal error' }),
  });
  const rec = await c.getFrom('gw-b', 'd', 'x');
  assert.equal(rec?.id, 'hub-rec'); // fell back — not null
});
