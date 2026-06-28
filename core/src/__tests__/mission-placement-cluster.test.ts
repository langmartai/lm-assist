// core/src/__tests__/mission-placement-cluster.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placementAllowed, resolveHostToId, computeMigrationCandidates } from '../mission/mission-controller';

const recs = [
  { gatewayId: 'gw4-rel', cluster: 'release' },
  { gatewayId: 'gw4-dev', cluster: 'dev' },
];

describe('placementAllowed', () => {
  it('undefined/local/cloud always allowed', () => {
    for (const h of [undefined, 'local', 'cloud'] as const) {
      assert.equal(placementAllowed(h, recs as any, 'gw4-rel', 'release'), true);
    }
  });
  it('in-cluster host allowed; out-of-cluster refused', () => {
    assert.equal(placementAllowed('gw4-rel', recs as any, 'gw4-rel', 'release'), true);
    assert.equal(placementAllowed('gw4-dev', recs as any, 'gw4-rel', 'release'), false);
  });
  it('in-cluster host pinned by hostname is allowed; out-of-cluster hostname refused', () => {
    const recs2 = [
      { gatewayId: 'gw4-rel', cluster: 'release', hostname: 'alpha' },
      { gatewayId: 'gw4-dev', cluster: 'dev', hostname: 'beta' },
    ];
    // hostname 'alpha' maps to gw4-rel which is in cluster 'release' — must be allowed
    assert.equal(placementAllowed('alpha', recs2 as any, 'gw4-rel', 'release'), true);
    // hostname 'beta' maps to gw4-dev which is in cluster 'dev' — must be refused
    assert.equal(placementAllowed('beta', recs2 as any, 'gw4-rel', 'release'), false);
    // gatewayId form still works
    assert.equal(placementAllowed('gw4-rel', recs2 as any, 'gw4-rel', 'release'), true);
    assert.equal(placementAllowed('gw4-dev', recs2 as any, 'gw4-rel', 'release'), false);
  });
});

describe('resolveHostToId', () => {
  const recs3 = [
    { gatewayId: 'gw4-rel', cluster: 'release', hostname: 'alpha' },
    { gatewayId: 'gw4-dev', cluster: 'dev', hostname: 'beta' },
  ];
  it('returns gatewayId unchanged when host is already a gatewayId', () => {
    assert.equal(resolveHostToId('gw4-rel', recs3 as any), 'gw4-rel');
    assert.equal(resolveHostToId('gw4-dev', recs3 as any), 'gw4-dev');
  });
  it('resolves hostname to its gatewayId', () => {
    assert.equal(resolveHostToId('alpha', recs3 as any), 'gw4-rel');
    assert.equal(resolveHostToId('beta', recs3 as any), 'gw4-dev');
  });
  it('returns unknown host unchanged (falls through to default cluster)', () => {
    assert.equal(resolveHostToId('unknown-host', recs3 as any), 'unknown-host');
  });
});

describe('computeMigrationCandidates', () => {
  // Inline Mission fixtures (only the fields the helper reads).
  const mkM = (over: {
    id?: string; status?: string; host?: string; node?: string | null;
    sessionId?: string | null; ccr?: { cse: string; sid: string };
  }): any => ({
    id: over.id ?? 'm1',
    status: over.status ?? 'active',
    env: { host: over.host },
    binding: {
      sessionId: over.sessionId ?? null,
      node: over.node ?? null,
      kind: 'worker',
      ...(over.ccr ? { ccr: over.ccr } : {}),
    },
  });

  it('in-cluster bound worker → excluded', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-rel', sessionId: 'session_a' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 0);
  });

  it('out-of-cluster gatewayId → included with cloud transport (session_… sid)', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-dev', sessionId: 'session_a' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].missionId, 'm1');
    assert.equal(out[0].host, 'gw4-dev');
    assert.equal(out[0].sid, 'session_a');
    assert.equal(out[0].transport, 'cloud');
  });

  it('host cloud / local / undefined → excluded (no specific node)', () => {
    const out = computeMigrationCandidates(
      [
        mkM({ id: 'c', node: 'cloud', sessionId: 'session_a' }),
        mkM({ id: 'l', node: 'local', sessionId: 'session_b' }),
        mkM({ id: 'u', node: null, host: undefined, sessionId: 'session_c' }),
      ],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 0);
  });

  it('unknown host with non-default selfCluster → included', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'mystery-node', sessionId: 'session_a' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].host, 'mystery-node');
  });

  it('unknown host but selfCluster === default → excluded', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'mystery-node', sessionId: 'session_a' })],
      [] as any, 'gw-self', 'default',
    );
    assert.equal(out.length, 0);
  });

  it('unbound mission (no sessionId) → excluded', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-dev', sessionId: null })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 0);
  });

  it('non-active mission (done/paused) → excluded; waiting → included', () => {
    const done = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-dev', sessionId: 'session_a', status: 'done' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(done.length, 0);
    const paused = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-dev', sessionId: 'session_a', status: 'paused' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(paused.length, 0);
    const waiting = computeMigrationCandidates(
      [mkM({ id: 'm2', node: 'gw4-dev', sessionId: 'session_a', status: 'waiting' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(waiting.length, 1);
  });

  it('native binding (UUID sessionId + ccr.sid) → sid === ccr.sid, transport native', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: 'gw4-dev', sessionId: 'a1b2c3d4-uuid-native', ccr: { cse: 'cse_x', sid: 'session_native_op' } })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].transport, 'native');
    assert.equal(out[0].sid, 'session_native_op'); // operable sid prefers ccr.sid
  });

  it('falls back to env.host when binding.node is null', () => {
    const out = computeMigrationCandidates(
      [mkM({ id: 'm1', node: null, host: 'gw4-dev', sessionId: 'session_a' })],
      recs as any, 'gw4-rel', 'release',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].host, 'gw4-dev');
  });
});
