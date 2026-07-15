/**
 * POST/PATCH /mission/:id — results writable + UNSUPPORTED_FIELD (mission_3922a14d, 2026-07-15).
 * Spec: docs/superpowers/specs/2026-07-15-mission-patch-results-design.md
 * - resultsAppend: entry|entry[] — ANY actor (controller included; the wrap-flow fix); server
 *   stamps `at`, attributes `by`; append entries allow {ref, summary} only (ref ≤500 required,
 *   summary required ≤2000); caps: ≤20/call, ≤100 total.
 * - results: [...] full-replace requires resultsReplace:true and is HUMAN-only; replace entries
 *   allow {ref, summary?, at?, by?} (round-trip); [] = explicit clear.
 * - Unknown body fields → UNSUPPORTED_FIELD naming offenders + listing the supported set;
 *   meta keys `id` (must match URL) and `_actor` tolerated; nothing applied on any rejection.
 * - `results` joins TRACKED_FIELDS: rev bump, actor attribution, shaped history diff
 *   (append → {count, appended}; replace → full from/to entries, per-field trunc'd).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePatch } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor, type MissionResult } from '../mission/mission-model';

const human: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
const controller: MissionActor = { kind: 'controller', channel: 'controller', node: 'n', at: 1 };

const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => id), id, ...over });

/** Cloning port (simulates LMDB independent reads) so putMission's pre-image diff + history work. */
function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, JSON.parse(JSON.stringify(m)) as Mission]));
  return {
    db,
    isEnabled: () => true,
    get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    list: async () => [...db.values()].map((m) => JSON.parse(JSON.stringify(m))),
    put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id: string) => { db.delete(id); },
  };
}

const entry = (over: Record<string, unknown> = {}) => ({ ref: 'core/src/x.ts', summary: 'did the thing', ...over });
const errOf = (r: unknown) => (r as { error: { code: string; message: string } }).error;

// ── D1: append ──────────────────────────────────────────────────────────────

test('append: single entry stored with stamped at, actor attribution, rev bump, shaped history', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { resultsAppend: entry() }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  const m = port.db.get('a')!;
  assert.equal(m.results.length, 1);
  assert.equal(m.results[0].ref, 'core/src/x.ts');
  assert.equal(m.results[0].summary, 'did the thing');
  assert.ok(m.results[0].at > 0, 'at stamped server-side');
  assert.equal((m.results[0] as MissionResult & { by?: MissionActor }).by?.kind, 'user', 'entry attributed to the acting actor');
  assert.equal(m.rev, 2, 'results is a tracked field — rev bumps');
  assert.equal(m.lastUpdatedBy.kind, 'user');
  const change = m.history[m.history.length - 1];
  assert.equal(change.actor.kind, 'user');
  const diff = change.changes.results as { from: { count: number }; to: { count: number; appended: Array<{ ref: string }> } };
  assert.deepEqual(diff.from, { count: 0 });
  assert.equal(diff.to.count, 1);
  assert.equal(diff.to.appended.length, 1);
  assert.equal(diff.to.appended[0].ref, 'core/src/x.ts');
});

test('append: array of entries; controller actor CAN append (the wrap-flow fix)', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { resultsAppend: [entry(), entry({ ref: 'b.ts', summary: 'second' })] }, port as any, controller);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  const m = port.db.get('a')!;
  assert.equal(m.results.length, 2);
  assert.equal((m.results[1] as MissionResult & { by?: MissionActor }).by?.kind, 'controller');
});

test('append onto existing results preserves prior entries; history diff carries only the tail', async () => {
  const prior: MissionResult = { at: 5, ref: 'old.ts', summary: 'old' };
  const port = memPort([mk('a', { results: [prior] })]);
  const r = await handlePatch('a', { resultsAppend: entry() }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  const m = port.db.get('a')!;
  assert.equal(m.results.length, 2);
  assert.deepEqual(m.results[0], prior);
  const diff = m.history[m.history.length - 1].changes.results as { from: { count: number }; to: { appended: unknown[] } };
  assert.deepEqual(diff.from, { count: 1 });
  assert.equal(diff.to.appended.length, 1);
});

// ── D3: append validation ───────────────────────────────────────────────────

test('append validation: bad entries rejected loudly, nothing applied', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [entry({ ref: '' }), /ref/],
    [{ summary: 'no ref' }, /ref/],
    [entry({ ref: 'x'.repeat(501) }), /ref/],
    [{ ref: 'x.ts' }, /summary/],
    [entry({ summary: '' }), /summary/],
    [entry({ summary: 'x'.repeat(2001) }), /summary/],
    [42, /entry|object/i],
    [[entry(), 42], /entry|object/i],
    [entry({ refs: 'typo' }), /refs/],
    [entry({ at: 123 }), /at/],
    [entry({ by: { kind: 'user' } }), /by/],
    [[], /empty/i],
  ];
  for (const [bad, msgRe] of cases) {
    const port = memPort([mk('a')]);
    const r = await handlePatch('a', { resultsAppend: bad }, port as any, human);
    assert.equal(r.success, false, `must reject resultsAppend=${JSON.stringify(bad)}`);
    assert.equal(errOf(r).code, 'INVALID_INPUT');
    assert.match(errOf(r).message, msgRe);
    assert.equal(port.db.get('a')!.results.length, 0, 'nothing applied on rejection');
    assert.equal(port.db.get('a')!.rev, 1, 'no rev bump on rejection');
  }
});

