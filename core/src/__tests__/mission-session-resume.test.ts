import { test } from 'node:test';
import assert from 'node:assert';
import { isIdleExpired, handleSessionStatus, handleSessionResume } from '../routes/core/mission.routes';
import type { SessionOpsDeps, SessionProxyDeps, SessionResumeDeps } from '../routes/core/mission.routes';

// ── isIdleExpired ────────────────────────────────────────────────────────────

test('isIdleExpired: returns true when elapsed > idleMin', () => {
  const lastActivityAt = 1000;
  const idleMin = 30;
  const now = lastActivityAt + idleMin * 60_000 + 1;
  assert.strictEqual(isIdleExpired({ lastActivityAt, now, idleMin }), true);
});

test('isIdleExpired: returns false when elapsed === idleMin (boundary, not expired)', () => {
  const lastActivityAt = 1000;
  const idleMin = 30;
  const now = lastActivityAt + idleMin * 60_000;
  assert.strictEqual(isIdleExpired({ lastActivityAt, now, idleMin }), false);
});

test('isIdleExpired: returns false when just touched (elapsed < idleMin)', () => {
  const lastActivityAt = Date.now();
  const now = lastActivityAt + 60_000; // only 1 min elapsed
  assert.strictEqual(isIdleExpired({ lastActivityAt, now, idleMin: 30 }), false);
});

test('isIdleExpired: idleMin=0 — any positive elapsed is expired', () => {
  assert.strictEqual(isIdleExpired({ lastActivityAt: 1000, now: 1001, idleMin: 0 }), true);
});

// ── handleSessionStatus ──────────────────────────────────────────────────────

function makeStatusDeps(overrides: Partial<SessionOpsDeps> = {}): SessionOpsDeps {
  return {
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [], pendingQuestion: null }),
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
    cloudStop: async (sid) => ({ stopped: true, sid }),
    nativeRead: async (_sid) => ({ messages: [] }),
    nativeRawMessages: async (_sid) => ([]),
    nativeDrive: async () => {},
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    resolve: (sid) => ({
      sid,
      transport: sid.startsWith('session_') ? 'cloud' : 'native',
      missionId: null,
      role: 'worker' as const,
    }),
    ...overrides,
  };
}

test('handleSessionStatus: cloud sid → alive=true when cloudStatus resolves non-terminal', async () => {
  const deps = makeStatusDeps();
  const r = await handleSessionStatus('session_abc', deps, undefined, undefined, async (_sid) => ({ sid: _sid, status: 'active', raw: {} }));
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.transport, 'cloud');
  assert.strictEqual(d.alive, true);
});

test('handleSessionStatus: cloud sid → alive=false when cloudStatus returns terminal status', async () => {
  const deps = makeStatusDeps();
  const r = await handleSessionStatus('session_def', deps, undefined, undefined, async (_sid) => ({ sid: _sid, status: 'stopped', raw: {} }));
  assert.ok(r.success);
  const d = (r as any).data;
  assert.strictEqual(d.transport, 'cloud');
  assert.strictEqual(d.alive, false);
});

test('handleSessionStatus: cloud sid → alive=true (grace) when cloudStatus THROWS (transient, not terminal)', async () => {
  const deps = makeStatusDeps();
  const r = await handleSessionStatus('session_gone', deps, undefined, undefined, async () => { throw new Error('429 rate limited'); });
  assert.ok(r.success);
  const d = (r as any).data;
  assert.strictEqual(d.transport, 'cloud');
  // A thrown status is a transport/transient error, not a confirmed terminal status → grace (alive).
  assert.strictEqual(d.alive, true);
});

test('handleSessionStatus: native sid → alive=true when inTmux=true', async () => {
  const deps = makeStatusDeps();
  const r = await handleSessionStatus('4e15ac46-native-alive', deps, undefined, async (_sid) => ({ inTmux: true, tmuxSession: 'lm-abc', driveable: true }));
  assert.ok(r.success);
  const d = (r as any).data;
  assert.strictEqual(d.transport, 'native');
  assert.strictEqual(d.alive, true);
});

test('handleSessionStatus: native sid → alive=false when inTmux=false', async () => {
  const deps = makeStatusDeps();
  const r = await handleSessionStatus('4e15ac46-native-dead', deps, undefined, async (_sid) => ({ inTmux: false, tmuxSession: null, driveable: false }));
  assert.ok(r.success);
  const d = (r as any).data;
  assert.strictEqual(d.transport, 'native');
  assert.strictEqual(d.alive, false);
});

