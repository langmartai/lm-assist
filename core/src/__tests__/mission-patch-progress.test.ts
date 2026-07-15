/**
 * PATCH /mission/:id progress whitelist (human-authorized scope, 2026-07-15).
 * Previously handlePatch silently IGNORED a progress field (success:true, applied
 * nothing). Contract (option A): human-supplied only (controller actors FORBIDDEN,
 * mirroring manageMode); percent required, Number()-coerced, clamped 0-100;
 * summary optional (absent keeps the existing summary, '' when fresh);
 * updatedAt stamped server-side; null/non-object progress rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePatch } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor } from '../mission/mission-model';

const human: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
const controller: MissionActor = { kind: 'controller', channel: 'controller', node: 'n', at: 1 };

const mk = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => id), id, ...over });

function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, m]));
  return {
    db,
    get: async (id: string) => db.get(id) ?? null,
    list: async () => [...db.values()],
    put: async (m: Mission) => { db.set(m.id, m); },
  };
}

test('handlePatch applies a human progress patch, clamped and stamped server-side', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { progress: { percent: 55, summary: 'halfway' } }, port as any, human);
  assert.equal(r.success, true);
  const m = port.db.get('a')!;
  assert.equal(m.progress?.percent, 55);
  assert.equal(m.progress?.summary, 'halfway');
  assert.ok((m.progress?.updatedAt ?? 0) > 0, 'updatedAt is stamped server-side');
});

test('handlePatch clamps percent into 0-100 and coerces numeric strings', async () => {
  const port = memPort([mk('a')]);
  await handlePatch('a', { progress: { percent: 250, summary: 's' } }, port as any, human);
  assert.equal(port.db.get('a')!.progress?.percent, 100);
  await handlePatch('a', { progress: { percent: -5, summary: 's' } }, port as any, human);
  assert.equal(port.db.get('a')!.progress?.percent, 0);
  await handlePatch('a', { progress: { percent: '42', summary: 's' } }, port as any, human);
  assert.equal(port.db.get('a')!.progress?.percent, 42);
});

test('handlePatch rejects a missing or non-numeric percent', async () => {
  const port = memPort([mk('a')]);
  const r1 = await handlePatch('a', { progress: { summary: 'no percent' } }, port as any, human);
  assert.equal(r1.success, false);
  assert.equal((r1 as any).error.code, 'INVALID_INPUT');
  const r2 = await handlePatch('a', { progress: { percent: 'high' } }, port as any, human);
  assert.equal(r2.success, false);
  assert.equal((r2 as any).error.code, 'INVALID_INPUT');
  assert.equal(port.db.get('a')!.progress, null, 'nothing applied on rejection');
});

test('summary is optional: absent keeps the existing summary, empty when fresh', async () => {
  const port = memPort([
    mk('a', { progress: { percent: 10, summary: 'old summary', updatedAt: 1 } }),
    mk('b'),
  ]);
  await handlePatch('a', { progress: { percent: 60 } }, port as any, human);
  assert.equal(port.db.get('a')!.progress?.summary, 'old summary');
  await handlePatch('b', { progress: { percent: 5 } }, port as any, human);
  assert.equal(port.db.get('b')!.progress?.summary, '');
});

test('progress null or non-object is rejected (no clearing via patch)', async () => {
  const port = memPort([mk('a', { progress: { percent: 30, summary: 'keep', updatedAt: 1 } })]);
  for (const bad of [null, 'half', 42, ['x']]) {
    const r = await handlePatch('a', { progress: bad }, port as any, human);
    assert.equal(r.success, false, `progress=${JSON.stringify(bad)} must be rejected`);
    assert.equal((r as any).error.code, 'INVALID_INPUT');
  }
  assert.equal(port.db.get('a')!.progress?.percent, 30, 'existing progress untouched');
});

test('controller actors are FORBIDDEN from patching progress (human-supplied field)', async () => {
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { progress: { percent: 90, summary: 'ctl' } }, port as any, controller);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'FORBIDDEN');
  assert.equal(port.db.get('a')!.progress, null);
});

test('telemetry-ish fields are rejected loudly — UNSUPPORTED_FIELD, nothing applied (whitelist regression)', async () => {
  // 2026-07-15 (mission_3922a14d): silent-ignore is dead — the same body that used to
  // "succeed" while dropping control/interim now fails fast, and the valid title
  // alongside them is NOT applied (fail-before-mutate).
  const port = memPort([mk('a')]);
  const r = await handlePatch('a', { title: 't2', control: { nudgeCount: 99 }, interim: { at: 1, text: 'x' } }, port as any, human);
  assert.equal(r.success, false);
  assert.equal((r as any).error.code, 'UNSUPPORTED_FIELD');
  assert.match((r as any).error.message, /control/);
  assert.match((r as any).error.message, /interim/);
  const m = port.db.get('a')!;
  assert.equal(m.title, 'a', 'mixed valid+unknown applies nothing');
  assert.equal(m.control.nudgeCount, 0, 'control telemetry not patchable');
  assert.equal(m.interim, undefined, 'interim telemetry not patchable');
});
