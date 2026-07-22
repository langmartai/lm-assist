/** The model-fallback tick — injected deps only, no IO. Mirrors stall-monitor.test.ts. */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runModelFallbackTick, sendModelSlash, ModelFallbackTickDeps, ModelLimitedSession } from '../monitor/model-fallback';
import { ModelSwitchRecord } from '../monitor/model-limit';

const LIMITED = (sid: string, model = 'Fable 5') =>
  [
    `  ⎿  You've reached your ${model} limit. Run /usage-credits to continue or switch models with /model.`,
    `    no worktrees ctx:23% ram:469M pid:357656 up:48m sid: ${sid} ${model}`,
  ].join('\n');

const ON_FALLBACK = (sid: string) =>
  [
    `  ⎿  You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.`,
    `    no worktrees ctx:23% ram:469M pid:357656 up:48m sid: ${sid} Opus 4.8      ◈ max · /effort`,
  ].join('\n');

const SID = '16946066-1a70-4a61-8b67-d346b50cd84a';

function deps(over: Partial<ModelFallbackTickDeps> = {}): ModelFallbackTickDeps & { store: Record<string, ModelSwitchRecord>; sent: Array<{ id: string; to: string }> } {
  const store: Record<string, ModelSwitchRecord> = {};
  const sent: Array<{ id: string; to: string }> = [];
  const base: ModelFallbackTickDeps = {
    now: 10_000,
    cfg: { enabled: true, fallbackModel: 'opus', fromModels: ['fable'] },
    amMonitor: async () => ({ isMonitor: true }),
    findLocal: async () => [{ sessionId: SID, screen: LIMITED(SID), tmux: 'claude-1694' }],
    switchLocal: async (s, to) => { sent.push({ id: s.sessionId, to }); return true; },
    reread: async (s) => ON_FALLBACK(s.sessionId), // the switch landed
    findRemote: async () => [],
    switchRemote: async (s, to) => { sent.push({ id: s.sessionId, to }); return true; },
    remoteScan: true,
    load: () => store,
    save: (s) => { Object.assign(store, s); },
    journal: () => {},
    sleep: async () => {}, // no real delay in tests
  };
  return Object.assign(base, over, { store, sent });
}

