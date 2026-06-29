import type { GitState } from './footprint-types';
import type { RunCmd } from './run-cmd';

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };
const RO = '--no-optional-locks';
const TIMEOUT = 2000;
const CAP = 20;

export function parseStatusV2(stdout: string): { branch: string | null; upstream: string | null; ahead: number; files: string[] } {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      branch = v === '(detached)' ? null : v;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-\d+/);
      if (m) ahead = parseInt(m[1], 10);
    } else if (line.startsWith('1 ')) {
      files.push(line.split(' ').slice(8).join(' '));
    } else if (line.startsWith('2 ')) {
      files.push(line.split(' ').slice(9).join(' ').split('\t')[0]);
    } else if (line.startsWith('? ')) {
      files.push(line.slice(2));
    } else if (line.startsWith('u ')) {
      files.push(line.split(' ').slice(10).join(' '));
    }
  }
  return { branch, upstream, ahead, files: files.filter(Boolean) };
}

export async function collectGitState(
  dir: string,
  run: RunCmd,
): Promise<{ git: GitState; openChanges: string[]; openChangesTruncated: boolean; repo: string | null }> {
  const opts = { cwd: dir, timeoutMs: TIMEOUT, env: GIT_ENV };
  const status = await run('git', ['-C', dir, RO, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], opts);
  if (status.code !== 0) {
    return {
      git: { branch: null, worktree: null, upstream: null, ahead: 0, dirty: 0, pushed: false },
      openChanges: [], openChangesTruncated: false, repo: null,
    };
  }
  const s = parseStatusV2(status.stdout);
  const top = await run('git', ['-C', dir, RO, 'rev-parse', '--show-toplevel'], opts);
  const worktree = top.code === 0 ? top.stdout.trim() || null : null;

  const uncommitted = s.files;
  let unpushed: string[] = [];
  let pushed = true;
  if (s.upstream && s.ahead > 0) {
    const d = await run('git', ['-C', dir, RO, 'diff', '--name-only', `${s.upstream}..HEAD`], opts);
    if (d.code === 0) unpushed = d.stdout.split('\n').filter(Boolean);
  } else if (!s.upstream) {
    pushed = false; // branch's work is not on a remote at all
    const base = await run('git', ['-C', dir, RO, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], opts);
    const baseRef = base.code === 0 && base.stdout.trim() ? base.stdout.trim() : null;
    if (baseRef) {
      const d = await run('git', ['-C', dir, RO, 'diff', '--name-only', `${baseRef}...HEAD`], opts);
      if (d.code === 0) unpushed = d.stdout.split('\n').filter(Boolean);
    }
  }

  const union = Array.from(new Set([...uncommitted, ...unpushed]));
  const openChanges = union.slice(0, CAP);
  return {
    git: { branch: s.branch, worktree, upstream: s.upstream, ahead: s.ahead, dirty: uncommitted.length, pushed },
    openChanges,
    openChangesTruncated: union.length > CAP,
    repo: worktree,
  };
}
