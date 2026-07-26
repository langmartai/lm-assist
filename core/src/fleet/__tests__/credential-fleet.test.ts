import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCredentials,
  pickCredentialedNode,
  describeNoCredential,
  getCredentialFleet,
  _resetCredentialCache,
  type NodeCredential,
} from '../credential-fleet';

function node(hostId: string, ok: boolean, extra: Partial<NodeCredential> = {}): NodeCredential {
  return {
    hostId,
    displayName: extra.displayName ?? 'somehost',
    cluster: extra.cluster ?? 'prod',
    isSelf: extra.isSelf ?? false,
    cookie: {
      configured: ok,
      ok,
      reason: ok ? 'ok' : 'session_not_configured',
      ...(extra.cookie || {}),
    },
  };
}

// ── merge ───────────────────────────────────────────────────────────────────

test('an unreachable peer is recorded as unreachable, NOT as "no cookie"', () => {
  // The distinction is the whole point: on prod, every remote node reported
  // `cookie:?` because /claude-ai is not relay-reachable — which reads as "no
  // cookie" and sends the caller to the wrong conclusion.
  const m = mergeCredentials(
    node('gw4-self', true, { isSelf: true }),
    [{ node: 'gw4-peer', snap: null }],
    'fleet',
    123,
  );
  assert.deepEqual(m.unreachable, ['gw4-peer']);
  assert.equal(m.nodes.length, 1, 'an unreachable peer contributes no node record');
  assert.equal(m.partial, true);
  assert.equal(m.generatedAt, 123);
});

test('all peers reachable ⇒ not partial', () => {
  const m = mergeCredentials(
    node('gw4-self', true, { isSelf: true }),
    [{ node: 'gw4-b', snap: node('gw4-b', false) }],
    'cluster',
    1,
  );
  assert.equal(m.partial, false);
  assert.deepEqual(m.unreachable, []);
  assert.equal(m.nodes.length, 2);
});

// ── selection policy ────────────────────────────────────────────────────────

test('prefers SELF when self holds a working cookie (no hop)', () => {
  const c = mergeCredentials(
    node('gw4-self', true, { isSelf: true }),
    [{ node: 'gw4-peer', snap: node('gw4-peer', true) }],
    'fleet',
    1,
  );
  const picked = pickCredentialedNode(c);
  assert.equal(picked.reason, 'self');
  assert.equal(picked.node?.hostId, 'gw4-self');
});

test('routes to a credentialed PEER when self has no cookie', () => {
  const c = mergeCredentials(
    node('gw4-self', false, { isSelf: true }),
    [{ node: 'gw4-peer', snap: node('gw4-peer', true) }],
    'fleet',
    1,
  );
  const picked = pickCredentialedNode(c);
  assert.equal(picked.reason, 'peer');
  assert.equal(picked.node?.hostId, 'gw4-peer');
});

test('peer choice is deterministic when several are eligible', () => {
  const c = mergeCredentials(
    node('gw4-self', false, { isSelf: true }),
    [
      { node: 'gw4-zzz', snap: node('gw4-zzz', true) },
      { node: 'gw4-aaa', snap: node('gw4-aaa', true) },
    ],
    'fleet',
    1,
  );
  assert.equal(pickCredentialedNode(c).node?.hostId, 'gw4-aaa');
});

test('nothing eligible ⇒ null, never a hopeful guess', () => {
  const c = mergeCredentials(node('gw4-self', false, { isSelf: true }), [], 'fleet', 1);
  const picked = pickCredentialedNode(c);
  assert.equal(picked.node, null);
  assert.equal(picked.reason, 'none');
});

test('an explicit node request is honoured when it is credentialed', () => {
  const c = mergeCredentials(
    node('gw4-self', true, { isSelf: true }),
    [{ node: 'gw4-peer', snap: node('gw4-peer', true) }],
    'fleet',
    1,
  );
  const picked = pickCredentialedNode(c, { requested: 'gw4-peer' });
  assert.equal(picked.reason, 'requested');
  assert.equal(picked.node?.hostId, 'gw4-peer');
});

test('an explicit request that is NOT credentialed is refused, never silently rerouted', () => {
  // node choice implicitly selects an ACCOUNT — quietly serving from a different
  // node could land a fork in the wrong person's account.
  const c = mergeCredentials(
    node('gw4-self', true, { isSelf: true }),
    [{ node: 'gw4-peer', snap: node('gw4-peer', false) }],
    'fleet',
    1,
  );
  const picked = pickCredentialedNode(c, { requested: 'gw4-peer' });
  assert.equal(picked.node, null);
  assert.equal(picked.reason, 'requested-not-eligible');
});

