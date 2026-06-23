import { test } from 'node:test';
import assert from 'node:assert';
import { runStallMonitorTick } from '../monitor/stall-monitor';
import { isServerStall } from '../monitor/stall-classify';
import { StallRecord } from '../monitor/stall-state';

test('lifecycle: nudge → wait → recovery clears; user-limit never nudged', async () => {
  let store: Record<string, StallRecord> = {};
  // session "U" is a user-limit (must never nudge); "S" is overloaded then recovers.
  let sErrorText = 'API Error: 529';
  const mk = (now: number, sStalled: boolean) => ({
    now, cfg: { intervalMin: 5, maxAttempts: 6 },
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'x' }), // local-only
    findLocal: async () => {
      const out: { sessionId: string; category: string }[] = [];
      const u = isServerStall('Claude usage limit reached'); if (u.retryable) out.push({ sessionId: 'U', category: u.category });
      if (sStalled) { const s = isServerStall(sErrorText); if (s.retryable) out.push({ sessionId: 'S', category: s.category }); }
      return out;
    },
    resumeLocal: async () => true,
    findRemote: async () => [], resumeRemote: async () => true, remoteScan: false,
    load: () => store, save: (s: any) => { store = s; },
  });

  const t1 = await runStallMonitorTick(mk(0, true));
  assert.deepStrictEqual(t1.localNudged, ['S']);        // U never appears
  assert.ok(!('local:U' in store));
  assert.strictEqual(store['local:S'].attempts, 1);

  const t2 = await runStallMonitorTick(mk(4 * 60_000, true)); // not due yet
  assert.deepStrictEqual(t2.localNudged, []);
  assert.strictEqual(store['local:S'].attempts, 1);

  const t3 = await runStallMonitorTick(mk(99 * 60_000, false)); // recovered
  assert.ok(!('local:S' in store));
});
