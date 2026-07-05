import { test } from 'node:test';
import assert from 'node:assert';
import { classifyExecutorActivity, shouldEngage } from '../mission/mission-engagement';

test('classify: liveness drop → material', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 3 }, { alive: false, gated: false, cursor: 3, newLines: [] });
  assert.equal(a.material, true);
});

test('classify: gate transition → material', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 3 }, { alive: true, gated: true, cursor: 3, newLines: [] });
  assert.equal(a.material, true);
});

test('classify: status marker in new output → material', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 3 }, { alive: true, gated: false, cursor: 4, newLines: ['⟦WORKER-STATUS⟧ done'] });
  assert.equal(a.material, true);
});

test('classify: only cursor advance → interim (last line summary)', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 3 }, { alive: true, gated: false, cursor: 5, newLines: ['building...', 'running tests'] });
  assert.equal(a.material, false);
  assert.equal(a.interim?.summary, 'running tests');
});

test('classify: no change → neither', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 3 }, { alive: true, gated: false, cursor: 3, newLines: [] });
  assert.equal(a.material, false);
  assert.equal(a.interim, undefined);
});

test('classify: first sighting (no prev) + new output → interim, not material', () => {
  const a = classifyExecutorActivity(undefined, { alive: true, gated: false, cursor: 2, newLines: ['hello', 'world'] });
  assert.equal(a.material, false);
  assert.equal(a.interim?.summary, 'world');
});

test('classify: marker present but cursor NOT advanced → not material (already seen, no re-engage)', () => {
  const a = classifyExecutorActivity({ alive: true, gated: false, cursor: 5 }, { alive: true, gated: false, cursor: 5, newLines: ['⟦WORKER-STATUS⟧ done'] });
  assert.equal(a.material, false);
  assert.equal(a.interim, undefined);
});

test('classify: gate already open (no transition) → not material', () => {
  const a = classifyExecutorActivity({ alive: true, gated: true, cursor: 3 }, { alive: true, gated: true, cursor: 3, newLines: [] });
  assert.equal(a.material, false);
});

test('shouldEngage: material → true', () => {
  assert.equal(shouldEngage({ now: 100, lastEngagedAt: 100, safetyIntervalMin: 45, materialCount: 1, activeIds: ['a'], lastActiveIds: ['a'] }), true);
});

test('shouldEngage: new mission (set changed) → true', () => {
  assert.equal(shouldEngage({ now: 100, lastEngagedAt: 100, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a', 'b'], lastActiveIds: ['a'] }), true);
});

test('shouldEngage: never engaged → true', () => {
  assert.equal(shouldEngage({ now: 100, lastEngagedAt: null, safetyIntervalMin: 45, materialCount: 0, activeIds: [], lastActiveIds: [] }), true);
});

test('shouldEngage: safety elapsed → true', () => {
  assert.equal(shouldEngage({ now: 100 * 60_000, lastEngagedAt: 0, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a'], lastActiveIds: ['a'] }), true);
});

test('shouldEngage: nothing changed, within interval → false', () => {
  assert.equal(shouldEngage({ now: 10 * 60_000, lastEngagedAt: 9 * 60_000, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a'], lastActiveIds: ['a'] }), false);
});

test('shouldEngage: same set different order → not a change (false)', () => {
  assert.equal(shouldEngage({ now: 10 * 60_000, lastEngagedAt: 9 * 60_000, safetyIntervalMin: 45, materialCount: 0, activeIds: ['b', 'a'], lastActiveIds: ['a', 'b'] }), false);
});

test('shouldEngage: safety elapsed but NO update since last engage → false (no wasted-token check-in)', () => {
  assert.equal(shouldEngage({ now: 100 * 60_000, lastEngagedAt: 0, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a'], lastActiveIds: ['a'], anyUpdateSinceEngage: false }), false);
});

test('shouldEngage: safety elapsed AND something updated since last engage → true (safety net preserved)', () => {
  assert.equal(shouldEngage({ now: 100 * 60_000, lastEngagedAt: 0, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a'], lastActiveIds: ['a'], anyUpdateSinceEngage: true }), true);
});

test('shouldEngage: anyUpdateSinceEngage omitted → defaults true (back-compat with old callers)', () => {
  assert.equal(shouldEngage({ now: 100 * 60_000, lastEngagedAt: 0, safetyIntervalMin: 45, materialCount: 0, activeIds: ['a'], lastActiveIds: ['a'] }), true);
});