test('handleSessionStatus: node !== self → proxies to proxyPost', async () => {
  let proxiedNode: string | undefined;
  let proxiedPath: string | undefined;
  const pd: SessionProxyDeps = {
    proxyPost: async (node, urlPath, _body) => {
      proxiedNode = node; proxiedPath = urlPath;
      return { success: true, data: { transport: 'cloud', alive: true } };
    },
  };
  const r = await handleSessionStatus('session_abc', undefined, 'other-node', undefined, undefined, pd);
  assert.ok(r.success);
  assert.strictEqual(proxiedNode, 'other-node');
  assert.ok(proxiedPath?.includes('session_abc'));
  assert.ok(proxiedPath?.includes('/status'));
});

// ── handleSessionResume ──────────────────────────────────────────────────────

function makeResumeDeps(overrides: Partial<SessionResumeDeps> = {}): SessionResumeDeps {
  return {
    resolve: (sid) => ({ sid, transport: sid.startsWith('session_') ? 'cloud' : 'native', missionId: null, role: 'worker' as const }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'running' } }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_missionId, sid) => ({ sid, boundAt: Date.now() }),
    idleMin: 30,
    ...overrides,
  };
}

test('handleSessionResume: cloud alive → resumed=true, sid unchanged', async () => {
  const deps = makeResumeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'running' } }),
  });
  const r = await handleSessionResume('session_alive', {}, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.sid, 'session_alive');
  assert.strictEqual(d.transport, 'cloud');
});

test('handleSessionResume: cloud gone (terminal status) → resumed=false, reason=gone', async () => {
  const deps = makeResumeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'stopped', raw: {} }),
  });
  const r = await handleSessionResume('session_gone', {}, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, false);
  assert.strictEqual(d.reason, 'gone');
});

test('handleSessionResume: cloud cloudStatus THROWS (transient) → resumed=true (grace), NOT gone', async () => {
  const deps = makeResumeDeps({
    cloudStatus: async () => { throw new Error('503 service unavailable'); },
  });
  const r = await handleSessionResume('session_blip', {}, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  // A transient error must NOT permanently mark the session gone — treat as still running.
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.reason, 'status-unknown');
});

test('handleSessionResume: cloud TERMINAL status → resumed=false, reason=gone', async () => {
  const deps = makeResumeDeps({
    cloudStatus: async () => ({ status: 'archived' } as any),
  });
  const r = await handleSessionResume('session_archived', {}, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, false);
  assert.strictEqual(d.reason, 'gone');
});

test('handleSessionResume: native resume → SAME sid preserved + autoCloseAt', async () => {
  const sid = '4e15ac46-native-dead';
  const r = await handleSessionResume(sid, { missionId: 'mission_abc' }, makeResumeDeps());
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.sid, sid, 'native resume must preserve the original sessionId');
  assert.strictEqual(d.transport, 'native');
  assert.ok(typeof d.autoCloseAt === 'number');
});

test('handleSessionResume: native refuse → resumed=false, reason=conflict', async () => {
  const r = await handleSessionResume('uuid-conflict', { missionId: 'm' }, makeResumeDeps({
    nativeVerdict: () => ({ connectStrategy: 'refuse', safeToCreateTmux: false, inTmux: false }),
  }));
  assert.strictEqual((r as any).data.resumed, false);
  assert.strictEqual((r as any).data.reason, 'conflict');
});

test('handleSessionResume: cloud idle → resumed=true, reason=ok, cloudWake called', async () => {
  let woke = false;
  const r = await handleSessionResume('session_idle', {}, makeResumeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: { worker_status: 'idle' } }),
    cloudWake: async () => { woke = true; },
  }));
  assert.strictEqual((r as any).data.reason, 'ok');
  assert.strictEqual(woke, true);
});

test('handleSessionResume: native resume uses missionId from body', async () => {
  let capturedMissionId: string | undefined;
  const deps = makeResumeDeps({
    resumeNative: async (missionId, sid) => { capturedMissionId = missionId; return { sid, boundAt: Date.now() }; },
  });
  await handleSessionResume('4e15ac46-native-0001', { missionId: 'mission_xyz' }, deps);
  assert.strictEqual(capturedMissionId, 'mission_xyz');
});

test('handleSessionResume: leader-anchor proxies to leader when not monitor', async () => {
  let proxied = false;
  const leader = {
    getElection: async () => ({ isMonitor: false, monitorNodeId: 'leader-node' }),
    proxyGet: async () => ({ success: true, data: {} }),
    proxyPost: async (_node: string, _path: string, _body: unknown) => {
      proxied = true;
      return { success: true, data: { resumed: true, sid: 'session_leader', transport: 'cloud' } };
    },
  };
  const r = await handleSessionResume('session_test', {}, undefined, undefined, leader);
  assert.ok(r.success);
  assert.ok(proxied, 'should have proxied to leader');
});

test('handleSessionResume: no leader dep → runs locally (no proxy)', async () => {
  // When leader is undefined, runs locally without proxying
  const deps = makeResumeDeps({
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: {} }),
  });
  const r = await handleSessionResume('session_local', {}, deps, undefined, undefined);
  assert.ok(r.success);
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
});