test('append caps: >20 entries per call and beyond-100 total are rejected; boundaries allowed', async () => {
  const port21 = memPort([mk('a')]);
  const twentyOne = Array.from({ length: 21 }, (_, i) => entry({ ref: `r${i}.ts` }));
  const r1 = await handlePatch('a', { resultsAppend: twentyOne }, port21 as any, human);
  assert.equal(r1.success, false);
  assert.equal(errOf(r1).code, 'INVALID_INPUT');
  assert.equal(port21.db.get('a')!.results.length, 0);

  const hundred = Array.from({ length: 100 }, (_, i) => ({ at: i + 1, ref: `r${i}.ts`, summary: 's' }));
  const portFull = memPort([mk('b', { results: hundred })]);
  const r2 = await handlePatch('b', { resultsAppend: entry() }, portFull as any, human);
  assert.equal(r2.success, false);
  assert.equal(errOf(r2).code, 'INVALID_INPUT');
  assert.equal(portFull.db.get('b')!.results.length, 100);

  // boundaries: exactly 20 per call landing exactly on 100 total is fine
  const eighty = Array.from({ length: 80 }, (_, i) => ({ at: i + 1, ref: `r${i}.ts` }));
  const portOk = memPort([mk('c', { results: eighty as MissionResult[] })]);
  const twenty = Array.from({ length: 20 }, (_, i) => entry({ ref: `n${i}.ts` }));
  const r3 = await handlePatch('c', { resultsAppend: twenty }, portOk as any, human);
  assert.equal(r3.success, true, JSON.stringify(errOf(r3)));
  assert.equal(portOk.db.get('c')!.results.length, 100);
});

// ── D2: replace ─────────────────────────────────────────────────────────────

