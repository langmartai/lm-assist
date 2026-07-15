import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleMissionSpawn, type MissionSpawnDeps } from '../routes/core/mission.routes';
import { ensureControllerWorkspace, CONTROLLER_WORKSPACE_CLAUDE_MD } from '../mission/mission-controller';

// ---------------------------------------------------------------------------
// handleMissionSpawn — the sanctioned native executor spawn
// ---------------------------------------------------------------------------

const baseMission = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'mission_sp1',
  title: 'Spawn me',
  objective: 'obj',
  env: { repo: '/repo' },
  ...over,
});

const goNative = { go: true, env: 'worktree', repo: 'rel/repo', branch: 'feat/x' };

function deps(over: Partial<MissionSpawnDeps> = {}, calls: Record<string, unknown[]> = {}): MissionSpawnDeps {
  return {
    getMission: async (id) => (id === 'mission_sp1' ? baseMission() : null),
    listMissions: async () => [],
    place: () => ({ ...goNative }),
    startNative: async (m, decision, nd) => {
      // snapshot m at CALL time — the handler later overwrites m.binding with the result
      (calls.start ??= []).push([JSON.parse(JSON.stringify(m)), decision, nd]);
      return { sessionId: 'uuid-new', node: 'local', kind: 'worker', boundAt: 1 };
    },
    buildNativeDeps: async () => ({ fake: true }),
    persist: async (m) => { (calls.persist ??= []).push(m); },
    ...over,
  };
}

test('spawn: mission not found', async () => {
  const r = await handleMissionSpawn('mission_nope', {}, deps());
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'MISSION_NOT_FOUND');
});

test('spawn: already bound rejected without force, allowed with force', async () => {
  const bound = baseMission({ binding: { sessionId: 'uuid-old', kind: 'worker' } });
  const calls: Record<string, unknown[]> = {};
  const d = deps({ getMission: async () => bound }, calls);
  const r1 = await handleMissionSpawn('mission_sp1', {}, d);
  assert.equal(r1.error?.code, 'ALREADY_BOUND');
  const r2 = await handleMissionSpawn('mission_sp1', { force: true }, d);
  assert.equal(r2.success, true);
  assert.equal((calls.start ?? []).length, 1);
});

test('spawn: cloud placement redirected to ccr_cloud_start', async () => {
  const r = await handleMissionSpawn('mission_sp1', {}, deps({ place: () => ({ go: true, env: 'cloud' }) }));
  assert.equal(r.error?.code, 'CLOUD_PLACEMENT');
});

test('spawn: placement not-go surfaces reason', async () => {
  const r = await handleMissionSpawn('mission_sp1', {}, deps({ place: () => ({ go: false, reason: 'deps-unmet' }) }));
  assert.equal(r.error?.code, 'PLACEMENT_NOT_GO');
  assert.match(r.error?.message ?? '', /deps-unmet/);
});

test('spawn: bad kind rejected', async () => {
  const r = await handleMissionSpawn('mission_sp1', { kind: 'boss' }, deps());
  assert.equal(r.error?.code, 'BAD_KIND');
});

test('spawn happy path: repo absolutized, branch override, kind preset, binding persisted, name returned', async () => {
  const calls: Record<string, unknown[]> = {};
  const r = await handleMissionSpawn('mission_sp1', { kind: 'orchestrator', branch: 'feat/custom' }, deps({}, calls));
  assert.equal(r.success, true);
  const [m, decision] = (calls.start as unknown[][])[0] as [Record<string, unknown>, Record<string, unknown>];
  assert.ok(path.isAbsolute(String(decision.repo)), 'repo must be absolutized');
  assert.equal(decision.branch, 'feat/custom');
  assert.equal((m.binding as Record<string, unknown>).kind, 'orchestrator', 'kind preset on m.binding for startNativeExecutor');
  const persisted = (calls.persist as Record<string, unknown>[])[0];
  assert.equal((persisted.binding as Record<string, unknown>).sessionId, 'uuid-new');
  const data = r.data as { name: string; binding: Record<string, unknown> };
  assert.match(data.name, /^Mission: Spawn me/);
  assert.equal(data.binding.sessionId, 'uuid-new');
});

// ---------------------------------------------------------------------------
// ensureControllerWorkspace — dedicated controller home project
// ---------------------------------------------------------------------------

test('workspace: created with seeded CLAUDE.md, idempotent, edits preserved', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lmws-'));
  try {
    const dir = ensureControllerWorkspace(base);
    assert.equal(dir, path.join(base, 'mission-control'));
    assert.ok(fs.existsSync(dir));
    const md = path.join(dir, 'CLAUDE.md');
    assert.equal(fs.readFileSync(md, 'utf8'), CONTROLLER_WORKSPACE_CLAUDE_MD);
    assert.match(CONTROLLER_WORKSPACE_CLAUDE_MD, /mission_spawn/);
    // idempotent + a human edit is never clobbered
    fs.writeFileSync(md, 'edited by human');
    const dir2 = ensureControllerWorkspace(base);
    assert.equal(dir2, dir);
    assert.equal(fs.readFileSync(md, 'utf8'), 'edited by human');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
