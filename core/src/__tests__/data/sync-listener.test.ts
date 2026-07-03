import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SyncListener } from '../../data/sync-listener';
import type { BusEvent } from '../../bus/types';

function harness() {
  let cb: ((e: BusEvent) => void) | null = null;
  const pulls: Array<[string, string]> = [];
  const l = new SyncListener({
    selfNode: () => 'gw-self',
    pull: async (dataset, from) => { pulls.push([dataset, from]); },
    onLocalEvent: (fn) => { cb = fn; return () => { cb = null; }; },
    debounceMs: 5,
  });
  l.start();
  const emit = (e: Partial<BusEvent> & { topic: string; origin: string }) =>
    cb!({ seq: 1, type: 'changed', at: Date.now(), payload: { ids: ['r'] }, ...e } as BusEvent);
  return { l, pulls, emit };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a peer data event schedules one debounced pull(dataset, origin)', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-b' });
  await wait(20);
  assert.deepEqual(pulls, [['missions', 'gw-b']]);
});

test('rapid same-key events coalesce into ONE pull', async () => {
  const { pulls, emit } = harness();
  for (let i = 0; i < 5; i++) emit({ topic: 'data:missions', origin: 'gw-b' });
  await wait(20);
  assert.equal(pulls.length, 1);
});

test('own-origin events are ignored (no self-pull)', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-self' });
  await wait(20);
  assert.equal(pulls.length, 0);
});

test('non-data topics are ignored', async () => {
  const { pulls, emit } = harness();
  emit({ topic: 'mission:1', origin: 'gw-b' });
  await wait(20);
  assert.equal(pulls.length, 0);
});

test('stop() detaches and cancels pending timers', async () => {
  const { l, pulls, emit } = harness();
  emit({ topic: 'data:missions', origin: 'gw-b' });
  l.stop();
  await wait(20);
  assert.equal(pulls.length, 0);
});
