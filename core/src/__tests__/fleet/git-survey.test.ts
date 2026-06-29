import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseStatusV2, collectGitState } from '../../fleet/git-survey';
import type { RunCmd } from '../../fleet/run-cmd';

test('parseStatusV2 — branch, upstream, ahead, and changed/untracked/renamed paths', () => {
  const stdout = [
    '# branch.head feature-x',
    '# branch.upstream origin/feature-x',
    '# branch.ab +2 -0',
    '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
    '2 R. N... 100644 100644 100644 ccc ddd R100 src/new.ts\tsrc/old.ts',
    '? untracked.txt',
    'u UU N... 100644 100644 100644 100644 eee fff ggg src/conflict.ts',
  ].join('\n');
  const r = parseStatusV2(stdout);
  assert.equal(r.branch, 'feature-x');
  assert.equal(r.upstream, 'origin/feature-x');
  assert.equal(r.ahead, 2);
  assert.deepEqual(r.files.sort(), ['src/a.ts', 'src/conflict.ts', 'src/new.ts', 'untracked.txt'].sort());
});

test('parseStatusV2 — no upstream → upstream null, ahead 0', () => {
  const r = parseStatusV2('# branch.head mission/123\n? a.txt\n');
  assert.equal(r.branch, 'mission/123');
  assert.equal(r.upstream, null);
  assert.equal(r.ahead, 0);
  assert.deepEqual(r.files, ['a.txt']);
});

test('collectGitState — pushed branch with upstream: status + show-toplevel + diff', async () => {
  const calls: string[][] = [];
  const run: RunCmd = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('status')) return { stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n1 .M N... 0 0 0 a b dirty.ts\n', code: 0 };
    if (args.includes('rev-parse') && args.includes('--show-toplevel')) return { stdout: '/repo\n', code: 0 };
    if (args.includes('diff')) return { stdout: 'committed-unpushed.ts\n', code: 0 };
    return { stdout: '', code: 0 };
  };
  const r = await collectGitState('/repo/sub', run);
  assert.equal(r.git.branch, 'main');
  assert.equal(r.git.upstream, 'origin/main');
  assert.equal(r.git.ahead, 1);
  assert.equal(r.git.dirty, 1);
  assert.equal(r.git.pushed, true);
  assert.equal(r.git.worktree, '/repo');
  assert.deepEqual(r.openChanges.sort(), ['committed-unpushed.ts', 'dirty.ts'].sort());
  // read-only guard present on every git call
  for (const c of calls) assert.ok(c.includes('--no-optional-locks'), `missing --no-optional-locks in ${c.join(' ')}`);
});

test('collectGitState — non-git dir (status exits non-zero) → nulls, no throw', async () => {
  const run: RunCmd = async () => ({ stdout: '', code: 128 });
  const r = await collectGitState('/tmp/not-a-repo', run);
  assert.equal(r.git.branch, null);
  assert.equal(r.repo, null);
  assert.deepEqual(r.openChanges, []);
});
