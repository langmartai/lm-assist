/**
 * Core-side live overlay provider (spec §4.4): store-backed with a small TTL cache
 * (tools/list bursts must not hammer LMDB), fail-open on store errors, and an
 * invalidation hook the write routes call so an edit is visible immediately on
 * the node that took it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveOverlayProvider,
  sharedLiveOverlay,
  invalidateOverlayCache,
  _replaceSharedLiveOverlayForTests,
} from '../mcp-server/registry/overlay-live';
import type { ToolRegistryDoc } from '../mcp-server/registry/model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };
function regDoc(name: string, over: string | null, enabled: boolean): ToolRegistryDoc {
  return { name, descriptionOverride: over, enabled, rev: 1, history: [], createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1 };
}

test('provider builds the overlay from the doc lister', async () => {
  const p = createLiveOverlayProvider({ list: async () => [regDoc('detail', 'o', true)] });
  const ov = await p.get();
  assert.deepEqual(ov?.byName.detail, { enabled: true, descriptionOverride: 'o' });
});

test('TTL cache: one list per window; invalidate() forces a refresh', async () => {
  let calls = 0;
  const docs: ToolRegistryDoc[] = [];
  const p = createLiveOverlayProvider({ ttlMs: 60_000, list: async () => { calls++; return docs; } });
  await p.get();
  await p.get();
  assert.equal(calls, 1, 'second get served from cache');
  docs.push(regDoc('detail', null, false));
  p.invalidate();
  const ov = await p.get();
  assert.equal(calls, 2, 'invalidate forces re-list');
  assert.equal(ov?.byName.detail.enabled, false);
});

test('ttlMs 0 refreshes every get', async () => {
  let calls = 0;
  const p = createLiveOverlayProvider({ ttlMs: 0, list: async () => { calls++; return []; } });
  await p.get();
  await p.get();
  assert.equal(calls, 2);
});

test('fail-open: lister throw → null overlay, and the failure is cached for the TTL window', async () => {
  let calls = 0;
  const p = createLiveOverlayProvider({ ttlMs: 60_000, list: async () => { calls++; throw new Error('lmdb down'); } });
  assert.equal(await p.get(), null);
  assert.equal(await p.get(), null);
  assert.equal(calls, 1, 'error result cached — no hammering a broken store');
});

test('shared singleton is swappable for tests and invalidateOverlayCache targets it', async () => {
  const prev = sharedLiveOverlay();
  try {
    let invalidated = 0;
    _replaceSharedLiveOverlayForTests({
      get: async () => ({ byName: { x: { enabled: false, descriptionOverride: null } } }),
      invalidate: () => { invalidated++; },
    });
    const ov = await sharedLiveOverlay().get();
    assert.equal(ov?.byName.x.enabled, false);
    invalidateOverlayCache();
    assert.equal(invalidated, 1);
  } finally {
    _replaceSharedLiveOverlayForTests(prev);
  }
});