test('replace with flag (human): replaces, preserves given at/by, stamps missing at, history from/to', async () => {
  const port = memPort([mk('a', { results: [{ at: 5, ref: 'old.ts', summary: 'old' }] })]);
  const keeper = { ref: 'kept.ts', summary: 'curated', at: 42, by: { kind: 'user', channel: 'user', node: 'n', at: 42 } };
  const fresh = { ref: 'fresh.ts', summary: 'new one' };
  const r = await handlePatch('a', { results: [keeper, fresh], resultsReplace: true }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  const m = port.db.get('a')!;
  assert.equal(m.results.length, 2);
  assert.equal(m.results[0].at, 42, 'given at preserved');
  assert.equal((m.results[0] as MissionResult & { by?: MissionActor }).by?.at, 42, 'given by preserved');
  assert.ok(m.results[1].at > 42, 'missing at stamped now');
  const diff = m.history[m.history.length - 1].changes.results as {
    from: { count: number; entries: Array<{ ref: string }> };
    to: { count: number; entries: Array<{ ref: string }> };
  };
  assert.equal(diff.from.count, 1);
  assert.equal(diff.from.entries[0].ref, 'old.ts', 'history carries the wiped entries (recoverable)');
  assert.equal(diff.to.count, 2);
  assert.equal(diff.to.entries.length, 2);
});

test('replace round-trips telemetry-era entries lacking summary (summary optional on replace)', async () => {
  // Seed differs from the written set so a silently-ignored write cannot pass this test.
  const port = memPort([mk('a', { results: [{ at: 1, ref: 'drop.ts', summary: 'to be dropped' }, { at: 5, ref: 'old.ts' }] })]);
  const r = await handlePatch('a', { results: [{ at: 5, ref: 'old.ts' }], resultsReplace: true }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  assert.equal(port.db.get('a')!.results.length, 1);
  assert.equal(port.db.get('a')!.results[0].summary, undefined);
});

test('replace: results:[] with the flag clears explicitly; history keeps the wiped content', async () => {
  const port = memPort([mk('a', { results: [{ at: 5, ref: 'old.ts', summary: 'old' }] })]);
  const r = await handlePatch('a', { results: [], resultsReplace: true }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  const m = port.db.get('a')!;
  assert.equal(m.results.length, 0);
  const diff = m.history[m.history.length - 1].changes.results as { from: { entries: Array<{ ref: string }> }; to: { count: number } };
  assert.equal(diff.from.entries[0].ref, 'old.ts');
  assert.equal(diff.to.count, 0);
});

test('replace rails: missing/false/bad flag, flag without results, both modes, controller FORBIDDEN', async () => {
  const port = memPort([mk('a', { results: [{ at: 1, ref: 'keep.ts' }] })]);

  let r = await handlePatch('a', { results: [entry()] }, port as any, human);
  assert.equal(r.success, false, 'results without the flag must be rejected');
  assert.equal(errOf(r).code, 'INVALID_INPUT');
  assert.match(errOf(r).message, /resultsAppend/, 'guides toward append');

  r = await handlePatch('a', { results: [entry()], resultsReplace: false }, port as any, human);
  assert.equal(r.success, false, 'false flag = no flag');

  r = await handlePatch('a', { results: [entry()], resultsReplace: 'yes' }, port as any, human);
  assert.equal(r.success, false);
  assert.match(errOf(r).message, /resultsReplace/, 'bad flag value named');

  r = await handlePatch('a', { resultsReplace: true }, port as any, human);
  assert.equal(r.success, false, 'flag without results is a caller bug');
  assert.equal(errOf(r).code, 'INVALID_INPUT');

  r = await handlePatch('a', { results: [entry()], resultsReplace: true, resultsAppend: entry() }, port as any, human);
  assert.equal(r.success, false, 'results + resultsAppend in one body is ambiguous');
  assert.equal(errOf(r).code, 'INVALID_INPUT');

  r = await handlePatch('a', { results: [entry()], resultsReplace: true }, port as any, controller);
  assert.equal(r.success, false, 'replace is human-only');
  assert.equal(errOf(r).code, 'FORBIDDEN');

  assert.equal(port.db.get('a')!.results[0].ref, 'keep.ts', 'no rejected path touched the record');
  assert.equal(port.db.get('a')!.rev, 1);
});

test('replace validation: unknown entry key, bad at, non-object by, >100 entries', async () => {
  const port = memPort([mk('a')]);

  let r = await handlePatch('a', { results: [{ ref: 'x.ts', summry: 'typo' }], resultsReplace: true }, port as any, human);
  assert.equal(r.success, false);
  assert.match(errOf(r).message, /summry/);

  r = await handlePatch('a', { results: [{ ref: 'x.ts', at: 'abc' }], resultsReplace: true }, port as any, human);
  assert.equal(r.success, false, 'non-numeric at rejected');

  r = await handlePatch('a', { results: [{ ref: 'x.ts', by: 'me' }], resultsReplace: true }, port as any, human);
  assert.equal(r.success, false, 'non-object by rejected');

  const many = Array.from({ length: 101 }, (_, i) => ({ ref: `r${i}.ts` }));
  r = await handlePatch('a', { results: many, resultsReplace: true }, port as any, human);
  assert.equal(r.success, false, 'total cap applies to replace');
  assert.equal(errOf(r).code, 'INVALID_INPUT');
});

// ── D4: UNSUPPORTED_FIELD ───────────────────────────────────────────────────

test('UNSUPPORTED_FIELD: offenders named, supported set listed, mixed body applies nothing', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { objective: 'new obj', bogusField: 1, another: 'x' }, port as any, human);
  assert.equal(r.success, false);
  assert.equal(errOf(r).code, 'UNSUPPORTED_FIELD');
  assert.match(errOf(r).message, /bogusField/);
  assert.match(errOf(r).message, /another/);
  assert.match(errOf(r).message, /resultsAppend/, 'message lists the supported fields');
  assert.equal(port.db.get('a')!.objective, 'o', 'mixed valid+unknown applies nothing');
  assert.equal(port.db.get('a')!.rev, 1);
});

test('UNSUPPORTED_FIELD: telemetry fields control/interim are rejected loudly now', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { control: { nudgeCount: 9 }, interim: { at: 1, text: 'x' } }, port as any, human);
  assert.equal(r.success, false);
  assert.equal(errOf(r).code, 'UNSUPPORTED_FIELD');
  assert.equal(port.db.get('a')!.control.nudgeCount, 0);
  assert.equal(port.db.get('a')!.interim, undefined);
});

test('meta keys: matching body.id and _actor are tolerated; id mismatch is INVALID_INPUT', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { id: 'a', _actor: { channel: 'mcp', toolUseId: null }, title: 't2' }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  assert.equal(port.db.get('a')!.title, 't2');

  const r2 = await handlePatch('a', { id: 'DIFFERENT', title: 't3' }, port as any, human);
  assert.equal(r2.success, false);
  assert.equal(errOf(r2).code, 'INVALID_INPUT');
  assert.equal(port.db.get('a')!.title, 't2', 'mismatched id applies nothing');
});

// ── connector tolerance ─────────────────────────────────────────────────────

test('connector tolerance: JSON-string resultsAppend/results parse; garbage is loud', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { resultsAppend: JSON.stringify(entry()) }, port as any, human);
  assert.equal(r.success, true, JSON.stringify(errOf(r)));
  assert.equal(port.db.get('a')!.results.length, 1);

  const r2 = await handlePatch('a', { results: JSON.stringify([entry({ ref: 'z.ts' })]), resultsReplace: 'true' }, port as any, human);
  assert.equal(r2.success, true, JSON.stringify(errOf(r2)));
  assert.equal(port.db.get('a')!.results.length, 1);
  assert.equal(port.db.get('a')!.results[0].ref, 'z.ts');

  const r3 = await handlePatch('a', { resultsAppend: 'not json' }, port as any, human);
  assert.equal(r3.success, false);
  assert.equal(errOf(r3).code, 'INVALID_INPUT');
});
