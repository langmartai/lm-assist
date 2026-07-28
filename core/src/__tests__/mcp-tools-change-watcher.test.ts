/**
 * The watcher loop that turns a rev change into `notifications/tools/list_changed`.
 *
 * The decision logic is tested in mcp-tools-rev.test.ts; this pins the LOOP
 * behaviour that would make the feature obnoxious or dangerous in practice: a
 * spurious notification on startup, a notification storm from a flapping Core,
 * or a throwing client taking the MCP process down.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { startToolsChangeWatcher } from '../mcp-server/tools-change-watcher';

/** Let the watcher's immediate baseline tick (and any queued ticks) settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

test('🔴 does NOT notify on startup — the first read is only a baseline', async () => {
  let fired = 0;
  const w = startToolsChangeWatcher(() => { fired++; }, {
    pollMs: 5, fetchRev: async () => 'rev.1',
  });
  await settle();
  w.stop();
  assert.equal(fired, 0, 'a fresh client just fetched the list; telling it to re-fetch is noise');
});

test('notifies once when the rev moves', async () => {
  let fired = 0;
  let rev = 'rev.1';
  const w = startToolsChangeWatcher(() => { fired++; }, { pollMs: 5, fetchRev: async () => rev });
  await settle();
  rev = 'rev.2';
  await settle();
  w.stop();
  assert.equal(fired, 1);
});

test('🔴 does not re-notify while the rev stays put — no storm from polling', async () => {
  let fired = 0;
  let rev = 'rev.1';
  const w = startToolsChangeWatcher(() => { fired++; }, { pollMs: 5, fetchRev: async () => rev });
  await settle();
  rev = 'rev.2';
  await settle();
  await settle(); // many further polls at the SAME rev
  w.stop();
  assert.equal(fired, 1, 'one change must produce exactly one notification');
});

test('a failed fetch neither notifies nor forgets the baseline', async () => {
  let fired = 0;
  let rev: string | null = 'rev.1';
  const w = startToolsChangeWatcher(() => { fired++; }, { pollMs: 5, fetchRev: async () => rev });
  await settle();
  rev = null;              // Core down
  await settle();
  rev = 'rev.1';           // ...and back, unchanged
  await settle();
  w.stop();
  assert.equal(fired, 0, 'a blip must not manufacture a change');
});

test('🔴 a THROWING notify does not crash the watcher — it runs on a bare timer', async () => {
  let calls = 0;
  let rev = 'rev.1';
  const w = startToolsChangeWatcher(() => { calls++; throw new Error('client went away'); }, {
    pollMs: 5, fetchRev: async () => rev,
  });
  await settle();
  rev = 'rev.2';
  await settle();
  rev = 'rev.3';
  await settle();
  w.stop();
  assert.ok(calls >= 2, `watcher stopped after a throw (calls=${calls})`);
});

test('stop() ends it — a stopped watcher never notifies again', async () => {
  let fired = 0;
  let rev = 'rev.1';
  const w = startToolsChangeWatcher(() => { fired++; }, { pollMs: 5, fetchRev: async () => rev });
  await settle();
  w.stop();
  rev = 'rev.2';
  await settle();
  assert.equal(fired, 0);
});