describe('sendModelSlash', () => {
  const CONFIRM = [
    '❯ /model opus',
    '  Switch model?',
    '  This conversation is cached for the current model. Switching to Opus 4.8 means the full history gets re-read.',
    '  ❯ 1. Yes, switch to Opus 4.8',
    '    2. No, go back',
  ].join('\n');

  test('answers the confirm dialog a cached conversation raises', async () => {
    const calls: string[] = [];
    const ok = await sendModelSlash('claude-1694', 'opus', {
      slash: async (n, o) => { calls.push(`slash ${o.cmd} ${o.args}`); },
      capture: () => CONFIRM,
      choose: async (_n, k) => { calls.push(`choose ${k}`); },
      sleep: async () => {},
      now: () => 0,
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, ['slash model opus', 'choose 1']);
  });

  test('does not press anything when the switch applied without asking', async () => {
    const calls: string[] = [];
    await sendModelSlash('claude-1694', 'opus', {
      slash: async () => { calls.push('slash'); },
      capture: () => '  ⎿  Set model to Opus 4.8 and saved as your default for new sessions',
      choose: async () => { calls.push('choose'); },
      sleep: async () => {},
      now: () => 0,
    });
    assert.deepEqual(calls, ['slash'], 'no dialog → no keypress');
  });

  test('a busy session (slash throws) propagates so the tick can retry', async () => {
    await assert.rejects(
      () => sendModelSlash('claude-1694', 'opus', {
        slash: async () => { throw new Error('PRECONDITION_FAILED: phase=busy'); },
        capture: () => '', choose: async () => {}, sleep: async () => {}, now: () => 0,
      }),
      /PRECONDITION_FAILED/,
    );
  });
});

describe('runModelFallbackTick', () => {
  test('switches a limited local session and verifies the model moved', async () => {
    const d = deps();
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 1);
    assert.deepEqual(d.sent, [{ id: SID, to: 'opus' }]);
    assert.equal(r.switched[0].from, 'fable');
    assert.equal(r.switched[0].to, 'opus');
    assert.equal(r.switched[0].verified, true, 'status line moved off Fable → verified');
    assert.equal(d.store[`local:${SID}`].attempts, 1);
  });

  test('records unverified when the status line did NOT move', async () => {
    const d = deps({ reread: async (s: ModelLimitedSession) => LIMITED(s.sessionId) });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched[0].verified, false);
    assert.equal(d.store[`local:${SID}`].verified, false);
  });

  test('no-ops (and sends nothing) on a healthy session', async () => {
    const d = deps({ findLocal: async () => [{ sessionId: SID, screen: 'all good here ❯', tmux: 't' }] });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 0);
    assert.deepEqual(d.sent, []);
    assert.deepEqual(d.store, {});
  });

  test('never switches on a server error', async () => {
    const d = deps({ findLocal: async () => [{ sessionId: SID, screen: 'API Error: 529 Overloaded', tmux: 't' }] });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 0);
    assert.deepEqual(d.sent, []);
  });

  test('IDEMPOTENT: a second tick with the banner still on screen sends nothing', async () => {
    const d = deps();
    await runModelFallbackTick(d);
    d.sent.length = 0;
    // the session is now on the fallback; the banner remains in scrollback
    d.findLocal = async () => [{ sessionId: SID, screen: ON_FALLBACK(SID), tmux: 'claude-1694' }];
    const r2 = await runModelFallbackTick(d);
    assert.equal(r2.switched.length, 0);
    assert.deepEqual(d.sent, [], 'must not re-switch a recovered session');
    assert.equal(d.store[`local:${SID}`].attempts, 1, 'the switch stays in the journal');
  });

  test('journal entries age out but recent ones are kept', async () => {
    const d = deps();
    await runModelFallbackTick(d);
    assert.ok(d.store[`local:${SID}`], 'fresh entry retained');

    const later = deps({ findLocal: async () => [], now: 10_000 + 8 * 24 * 60 * 60_000 });
    Object.assign(later.store, d.store);
    await runModelFallbackTick(later);
    assert.equal(later.store[`local:${SID}`], undefined, 'entry older than the TTL is pruned');
  });

  test('a busy session (slash throws) writes no record and retries next tick', async () => {
    const d = deps({ switchLocal: async () => { throw new Error('PRECONDITION_FAILED: phase=busy'); } });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 0);
    assert.deepEqual(d.store, {}, 'no cooldown written → next tick retries immediately');
  });

  test('remote CCRs are scanned only by the elected monitor', async () => {
    const remote = async () => [{ sessionId: 'session_abc', screen: LIMITED('session_abc'), tmux: null }];
    const asMonitor = deps({ findLocal: async () => [], findRemote: remote });
    assert.equal((await runModelFallbackTick(asMonitor)).switched.length, 1);

    const notMonitor = deps({ amMonitor: async () => ({ isMonitor: false }), findLocal: async () => [], findRemote: remote });
    const r = await runModelFallbackTick(notMonitor);
    assert.equal(r.switched.length, 0);
    assert.deepEqual(notMonitor.sent, []);
  });

  test('remoteScan=false keeps the monitor local-only', async () => {
    const d = deps({ findLocal: async () => [], remoteScan: false, findRemote: async () => [{ sessionId: 'session_abc', screen: LIMITED('session_abc'), tmux: null }] });
    assert.equal((await runModelFallbackTick(d)).switched.length, 0);
  });

  test('a local detector failure does not sink the remote pass', async () => {
    const d = deps({
      findLocal: async () => { throw new Error('core down'); },
      findRemote: async () => [{ sessionId: 'session_abc', screen: LIMITED('session_abc'), tmux: null }],
    });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 1);
    assert.equal(r.switched[0].sessionId, 'session_abc');
  });

  test('disabled config sends nothing at all', async () => {
    const d = deps({ cfg: { enabled: false, fallbackModel: 'opus', fromModels: ['fable'] } });
    const r = await runModelFallbackTick(d);
    assert.equal(r.switched.length, 0);
    assert.deepEqual(d.sent, []);
  });
});
