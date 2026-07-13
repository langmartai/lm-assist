/**
 * C1 (CRITICAL) regression test: handleSessionResume must NEVER enroll an onboarded
 * (origin:'onboarded') session for reaper auto-close — even when the caller omits
 * `missionId` in the resume body (the common shape for a controller/human resume call).
 *
 * Before the fix, the onboarded guard only fired when body.missionId was present:
 *   const m = body.missionId ? await gm(body.missionId) : null;
 * so a resume call with no missionId always resolved `onboarded = false`, silently
 * enrolling the user's OWN session into the idle-auto-close reaper.
 *
 * The fix: resolveOnboardedForTracking falls back to resolving the mission BY SID
 * (findMissionBySessionOrCcr) when missionId is absent, wired through the new
 * injectable `lookupOnboarded` dep on SessionResumeDeps (production default uses the
 * real mission-store; tests inject a fake so no data-service/IO is needed).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionResume, resolveOnboardedForTracking } from '../routes/core/mission.routes';
import type { SessionResumeDeps } from '../routes/core/mission.routes';

function makeResumeDeps(overrides: Partial<SessionResumeDeps> = {}): SessionResumeDeps {
  return {
    resolve: (sid) => ({ sid, transport: sid.startsWith('session_') ? 'cloud' : 'native', missionId: null, role: 'worker' as const }),
    cloudStatus: async (sid) => ({ sid, status: 'active', raw: {} }),
    cloudWake: async () => {},
    nativeVerdict: () => ({ connectStrategy: 'create-tmux', safeToCreateTmux: true, inTmux: false }),
    resumeNative: async (_missionId, sid) => ({ sid, boundAt: Date.now() }),
    idleMin: 30,
    ...overrides,
  };
}

// ── (a) missionId present + onboarded → no autoCloseAt in response ──────────────

test('missionId present + onboarded mission → no autoCloseAt, never enrolled', async () => {
  let lookupCalledWith: { missionId: string | undefined; sid: string } | null = null;
  const deps = makeResumeDeps({
    lookupOnboarded: async (missionId, sid) => {
      lookupCalledWith = { missionId, sid };
      return missionId === 'mission_ob1';
    },
  });
  const r = await handleSessionResume('uuid-native-1', { missionId: 'mission_ob1' }, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.autoCloseAt, undefined, 'onboarded session must never get autoCloseAt');
  assert.deepEqual(lookupCalledWith, { missionId: 'mission_ob1', sid: 'uuid-native-1' });
});

// ── (b) missionId ABSENT but findMissionBySessionOrCcr resolves onboarded → no autoCloseAt ──

test('missionId ABSENT + sid resolves to an onboarded mission via lookup fallback → no autoCloseAt', async () => {
  let lookupCalledWith: { missionId: string | undefined; sid: string } | undefined;
  const deps = makeResumeDeps({
    // Simulates resolveOnboardedForTracking's fallback: missionId undefined → resolve by sid.
    lookupOnboarded: async (missionId, sid) => {
      lookupCalledWith = { missionId, sid };
      // Only resolves onboarded via the BY-SID fallback (missionId is undefined here).
      return missionId === undefined && sid === 'uuid-native-2';
    },
  });
  const r = await handleSessionResume('uuid-native-2', {}, deps); // NOTE: no missionId in body
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.strictEqual(d.autoCloseAt, undefined, 'onboarded session resolved by sid-fallback must never get autoCloseAt');
  assert.strictEqual(lookupCalledWith?.missionId, undefined);
  assert.strictEqual(lookupCalledWith?.sid, 'uuid-native-2');
});

// ── (c) non-onboarded → autoCloseAt present ─────────────────────────────────────

test('non-onboarded mission (missionId present, not onboarded) → autoCloseAt present, reaper-tracked', async () => {
  const deps = makeResumeDeps({
    lookupOnboarded: async () => false,
  });
  const r = await handleSessionResume('uuid-native-3', { missionId: 'mission_plain' }, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.strictEqual(d.resumed, true);
  assert.ok(typeof d.autoCloseAt === 'number', 'a normal (non-onboarded) resumed native session MUST be enrolled for auto-close');
});

test('non-onboarded, no lookupOnboarded dep at all (legacy default) → autoCloseAt present', async () => {
  // Backward-compat: when lookupOnboarded is omitted entirely, the guard defaults to
  // "not onboarded" (false) rather than throwing or hanging — a normal session is still tracked.
  const deps = makeResumeDeps(); // no lookupOnboarded override
  const r = await handleSessionResume('uuid-native-4', { missionId: 'mission_plain2' }, deps);
  assert.ok(r.success, JSON.stringify(r));
  const d = (r as any).data;
  assert.ok(typeof d.autoCloseAt === 'number');
});

// ── resolveOnboardedForTracking — the extracted pure(ish) helper, direct unit tests ──

test('resolveOnboardedForTracking: missionId given → uses getMission directly, ignores sid-fallback', async () => {
  let findCalled = false;
  const result = await resolveOnboardedForTracking('mission_x', 'sid_x', {
    getMission: async (id) => (id === 'mission_x' ? { origin: 'onboarded' } : null),
    findMissionBySessionOrCcr: async () => { findCalled = true; return null; },
  });
  assert.strictEqual(result, true);
  assert.strictEqual(findCalled, false, 'must not fall back to sid lookup when missionId is given');
});

test('resolveOnboardedForTracking: missionId absent → falls back to findMissionBySessionOrCcr', async () => {
  const result = await resolveOnboardedForTracking(undefined, 'sid_y', {
    getMission: async () => { throw new Error('must not be called'); },
    findMissionBySessionOrCcr: async (sid) => (sid === 'sid_y' ? { origin: 'onboarded' } : null),
  });
  assert.strictEqual(result, true);
});

test('resolveOnboardedForTracking: lookup throws → resolves false (best-effort, never blocks resume)', async () => {
  const result = await resolveOnboardedForTracking(undefined, 'sid_z', {
    getMission: async () => null,
    findMissionBySessionOrCcr: async () => { throw new Error('store down'); },
  });
  assert.strictEqual(result, false);
});

test('resolveOnboardedForTracking: mission found but not onboarded → false', async () => {
  const result = await resolveOnboardedForTracking('mission_plain', 'sid_w', {
    getMission: async () => ({ origin: undefined }),
    findMissionBySessionOrCcr: async () => null,
  });
  assert.strictEqual(result, false);
});
