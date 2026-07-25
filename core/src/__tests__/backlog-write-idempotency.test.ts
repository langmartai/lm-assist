/** Regression suite for the 2026-07-25 "backlog_create keeps failing" incident
 *  (voice conversation 4e10ba65) and the duplicate items it left behind.
 *
 *  What the mcp-calls.jsonl log actually shows — the whole incident window held FOUR
 *  failures, every one a deterministic WRITE-path rejection, never a lost ack:
 *    00:43:34.217  backlog_create  7ms     "priority must be one of: low, med, high, critical"  (sent "medium")
 *    00:43:47.064  backlog_create  2661ms  same
 *    00:44:01.191  backlog_create  2378ms  same
 *    00:51:54.266  mission_update  46ms    'unsupported field(s): "node"'
 *  Reads carry no such validation, which is exactly why reads/lists/links kept working
 *  on both clusters while every create failed.
 *
 *  The DUPLICATE pairs are a second, independent defect: the model fires near-identical
 *  creates in ONE assistant turn (bl_1c94e7d7 and its failing sibling were 13ms apart),
 *  each minting a fresh id because nothing dedupes. Hence three mechanisms here:
 *  synonym coercion (the rejection), requestId + exact-repeat idempotency (a retry can
 *  never duplicate), and a non-blocking similarity advisory (near-duplicates get
 *  reported, never refused — a false positive must not eat a legitimate item).
 *
 *  Plus the honest-ack half: a proxy hop that times out is ORIGIN_TIMEOUT ("may have
 *  landed"), never the retry-safe ORIGIN_UNREACHABLE. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBacklogCreate, handleBacklogUpdate } from '../routes/core/backlog.routes';
import { anchorToOrigin, type OriginAnchorDeps } from '../routes/core/origin-anchor';
import {
  normalizePriority, normalizeType, normalizeStatus, titleSimilarity, normalizeTitleKey,
} from '../mcp-server/registry/backlog-model';
import type { BacklogPort } from '../mcp-server/registry/backlog-store';
import type { BacklogDoc } from '../mcp-server/registry/backlog-model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): BacklogPort & { docs: Map<string, BacklogDoc> } {
  const docs = new Map<string, BacklogDoc>();
  return {
    docs,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { docs.set(d.name, d); },
  };
}
const idOf = (r: { data?: unknown }): string => (r.data as { item: { id: string } }).item.id;

// ── 1. the actual rejection: caller-plausible synonyms ─────────────────────

test('THE incident: priority "medium" creates instead of failing, coerced to "med"', async () => {
  const port = memPort();
  const r = await handleBacklogCreate(
    { title: 'Voice conversations should describe sessions by name/purpose, not raw IDs', priority: 'medium' },
    port, actor,
  );
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r.error)}`);
  assert.equal((r.data as { item: { priority: string } }).item.priority, 'med');
});

test('synonym tables cover the words a caller actually reaches for', () => {
  for (const [input, want] of [
    ['medium', 'med'], ['MEDIUM', 'med'], ['  Normal  ', 'med'], ['p2', 'med'],
    ['urgent', 'critical'], ['blocker', 'critical'], ['p0', 'critical'],
    ['important', 'high'], ['p1', 'high'],
    ['minor', 'low'], ['trivial', 'low'], ['nice to have', 'low'],
    ['med', 'med'], ['critical', 'critical'], // canonical values pass through
  ] as const) {
    assert.equal(normalizePriority(input), want, `priority ${input}`);
  }
  for (const [input, want] of [
    ['enhancement', 'feature'], ['improvement', 'feature'],
    ['defect', 'bug'], ['regression', 'bug'],
    ['chore', 'task'], ['proposal', 'idea'], ['incident', 'issue'],
  ] as const) {
    assert.equal(normalizeType(input), want, `type ${input}`);
  }
  for (const [input, want] of [
    ['done', 'implemented'], ['complete', 'implemented'], ['shipped', 'implemented'],
    ['wontfix', 'rejected'], ['in progress', 'planned'], ['wip', 'planned'],
    ['new', 'open'], ['approved', 'accepted'], ['on hold', 'deferred'],
  ] as const) {
    assert.equal(normalizeStatus(input), want, `status ${input}`);
  }
  // genuinely unmappable stays unmappable — coercion must not invent a value
  assert.equal(normalizePriority('spicy'), null);
  assert.equal(normalizeType('banana'), null);
  assert.equal(normalizeStatus('closed'), null, 'ambiguous (implemented? rejected?) — refuse rather than guess');
});

test('an unmappable enum is still refused, and the message ECHOES what was sent', async () => {
  const port = memPort();
  const r = await handleBacklogCreate({ title: 'x', priority: 'spicy' }, port, actor);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'INVALID_INPUT');
  assert.match(r.error!.message, /spicy/, 'the rejected value must appear in the error');
  assert.match(r.error!.message, /low, med, high, critical/);
});

test('update coerces too (status "done" → implemented)', async () => {
  const port = memPort();
  const id = idOf(await handleBacklogCreate({ title: 'ship it' }, port, actor));
  const r = await handleBacklogUpdate(id, { status: 'done', priority: 'urgent' }, port, actor);
  assert.equal(r.success, true, JSON.stringify(r.error));
  const item = (r.data as { item: { status: string; priority: string } }).item;
  assert.equal(item.status, 'implemented');
  assert.equal(item.priority, 'critical');
});

// ── 2. idempotency: a retry can never duplicate ────────────────────────────

test('same requestId twice ⇒ ONE item, same id, second reports idempotent', async () => {
  const port = memPort();
  const body = () => ({ title: 'CCR registry stale entries', requestId: 'req-abc-1' });
  const first = await handleBacklogCreate(body(), port, actor);
  const second = await handleBacklogCreate(body(), port, actor);
  assert.equal(first.success, true);
  assert.equal(second.success, true, JSON.stringify(second.error));
  assert.equal(idOf(second), idOf(first), 'the repeat must resolve to the SAME item');
  assert.equal(port.docs.size, 1, 'no second item was minted');
  assert.equal((second.data as { idempotent?: boolean }).idempotent, true);
  assert.equal((second.data as { changed: boolean }).changed, false);
});

test('a requestId repeat wins even when the payload differs (first write is authoritative)', async () => {
  const port = memPort();
  const a = await handleBacklogCreate({ title: 'original wording', requestId: 'r-9' }, port, actor);
  const b = await handleBacklogCreate({ title: 'rephrased wording', requestId: 'r-9' }, port, actor);
  assert.equal(idOf(b), idOf(a));
  assert.equal(port.docs.size, 1);
  assert.equal((b.data as { item: { title: string } }).item.title, 'original wording');
});

test('CONCURRENT creates sharing a requestId still mint only one item', async () => {
  const port = memPort();
  const [a, b, c] = await Promise.all([
    handleBacklogCreate({ title: 'race', requestId: 'same-key' }, port, actor),
    handleBacklogCreate({ title: 'race', requestId: 'same-key' }, port, actor),
    handleBacklogCreate({ title: 'race', requestId: 'same-key' }, port, actor),
  ]);
  assert.equal(port.docs.size, 1, 'the create lock must serialize same-key creates');
  assert.equal(idOf(b), idOf(a));
  assert.equal(idOf(c), idOf(a));
});

test('an EXACT repeat with no requestId dedupes inside the window, and is free again after it', async () => {
  const port = memPort();
  const body = { title: 'Bootstrap not auto-triggered at session start', description: '## Problem\nsame text' };
  const first = await handleBacklogCreate({ ...body }, port, actor);
  const second = await handleBacklogCreate({ ...body }, port, actor);
  assert.equal(idOf(second), idOf(first));
  assert.equal(port.docs.size, 1);

  // age the item past the window ⇒ the same title is a legitimate NEW item again
  const doc = port.docs.get(idOf(first))!;
  port.docs.set(doc.name, { ...doc, createdAt: Date.now() - 60 * 60 * 1000, updatedAt: Date.now() - 60 * 60 * 1000 });
  const third = await handleBacklogCreate({ ...body }, port, actor);
  assert.notEqual(idOf(third), idOf(first), 'outside the window a repeat title is allowed');
  assert.equal(port.docs.size, 2);
});

test('a differing description is NOT an exact repeat — both items are kept', async () => {
  const port = memPort();
  const a = await handleBacklogCreate({ title: 'same title', description: 'one' }, port, actor);
  const b = await handleBacklogCreate({ title: 'same title', description: 'two — a real elaboration' }, port, actor);
  assert.notEqual(idOf(b), idOf(a));
  assert.equal(port.docs.size, 2);
});

// ── 3. THE lost-ack scenario the mission names ─────────────────────────────

test('lost ack: the write LANDS on the origin, the ack is dropped, the retry does NOT duplicate', async () => {
  const originStore = memPort();   // the origin node's real store
  const local = memPort();         // the calling (non-origin) node — must stay empty
  let dropAck = true;

  const origin: OriginAnchorDeps = {
    getOrigin: async () => 'gw-origin',
    thisNode: () => 'gw-caller',
    proxyPost: async (_n, _p, body) => {
      // the hop reaches the origin and the write COMMITS...
      const res = await handleBacklogCreate({ ...(body as Record<string, unknown>) }, originStore, actor);
      if (dropAck) throw Object.assign(new Error('socket hang up'), { name: 'AbortError' }); // ...then the ack is lost
      return res;
    },
  };

  const payload = () => ({ title: 'Voice replies must name items, not hex ids', requestId: 'idem-77' });

  const lost = await handleBacklogCreate(payload(), local, actor, origin);
  assert.equal(lost.success, false, 'the caller correctly sees a failure');
  assert.equal(lost.error!.code, 'ORIGIN_TIMEOUT', 'and it is flagged as MAY-HAVE-LANDED, not a clean refusal');
  assert.match(lost.error!.message, /may have been applied|may have landed/i);
  assert.match(lost.error!.message, /requestId/, 'the error must tell the caller how to retry safely');
  assert.equal(originStore.docs.size, 1, 'the write really did land');

  dropAck = false;
  const retry = await handleBacklogCreate(payload(), local, actor, origin);
  assert.equal(retry.success, true, JSON.stringify(retry.error));
  assert.equal(originStore.docs.size, 1, 'THE REGRESSION: the retry must not create a second item');
  assert.equal((retry.data as { idempotent?: boolean }).idempotent, true);
  assert.equal(local.docs.size, 0, 'the non-origin node never writes locally');
});

// ── 4. timeout vs rejection, so a caller knows if a retry can duplicate ────

test('anchorToOrigin: a timeout is ORIGIN_TIMEOUT; a plain failure stays ORIGIN_UNREACHABLE', async () => {
  const base = { getOrigin: async () => 'gw-origin', thisNode: () => 'gw-caller' };
  const timedOut = await anchorToOrigin(
    { ...base, proxyPost: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); } },
    '/backlog', {}, 'backlog',
  );
  assert.equal(timedOut!.error!.code, 'ORIGIN_TIMEOUT');

  const refused = await anchorToOrigin(
    { ...base, proxyPost: async () => { throw new Error('ECONNREFUSED 10.0.0.9:443'); } },
    '/backlog', {}, 'backlog',
  );
  assert.equal(refused!.error!.code, 'ORIGIN_UNREACHABLE');
  assert.match(refused!.error!.message, /not applied|no write/i, 'a refused connection never wrote anything');
});

test('anchorToOrigin: a 504 relay body is a TIMEOUT, not an unrecognized response', async () => {
  const r = await anchorToOrigin(
    {
      getOrigin: async () => 'gw-origin', thisNode: () => 'gw-caller',
      proxyPost: async () => ({ status: 504, error: 'Gateway timeout - local API did not respond' }),
    },
    '/backlog', {}, 'backlog',
  );
  assert.equal(r!.error!.code, 'ORIGIN_TIMEOUT');
});

test('an origin-side REFUSAL still relays verbatim (a rejection is retry-safe, not a timeout)', async () => {
  const r = await anchorToOrigin(
    {
      getOrigin: async () => 'gw-origin', thisNode: () => 'gw-caller',
      proxyPost: async () => ({ success: false, error: { code: 'INVALID_INPUT', message: 'priority "spicy" is not valid' } }),
    },
    '/backlog', {}, 'backlog',
  );
  assert.equal(r!.error!.code, 'INVALID_INPUT');
});

// ── 5. near-duplicate advisory (what actually produced the pairs) ──────────

test('a near-duplicate is CREATED but reported, so the caller can link/remove it', async () => {
  const port = memPort();
  const first = await handleBacklogCreate(
    { title: 'CCR remote registry out of sync with live tmux sessions', type: 'bug' }, port, actor,
  );
  const second = await handleBacklogCreate(
    { title: 'CCR remote registry keeps stale entries — dead sessions still registered', type: 'bug' }, port, actor,
  );
  assert.equal(second.success, true, 'similarity must never REFUSE a write');
  assert.notEqual(idOf(second), idOf(first));
  const dups = (second.data as { possibleDuplicates?: { id: string; title: string; score: number }[] }).possibleDuplicates;
  assert.ok(dups && dups.length >= 1, 'the sibling should be surfaced as a possible duplicate');
  assert.equal(dups![0].id, idOf(first));
  assert.ok(dups![0].score >= 0.5, `score ${dups?.[0].score}`);
});

test('unrelated items are not flagged as duplicates', async () => {
  const port = memPort();
  await handleBacklogCreate({ title: 'Safari pinch-zoom renders ghost cards on graph canvas' }, port, actor);
  const r = await handleBacklogCreate({ title: 'Graph export (PNG/SVG) from graph canvases' }, port, actor);
  const dups = (r.data as { possibleDuplicates?: unknown[] }).possibleDuplicates;
  assert.ok(!dups || dups.length === 0, `unexpected duplicates: ${JSON.stringify(dups)}`);
});

test('removed items are not offered as duplicates', async () => {
  const port = memPort();
  const a = await handleBacklogCreate({ title: 'stale registry entries breaking discovery' }, port, actor);
  const doc = port.docs.get(idOf(a))!;
  port.docs.set(doc.name, { ...doc, removed: true });
  const b = await handleBacklogCreate({ title: 'stale registry entries breaking discovery again' }, port, actor);
  const dups = (b.data as { possibleDuplicates?: unknown[] }).possibleDuplicates;
  assert.ok(!dups || dups.length === 0);
});

test('title similarity + key normalization behave', () => {
  assert.equal(normalizeTitleKey('  The  CCR Registry!! '), normalizeTitleKey('the ccr registry'));
  assert.ok(titleSimilarity('CCR remote registry out of sync with sessions', 'CCR remote registry keeps stale session entries') >= 0.5);
  assert.ok(titleSimilarity('Safari pinch zoom ghost cards', 'Graph export PNG SVG') < 0.3);
  assert.equal(titleSimilarity('', 'anything'), 0);
});
