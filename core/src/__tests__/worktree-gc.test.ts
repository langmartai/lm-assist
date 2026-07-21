// Worktree GC decision rules: dirty is sacred, unmerged kept, done+merged+clean
// removed, active missions kept even when merged, mission-less staleness, and
// dry-run reporting without action.
import { test } from 'node:test';
import assert from 'node:assert';
import { runWorktreeGc, type WorktreeGcDeps } from '../scheduler/worktree-gc';

const REPO = '/repo';
const NOW = 1_800_000_000_000;

interface FakeWt { path: string; branch: string; dirty: boolean; merged: boolean; lastCommitMs?: number }

function makeDeps(wts: FakeWt[], missions: Record<string, string>) {
  const removed: string[] = [];
  const rmrfed: string[] = [];
  const byPath = new Map(wts.map((w) => [w.path, w]));
  const deps: WorktreeGcDeps = {
    git: (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        const entries = [`worktree ${REPO}\nbranch refs/heads/main\n`];
        for (const w of wts) entries.push(`worktree ${w.path}\nbranch refs/heads/${w.branch}\n`);
        return entries.join('\n');
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const w = byPath.get(args[2]);
        if (w?.dirty) throw new Error('contains modified or untracked files');
        removed.push(args[2]);
        return '';
      }
      if (args[0] === 'worktree' && args[1] === 'prune') return '';
      const w = byPath.get(cwd);
      if (args[0] === 'status') return w?.dirty ? ' M x.ts' : '';
      if (args[0] === 'rev-parse') return `head-of-${cwd}`;
      if (args[0] === 'merge-base') {
        const target = wts.find((x) => `head-of-${x.path}` === args[2]);
        if (!target?.merged) throw new Error('not ancestor');
        return '';
      }
      if (args[0] === 'log') return String(Math.floor((w?.lastCommitMs ?? NOW) / 1000));
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    missionStatus: async (id) => missions[id] ?? null,
    now: () => NOW,
    dirSizeApprox: () => 1_048_576,
    rmrf: (p) => { rmrfed.push(p); },
    exists: () => true,
    cacheMtimeMs: () => null,
  };
  return { deps, removed, rmrfed };
}

test('done mission + merged + clean → removed', async () => {
  const { deps, removed } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_aaa111', branch: 'feat/x', dirty: false, merged: true }],
    { mission_aaa111: 'done' },
  );
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(removed.length, 1);
});

test('dirty tree is never removed regardless of mission state', async () => {
  const { deps, removed } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_bbb222', branch: 'feat/y', dirty: true, merged: true }],
    { mission_bbb222: 'done' },
  );
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(removed.length, 0);
  assert.match(r.decisions[0].reason, /dirty/);
});

test('unmerged branch kept even when mission done', async () => {
  const { deps } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_ccc333', branch: 'feat/z', dirty: false, merged: false }],
    { mission_ccc333: 'done' },
  );
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 0);
  assert.match(r.decisions[0].reason, /not merged/);
});

test('active mission kept even when merged + clean', async () => {
  const { deps } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_ddd444', branch: 'feat/a', dirty: false, merged: true }],
    { mission_ddd444: 'active' },
  );
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 0);
  assert.match(r.decisions[0].reason, /mission status active/);
});

test('unknown mission status → conservative keep', async () => {
  const { deps } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_eee555', branch: 'feat/b', dirty: false, merged: true }],
    {},
  );
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 0);
  assert.match(r.decisions[0].reason, /unknown/);
});

test('mission-less: removed only when idle beyond threshold', async () => {
  const old = NOW - 10 * 86_400_000;
  const fresh = NOW - 86_400_000;
  const { deps, removed } = makeDeps(
    [
      { path: '/repo/.claude/worktrees/old-experiment', branch: 'spike/x', dirty: false, merged: true, lastCommitMs: old },
      { path: '/repo/.claude/worktrees/fresh-work', branch: 'spike/y', dirty: false, merged: true, lastCommitMs: fresh },
    ],
    {},
  );
  const r = await runWorktreeGc({ roots: [REPO], staleNoMissionDays: 7 }, deps);
  assert.strictEqual(r.removed, 1);
  assert.ok(removed[0].endsWith('old-experiment'));
});

test('dryRun reports would-remove without acting', async () => {
  const { deps, removed } = makeDeps(
    [{ path: '/repo/.claude/worktrees/mission-mission_fff666', branch: 'feat/c', dirty: false, merged: true }],
    { mission_fff666: 'done' },
  );
  const r = await runWorktreeGc({ roots: [REPO], dryRun: true }, deps);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(removed.length, 0);
  assert.strictEqual(r.decisions[0].action, 'would-remove');
});

test('git-refused removal (race to dirty) is reported kept, not thrown', async () => {
  const wt: FakeWt = { path: '/repo/.claude/worktrees/mission-mission_ggg777', branch: 'feat/d', dirty: false, merged: true };
  const { deps } = makeDeps([wt], { mission_ggg777: 'done' });
  const origGit = deps.git.bind(deps);
  deps.git = (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('contains modified or untracked files');
    return origGit(cwd, args);
  };
  const r = await runWorktreeGc({ roots: [REPO] }, deps);
  assert.strictEqual(r.removed, 0);
  assert.match(r.decisions[0].reason, /removal refused/);
});
