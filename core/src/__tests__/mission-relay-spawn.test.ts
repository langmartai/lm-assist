/**
 * Step B — placing a mission on a node that is NOT the leader (bl_1c861246).
 *
 * The failure this suite exists to prevent, in the human's words: "a blind retry on
 * ORIGIN_TIMEOUT = two executors on the same mission, on two machines. On prod."
 *
 * 🔴 The outcome CANNOT be read off the HTTP status. Measured live from prod 117:
 *   • peer refusal      → HTTP **400**  {"success":false,"error":{"code":"MISSION_NOT_FOUND",…}}
 *   • hub, no such node → HTTP **404**  {"error":"Machine not found","message":"Worker not found"}
 *   • success           → HTTP  200  {"success":true,"data":{…}}
 * Two non-2xx statuses with opposite meanings — one means "nothing happened, safe", the other
 * means "the peer answered". The discriminator is the SHAPE of the body: a `success` boolean is
 * the peer's own envelope; its ABSENCE means the answer did not come from the peer at all and
 * carries no information about whether the spawn ran. That is the exact shape that once let a
 * relay 504 through as a successful write on the backlog path.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyRelayResponse, relaySpawn, shouldRelaySpawn, type RelaySpawnDeps } from '../mission/relay-spawn';

// ── the discriminator, against the shapes actually observed ────────────────

test('a peer envelope with success:true is PLACED', () => {
  const r = classifyRelayResponse({ httpStatus: 200, body: { success: true, data: { binding: { sessionId: 'sid-1' } } } });
  assert.strictEqual(r.status, 'placed');
  assert.deepStrictEqual((r as { binding: unknown }).binding, { sessionId: 'sid-1' });
});

test('a peer envelope with success:false is REFUSED — nothing spawned, even on HTTP 400', () => {
  const r = classifyRelayResponse({
    httpStatus: 400,
    body: { success: false, error: { code: 'MISSION_NOT_FOUND', message: 'mission x not found' } },
  });
  assert.strictEqual(r.status, 'refused', 'the peer answered — a refusal is information, not a failure');
  assert.strictEqual((r as { code: string }).code, 'MISSION_NOT_FOUND');
});

test('the hub saying the node is not connected is UNREACHABLE — never dispatched', () => {
  const r = classifyRelayResponse({
    httpStatus: 404,
    body: { error: 'Machine not found', message: 'Worker not found' },
  });
  assert.strictEqual(r.status, 'unreachable', 'nothing was delivered, so a retry is free');
});

test('🔴 a 200 whose body has NO success key is UNVERIFIED, never placed', () => {
  // The backlog-path hazard, exactly: a relay body with no `success` slipping through as a
  // successful write. A 2xx from an intermediary says nothing about what the peer did.
  const r = classifyRelayResponse({ httpStatus: 200, body: { ok: true, note: 'proxied' } });
  assert.strictEqual(r.status, 'unverified');
});

test('an unparseable body is UNVERIFIED, not unreachable', () => {
  const r = classifyRelayResponse({ httpStatus: 502, raw: '<html>Bad Gateway</html>' });
  assert.strictEqual(r.status, 'unverified', 'a gateway error cannot prove the spawn did not run');
});

test('a thrown/aborted request is UNVERIFIED — it may have landed', () => {
  const r = classifyRelayResponse({ threw: 'AbortError: timeout' });
  assert.strictEqual(r.status, 'unverified');
});

test('a 404 that is NOT the hub machine-not-found marker stays UNVERIFIED', () => {
  const r = classifyRelayResponse({ httpStatus: 404, body: { error: 'something else' } });
  assert.strictEqual(r.status, 'unverified', 'only the hub\'s own "not connected" answer proves non-delivery');
});

// ── relaySpawn: verify by RE-READING, never by re-sending ──────────────────

function deps(over: Partial<RelaySpawnDeps> = {}, calls: { posts: number[]; reads: number[] } = { posts: [], reads: [] }): RelaySpawnDeps {
  return {
    post: async () => { calls.posts.push(1); return { httpStatus: 200, body: { success: true, data: { binding: { sessionId: 'sid-ok' } } } }; },
    readMission: async () => { calls.reads.push(1); return { binding: { sessionId: 'sid-ok' } }; },
    sleep: async () => {},
    verifyAttempts: 3,
    ...over,
  };
}

test('a clean relay places and never needs to verify', async () => {
  const calls = { posts: [] as number[], reads: [] as number[] };
  const r = await relaySpawn('gw4-peer', 'mission_a', 'req-1', deps({}, calls));
  assert.strictEqual(r.status, 'placed');
  assert.strictEqual(calls.posts.length, 1);
  assert.strictEqual(calls.reads.length, 0, 'a definite answer needs no re-read');
});

test('🔴 THE REGRESSION: an unverified relay NEVER re-sends — it re-reads', async () => {
  const calls = { posts: [] as number[], reads: [] as number[] };
  const r = await relaySpawn('gw4-peer', 'mission_a', 'req-1', deps({
    post: async () => { calls.posts.push(1); return { threw: 'AbortError: timeout' }; },
    readMission: async () => { calls.reads.push(1); return { binding: null }; },
  }, calls));

  assert.strictEqual(calls.posts.length, 1, 'a second POST is how you get two executors on one mission');
  assert.ok(calls.reads.length >= 1, 'the ambiguity is resolved by reading the target, not by guessing');
  assert.strictEqual(r.status, 'unverified', 'still ambiguous after re-reads ⇒ stays unverified, for a human');
});

test('a timeout whose spawn DID land is discovered by the re-read and reported placed', async () => {
  const calls = { posts: [] as number[], reads: [] as number[] };
  let n = 0;
  const r = await relaySpawn('gw4-peer', 'mission_a', 'req-1', deps({
    post: async () => { calls.posts.push(1); return { threw: 'AbortError: timeout' }; },
    // The peer was mid-persist on the first look; the binding shows up on the second.
    readMission: async () => { calls.reads.push(1); return ++n >= 2 ? { binding: { sessionId: 'sid-late' } } : { binding: null }; },
  }, calls));

  assert.strictEqual(r.status, 'placed');
  assert.deepStrictEqual((r as { binding: unknown }).binding, { sessionId: 'sid-late' });
  assert.strictEqual(calls.posts.length, 1, 'and still exactly one POST');
});

test('an UNREACHABLE node is not re-read — nothing was delivered to look for', async () => {
  const calls = { posts: [] as number[], reads: [] as number[] };
  const r = await relaySpawn('gw4-peer', 'mission_a', 'req-1', deps({
    post: async () => { calls.posts.push(1); return { httpStatus: 404, body: { error: 'Machine not found', message: 'Worker not found' } }; },
  }, calls));
  assert.strictEqual(r.status, 'unreachable');
  assert.strictEqual(calls.reads.length, 0);
});

test('a read that throws during verification does not turn ambiguity into success', async () => {
  const r = await relaySpawn('gw4-peer', 'mission_a', 'req-1', deps({
    post: async () => ({ threw: 'socket hang up' }),
    readMission: async () => { throw new Error('peer unreachable for read too'); },
  }));
  assert.strictEqual(r.status, 'unverified');
});

test('the requestId travels with the spawn so the target can dedupe it', async () => {
  let seen: Record<string, unknown> | undefined;
  await relaySpawn('gw4-peer', 'mission_a', 'req-XYZ', deps({
    post: async (_n: string, _p: string, body: unknown) => { seen = body as Record<string, unknown>; return { httpStatus: 200, body: { success: true, data: {} } }; },
  }));
  assert.strictEqual(seen?.requestId, 'req-XYZ', 'without it, a re-read-then-retry could double-spawn');
});

// ── the in-flight gate ─────────────────────────────────────────────────────

const NOW = 1_000_000_000;

test('a mission with a FRESH in-flight relay is not relayed again', () => {
  assert.strictEqual(
    shouldRelaySpawn({ spawnInFlight: { node: 'gw4-peer', requestId: 'r1', at: NOW - 60_000 } }, NOW, 300_000),
    false,
    'the first relay is still outstanding — sending another is the duplicate-executor path',
  );
});

test('a STALE in-flight marker is retried (the leader may have died mid-flight)', () => {
  assert.strictEqual(
    shouldRelaySpawn({ spawnInFlight: { node: 'gw4-peer', requestId: 'r1', at: NOW - 600_000 } }, NOW, 300_000),
    true,
  );
});

test('no marker at all ⇒ relay', () => {
  assert.strictEqual(shouldRelaySpawn({}, NOW, 300_000), true);
});

// ── target-side dedupe: the same requestId must never spawn twice ──────────
//
// The window `ALREADY_BOUND` cannot close: request in flight, binding not yet persisted,
// a second request arrives. `requestId` is recorded in the SAME persist as the binding, so
// a repeat resolves to the stored binding instead of launching a second executor.

import { handleMissionSpawn, type MissionSpawnDeps } from '../routes/core/mission.routes';

function spawnDeps(state: { mission: Record<string, unknown> }, calls: { started: number }): MissionSpawnDeps {
  return {
    getMission: async () => state.mission,
    listMissions: async () => [],
    place: () => ({ go: true, env: 'shared', repo: '/tmp/ws' }) as never,
    startNative: async () => { calls.started++; return { sessionId: `sid-${calls.started}`, node: 'local', kind: 'worker', boundAt: 1 } as never; },
    buildNativeDeps: async () => ({}) as never,
    persist: async (m) => { state.mission = m as Record<string, unknown>; },
  };
}

test('🔴 the SAME requestId does not spawn a second executor', async () => {
  const state = { mission: { id: 'mission_r1', title: 't', objective: 'o', status: 'waiting', binding: null, env: {}, control: {} } as Record<string, unknown> };
  const calls = { started: 0 };

  const first = await handleMissionSpawn('mission_r1', { requestId: 'req-A' }, spawnDeps(state, calls));
  assert.strictEqual(first.success, true);
  assert.strictEqual(calls.started, 1);

  const second = await handleMissionSpawn('mission_r1', { requestId: 'req-A' }, spawnDeps(state, calls));

  assert.strictEqual(second.success, true, 'a repeat of a landed request is a SUCCESS, not an error — it already ran');
  assert.strictEqual(calls.started, 1, 'two executors on one mission is the failure this whole path exists to prevent');
  assert.strictEqual((second.data as { idempotent?: boolean }).idempotent, true);
  assert.strictEqual((second.data as { binding?: { sessionId?: string } }).binding?.sessionId, 'sid-1');
});

test('a DIFFERENT requestId on a bound mission still refuses with ALREADY_BOUND', async () => {
  const state = { mission: { id: 'mission_r2', title: 't', objective: 'o', status: 'active', binding: { sessionId: 'sid-x', kind: 'worker' }, env: {}, control: { lastSpawnRequest: 'req-A' } } as Record<string, unknown> };
  const calls = { started: 0 };
  const r = await handleMissionSpawn('mission_r2', { requestId: 'req-B' }, spawnDeps(state, calls));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error?.code, 'ALREADY_BOUND');
  assert.strictEqual(calls.started, 0);
});

// ── binding provenance: the field the Step-B proof actually reads ──────────
//
// Measured on the prod probe (mission_8a064264): `env.host` held the chosen gateway id, but
// `binding.node` came back **"local"**. `place()`'s `shared` branch returned no `host`, so
// startNativeExecutor's `decision.host || 'local'` fell back. Harmless while every spawn was
// local; fatal for a relayed one, where `binding.node` is the ONLY record of which machine
// the worker is on — and the exact field the proof is read from.

import { place, type Mission as M } from '../mission/mission-model';

function sharedMission(host?: string): M {
  return {
    id: 'mission_prov', title: 't', objective: 'o', dependsOn: [], projects: [], tags: {}, parentId: null,
    env: { isolation: 'shared', resources: [], ...(host ? { host } : {}) }, status: 'waiting', binding: null,
    progress: null, control: { nudgeCount: 0, backoffStep: 0 }, results: [], adjustments: [],
    rev: 1, history: [], ownerNode: 'gw4-a', createdAt: 1, updatedAt: 1,
  } as unknown as M;
}

test('🔴 a shared placement carries the HOST, so the binding can name the real machine', () => {
  const d = place(sharedMission('gw4-peer'), []) as { go: boolean; env: string; host?: string };
  assert.strictEqual(d.env, 'shared');
  assert.strictEqual(d.host, 'gw4-peer', 'without this the binding records "local" for a worker on another machine');
});

test('a shared placement with no host is unchanged — still falls back to local', () => {
  const d = place(sharedMission(), []) as { go: boolean; env: string; host?: string };
  assert.strictEqual(d.host ?? '', '', 'no host chosen ⇒ nothing to record; the legacy local spawn is untouched');
});

test('the spawned binding NAMES the host end-to-end', async () => {
  const state = { mission: { id: 'mission_prov2', title: 't', objective: 'o', status: 'waiting', binding: null, dependsOn: [], env: { isolation: 'shared', resources: [], host: 'gw4-peer' }, control: {} } as Record<string, unknown> };
  const calls = { started: 0 };
  const captured: Array<Record<string, unknown>> = [];
  const r = await handleMissionSpawn('mission_prov2', {}, {
    getMission: async () => state.mission,
    listMissions: async () => [],
    // the REAL place(), not a stub — the bug lived in it
    startNative: async (_m, decision) => {
      captured.push(decision as Record<string, unknown>);
      calls.started++;
      return { sessionId: 'sid-1', node: (decision as { host?: string }).host || 'local', kind: 'worker', boundAt: 1 } as never;
    },
    buildNativeDeps: async () => ({}) as never,
    persist: async (m) => { state.mission = m as Record<string, unknown>; },
  });
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as { binding: { node: string } }).binding.node, 'gw4-peer',
    'binding.node is the only durable record of WHICH MACHINE the worker is on');
});

// ── 🔴 success:false is NOT proof that nothing happened ────────────────────
//
// Caught live on stage 2026-07-28, not by reasoning. The relayed spawn to the Windows node
// came back `{"success":false,"error":{"code":"INTERNAL_ERROR"}}` and was classified
// `refused` — "the peer answered, nothing spawned, safe". But 107's log showed
// `[ApiRelayHandler] Error relaying request …: Error: Local API request timeout`: the
// envelope was produced by the RELAY LAYER while its own local call to the route was STILL
// RUNNING. The handler had not declined anything.
//
// So the original rule was unsound one level deeper than the design caught: a body WITHOUT
// `success` says nothing, and a body WITH `success:false` also says nothing unless the code
// identifies a decision the ROUTE made. Only a known route-level refusal is safe; everything
// else must be verified by reading the target.

test('🔴 a relay-layer INTERNAL_ERROR is UNVERIFIED — the route may still be running', () => {
  const r = classifyRelayResponse({ httpStatus: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Local API request timeout' } } });
  assert.strictEqual(r.status, 'unverified',
    'treating this as "refused" tells the caller nothing spawned while the spawn is in flight — the duplicate-executor path');
});

test('a route-level refusal is still REFUSED — those are real decisions', () => {
  for (const code of ['MISSION_NOT_FOUND', 'PLACEMENT_NOT_GO', 'CLOUD_PLACEMENT', 'ALREADY_BOUND', 'BAD_KIND']) {
    const r = classifyRelayResponse({ httpStatus: 400, body: { success: false, error: { code } } });
    assert.strictEqual(r.status, 'refused', `${code} is the handler declining, not the transport failing`);
  }
});

test('an UNKNOWN error code is unverified, not assumed safe', () => {
  const r = classifyRelayResponse({ httpStatus: 400, body: { success: false, error: { code: 'SOMETHING_NEW' } } });
  assert.strictEqual(r.status, 'unverified', 'a closed list fails safe — a new code must not silently mean "nothing happened"');
});
