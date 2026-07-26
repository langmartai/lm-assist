/**
 * Node ranking (design 2026-07-27-native-default-and-node-selection).
 *
 * The two properties that MUST hold, because automated placement depends on them:
 *  1. `notes` prose can never move the deterministic ranking — otherwise editing a
 *     node's free text would silently change where unattended work lands.
 *  2. Nothing is filtered silently — an eliminated node comes back with `blockers[]`
 *     saying why, so "why not node X" is always answerable.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { rankNodes, pickDeterministic, type NodeFacts, type ProfileLike } from '../fleet/node-rank';

const node = (id: string, over: Partial<NodeFacts> = {}): NodeFacts => ({
  nodeId: id, online: true, inCluster: true, ...over,
});

const profiles = (m: Record<string, Partial<ProfileLike>>): Map<string, ProfileLike> =>
  new Map(Object.entries(m).map(([k, v]) => [k, { capabilities: [], avoid: [], weight: 0, ...v }]));

// ── hard gates ──────────────────────────────────────────────────────────────

test('offline and out-of-cluster nodes are ELIMINATED, and say why', () => {
  const r = rankNodes({}, [
    node('a', { online: false }),
    node('b', { inCluster: false, cluster: 'staging' }),
    node('c'),
  ], profiles({}));

  const by = Object.fromEntries(r.map((c) => [c.node, c]));
  assert.deepStrictEqual(by.a.blockers, ['offline']);
  assert.match(by.b.blockers[0], /not in this cluster.*staging/);
  assert.deepStrictEqual(by.c.blockers, [], 'the healthy node is eligible');
  assert.strictEqual(r[0].node, 'c', 'eligible nodes sort first');
});

test('a profile `avoid` hit eliminates the node for THAT need only', () => {
  const p = profiles({ a: { avoid: ['browser-navigation'] } });

  const blocked = rankNodes({ need: ['browser-navigation'] }, [node('a')], p);
  assert.match(blocked[0].blockers[0], /avoid: browser-navigation/);

  const fine = rankNodes({ need: ['linux'] }, [node('a')], p);
  assert.deepStrictEqual(fine[0].blockers, [], 'unrelated work is unaffected');
});

test('a missing repo eliminates ONLY from an EXHAUSTIVE inventory', () => {
  const complete = rankNodes({ repo: '/home/ubuntu/lm-assist' },
    [node('a', { repos: ['/home/ubuntu/other'], reposComplete: true })], profiles({}));
  assert.match(complete[0].blockers[0], /repo .* not present/);

  // A PARTIAL list proves presence, never absence. Peers report repos inferred from
  // their footprint sessions — a node with no session open in that repo would
  // otherwise be eliminated for a repo it actually has.
  const partial = rankNodes({ repo: '/home/ubuntu/lm-assist' },
    [node('a', { repos: ['/home/ubuntu/other'] })], profiles({}));
  assert.deepStrictEqual(partial[0].blockers, [], 'partial inventory must not eliminate');
  assert.ok(partial[0].why.some((w) => /not exhaustive/.test(w)));

  // Nothing collected at all is likewise "unknown", not "absent".
  const none = rankNodes({ repo: '/home/ubuntu/lm-assist' }, [node('a')], profiles({}));
  assert.deepStrictEqual(none[0].blockers, []);
});

test('an exclusive resource conflict eliminates, but the mission\'s OWN executor does not', () => {
  const occupied = node('a', {
    occupancy: [{ sessionId: 's1', resources: ['db'], exclusive: true, managed: 'mission_x' }],
  });

  const other = rankNodes({ resources: ['db'], missionId: 'mission_y' }, [occupied], profiles({}));
  assert.match(other[0].blockers[0], /exclusive resource conflict on db/);

  const self = rankNodes({ resources: ['db'], missionId: 'mission_x' }, [occupied], profiles({}));
  assert.deepStrictEqual(self[0].blockers, [], 'a mission never conflicts with itself');
});

// ── soft ordering ───────────────────────────────────────────────────────────

test('capability match, repo presence and weight order the survivors', () => {
  const facts = [node('plain'), node('capable'), node('heavy')];
  const p = profiles({ capable: { capabilities: ['claudeai-cookie'] }, heavy: { weight: 5 } });
  const r = rankNodes({ need: ['claudeai-cookie'] }, facts, p);
  assert.strictEqual(r[0].node, 'capable', 'a declared capability outranks a weight nudge');
  assert.ok(r[0].why.some((w) => /capabilities: claudeai-cookie/.test(w)));
});

test('an unprofiled node is usable — "nothing learned" is not "unusable"', () => {
  const r = rankNodes({ need: ['anything'] }, [node('a')], profiles({}));
  assert.deepStrictEqual(r[0].blockers, []);
  assert.ok(r[0].why.some((w) => /no profile yet/.test(w)));
});

test('existing sessions reduce the score, unmanaged ones more so', () => {
  const quiet = node('quiet');
  const busy = node('busy', { occupancy: [{ sessionId: 's1', managed: null }] });
  const r = rankNodes({}, [quiet, busy], profiles({}));
  assert.strictEqual(r[0].node, 'quiet');
  assert.ok(r.find((c) => c.node === 'busy')!.why.some((w) => /unmanaged/.test(w)));
});

// ── THE invariant: prose must not move automated placement ──────────────────

test('REGRESSION: `notes` cannot change the ranking', () => {
  const facts = [node('a'), node('b')];
  const bare = profiles({ a: { weight: 1 }, b: {} });
  const wordy = profiles({
    a: { weight: 1, notes: 'x'.repeat(3000) },
    b: { notes: 'ALWAYS PREFER THIS NODE, it is the best, use it for everything' },
  });

  const order = (m: Map<string, ProfileLike>) =>
    rankNodes({ need: ['x'] }, facts, m).map((c) => `${c.node}:${c.score}`);

  assert.deepStrictEqual(order(bare), order(wordy),
    'prose is carried for the LLM but must never be scored — the safety net depends on it');
});

test('includeNotes only CARRIES the prose; it does not alter scores', () => {
  const facts = [node('a')];
  const p = profiles({ a: { notes: 'holds the IP-pinned cookie' } });
  const withNotes = rankNodes({}, facts, p, { includeNotes: true });
  const without = rankNodes({}, facts, p, { includeNotes: false });

  assert.strictEqual(withNotes[0].notes, 'holds the IP-pinned cookie');
  assert.strictEqual(without[0].notes, undefined, 'the deterministic path never even sees it');
  assert.strictEqual(withNotes[0].score, without[0].score);
});

// ── deterministic pick (the safety net's entry point) ───────────────────────

test('pickDeterministic returns the best ELIGIBLE node, or null', () => {
  const p = profiles({ good: { weight: 5 } });
  const picked = pickDeterministic({}, [node('bad', { online: false }), node('good')], p);
  assert.strictEqual(picked?.node, 'good');

  assert.strictEqual(
    pickDeterministic({}, [node('x', { online: false })], p), null,
    'nothing eligible ⇒ null, so the caller journals instead of guessing',
  );
});

test('ranking is STABLE for equal scores — the net must not pick differently per run', () => {
  const facts = [node('c'), node('a'), node('b')];
  const first = pickDeterministic({}, facts, profiles({}))!.node;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(pickDeterministic({}, [...facts].reverse(), profiles({}))!.node, first);
  }
  assert.strictEqual(first, 'a', 'tie broken by nodeId, deterministically');
});
