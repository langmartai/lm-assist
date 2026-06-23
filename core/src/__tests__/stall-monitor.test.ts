import { test } from 'node:test';
import assert from 'node:assert';
import { runStallMonitorTick } from '../monitor/stall-monitor';
import { StallRecord } from '../monitor/stall-state';

function baseDeps(over: any = {}) {
  let store: Record<string, StallRecord> = over.store ?? {};
  return {
    now: 1_000_000,
    cfg: { intervalMin: 5, maxAttempts: 6 },
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'self' }),
    findLocal: async () => [{ sessionId: 'L1', category: 'overloaded' }],
    resumeLocal: async () => true,
    findRemote: async () => [{ sid: 'R1', category: 'server_error' }],
    resumeRemote: async () => true,
    remoteScan: true,
    load: () => store,
    save: (s: any) => { store = s; },
    ...over,
  };
}

test('first tick nudges local + remote (monitor)', async () => {
  const d = baseDeps();
  const r = await runStallMonitorTick(d);
  assert.deepStrictEqual(r.localNudged, ['L1']);
  assert.deepStrictEqual(r.remoteNudged, ['R1']);
});

test('non-monitor skips remote scan', async () => {
  let remoteCalled = false;
  const d = baseDeps({ amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'other' }), findRemote: async () => { remoteCalled = true; return []; } });
  const r = await runStallMonitorTick(d);
  assert.strictEqual(remoteCalled, false);
  assert.deepStrictEqual(r.remoteNudged, []);
  assert.deepStrictEqual(r.localNudged, ['L1']); // local still runs
});

test('remoteScan disabled → no remote even if monitor', async () => {
  let remoteCalled = false;
  const d = baseDeps({ remoteScan: false, findRemote: async () => { remoteCalled = true; return []; } });
  await runStallMonitorTick(d);
  assert.strictEqual(remoteCalled, false);
});

test('a session that recovered (no longer stalled) is reset out of the store', async () => {
  const store: Record<string, StallRecord> = { 'local:L1': { attempts: 2, lastNudgeAt: 1, category: 'overloaded', backoffStep: 1, gaveUp: false } };
  const d = baseDeps({ store, findLocal: async () => [], findRemote: async () => [] }); // L1 no longer stalled
  await runStallMonitorTick(d);
  assert.strictEqual(d.load()['local:L1'], undefined); // reset/cleared
});

test('cap reached → giveUp, not nudged', async () => {
  const store: Record<string, StallRecord> = { 'local:L1': { attempts: 6, lastNudgeAt: 1, category: 'overloaded', backoffStep: 5, gaveUp: false } };
  let resumed = false;
  const d = baseDeps({ store, resumeLocal: async () => { resumed = true; return true; } });
  const r = await runStallMonitorTick(d);
  assert.strictEqual(resumed, false);
  assert.deepStrictEqual(r.gaveUp, ['local:L1']);
  assert.strictEqual(d.load()['local:L1'].gaveUp, true);
});