test('an unknown requested node is refused', () => {
  const c = mergeCredentials(node('gw4-self', true, { isSelf: true }), [], 'fleet', 1);
  assert.equal(pickCredentialedNode(c, { requested: 'gw4-nope' }).reason, 'requested-not-eligible');
});

// ── the refusal message ─────────────────────────────────────────────────────

test('refusal names eligible hostIds so the caller can retry', () => {
  const c = mergeCredentials(
    node('gw4-self', false, { isSelf: true, displayName: 'boxA' }),
    [{ node: 'gw4-good', snap: node('gw4-good', true, { displayName: 'boxB', cookie: { configured: true, ok: true, reason: 'ok', organizationName: 'Acme' } }) }],
    'fleet',
    1,
  );
  const msg = describeNoCredential(c, 'gw4-self');
  assert.match(msg, /gw4-good/, 'must name the node that CAN serve it');
  assert.match(msg, /Acme/, 'must surface which account, so a fork cannot land silently');
});

test('refusal distinguishes "could not be checked" from "no cookie"', () => {
  const c = mergeCredentials(node('gw4-self', false, { isSelf: true }), [{ node: 'gw4-dark', snap: null }], 'fleet', 1);
  const msg = describeNoCredential(c);
  assert.match(msg, /NOT "no cookie"/);
  assert.match(msg, /gw4-dark/);
});

test('refusal points at the remedy and states the IP-pinning constraint', () => {
  const c = mergeCredentials(node('gw4-self', false, { isSelf: true }), [], 'fleet', 1);
  const msg = describeNoCredential(c);
  assert.match(msg, /claudeai_login/);
  assert.match(msg, /IP-pinned/);
});

test('refusal reports hostId, never only a display name', () => {
  // Measured on prod: `vm` appeared 4x and `ubuntu-Virtual-Machine` 3x in one
  // sweep, and a dev Core appends " (dev)". A display name cannot route.
  const c = mergeCredentials(node('gw4-self', false, { isSelf: true, displayName: 'vm' }), [], 'fleet', 1);
  assert.match(describeNoCredential(c), /gw4-self/);
});

// ── composition ─────────────────────────────────────────────────────────────

test('composition asks peers over /fleet/credentials/local and unwraps the envelope', async () => {
  _resetCredentialCache();
  const asked: string[] = [];
  const c = await getCredentialFleet('fleet', {
    getLocal: async () => node('gw4-self', false, { isSelf: true }),
    listOnline: async () => ['gw4-self', 'gw4-peer'],
    clusterMap: async () => new Map([['gw4-peer', 'prod']]),
    myCluster: () => 'prod',
    selfId: () => 'gw4-self',
    proxyGet: async (n, p) => {
      asked.push(`${n}${p}`);
      return { data: node('gw4-peer', true) };
    },
    now: () => 5,
  });
  assert.deepEqual(asked, ['gw4-peer/fleet/credentials/local'], 'self is never proxied to itself');
  assert.equal(c.nodes.length, 2);
  assert.equal(pickCredentialedNode(c).node?.hostId, 'gw4-peer');
});

test('a throwing peer degrades to unreachable instead of failing the survey', async () => {
  _resetCredentialCache();
  const c = await getCredentialFleet('fleet', {
    getLocal: async () => node('gw4-self', true, { isSelf: true }),
    listOnline: async () => ['gw4-peer'],
    clusterMap: async () => new Map(),
    myCluster: () => 'prod',
    selfId: () => 'gw4-self',
    proxyGet: async () => { throw new Error('relay 403'); },
    now: () => 5,
  });
  assert.deepEqual(c.unreachable, ['gw4-peer']);
  assert.equal(c.partial, true);
  assert.equal(pickCredentialedNode(c).node?.hostId, 'gw4-self', 'self still serves');
});

test('cluster scope excludes out-of-cluster peers', async () => {
  _resetCredentialCache();
  const asked: string[] = [];
  await getCredentialFleet('cluster', {
    getLocal: async () => node('gw4-self', true, { isSelf: true }),
    listOnline: async () => ['gw4-mine', 'gw4-other'],
    clusterMap: async () => new Map([['gw4-mine', 'prod'], ['gw4-other', 'staging']]),
    myCluster: () => 'prod',
    selfId: () => 'gw4-self',
    proxyGet: async (n) => { asked.push(n); return { data: node(n, true) }; },
    now: () => 5,
  });
  assert.deepEqual(asked, ['gw4-mine']);
});
