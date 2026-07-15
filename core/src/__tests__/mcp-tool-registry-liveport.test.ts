/**
 * Live-port ↔ data-service contract (spec §4.2): READS must NEVER create the fleet
 * dataset. A fresh node's first tools/list fires within seconds of boot (overlay
 * provider) — long before the fleet catalog reconcile — and a read-side create would
 * claim LOCAL ownership of `mcp-tool-registry`; dataset-registry.upsertReplica
 * refuses to convert a locally-owned dataset to a replica, so the node would be
 * permanently split from the fleet registry. Creation belongs to the WRITE path
 * (first write establishes the origin, workflow-registry precedent), and a failed
 * create must retry on the next write instead of sticking.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as dataService from '../data/data-service';
import { getToolDoc, listToolDocs, putToolDoc } from '../mcp-server/registry/store';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

type FakeSvc = {
  isEnabled: () => boolean;
  createDataset: ReturnType<typeof mock.fn>;
  get: (...a: unknown[]) => Promise<unknown>;
  query: (...a: unknown[]) => Promise<unknown>;
  put: (...a: unknown[]) => Promise<unknown>;
};

function fakeSvc(opts?: {
  createResult?: unknown;
  getResult?: unknown;
  putResult?: unknown;
}): FakeSvc {
  return {
    isEnabled: () => true,
    createDataset: mock.fn(async () => opts?.createResult ?? { ok: true, value: { id: 'mcp-tool-registry' } }),
    get: async () => opts?.getResult ?? { ok: true, value: null },
    query: async () => ({ ok: true, value: { records: [] } }),
    put: async () => opts?.putResult ?? { ok: true, value: undefined },
  };
}

function useSvc(svc: FakeSvc): void {
  mock.method(dataService, 'getDataService', () => svc as unknown as ReturnType<typeof dataService.getDataService>);
}

test('reads (get/list) never create the dataset', async () => {
  const svc = fakeSvc({ getResult: { ok: false, code: 'NOT_FOUND' } });
  useSvc(svc);
  assert.equal(await getToolDoc('detail'), null);
  assert.deepEqual(await listToolDocs(), []);
  assert.equal(svc.createDataset.mock.callCount(), 0, 'read paths must not self-create the fleet dataset');
});

test('a transiently-failed create does not stick — the next write retries it', async () => {
  const bad = fakeSvc({
    createResult: { ok: false, code: 'BACKEND_ERROR', reason: 'backend offline' },
    putResult: { ok: false, code: 'DATA_WRITE_FAILED', reason: 'no dataset' },
  });
  useSvc(bad);
  await assert.rejects(() => putToolDoc({ name: 'detail', enabled: false }, actor));
  assert.equal(bad.createDataset.mock.callCount(), 1, 'write path attempts the create');

  const good = fakeSvc();
  useSvc(good);
  const r = await putToolDoc({ name: 'detail', enabled: false }, actor);
  assert.equal(r.doc.rev, 1);
  assert.equal(good.createDataset.mock.callCount(), 1, 'create retried after the earlier transient failure');

  const after = fakeSvc();
  useSvc(after);
  await putToolDoc({ name: 'detail', descriptionOverride: 'x' }, actor);
  assert.equal(after.createDataset.mock.callCount(), 0, 'ensured sticks once the create succeeded');
});

test('a hand-authored record without history reads back normalized (history: [])', async () => {
  const svc = fakeSvc({
    getResult: {
      ok: true,
      value: {
        id: 'detail', version: 0, createdAt: 'x', updatedAt: 'x',
        fields: { name: 'detail', descriptionOverride: null, enabled: true, rev: 2 },
      },
    },
  });
  useSvc(svc);
  const doc = await getToolDoc('detail');
  assert.ok(doc);
  assert.deepEqual(doc!.history, [], 'missing history normalized to []');
});
