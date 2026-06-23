/**
 * Cross-node project identity = the git `origin` remote, normalized to `host/owner/repo`.
 *
 * Two nodes that have checked out the same repo (even at different paths / users / OS) get the SAME
 * key, so the memory mesh can recognize them as peers for that project despite their cwd-encoded
 * slugs differing. A project with no git origin has no cross-node identity (returns null → no sync).
 */
import { execFileSync } from 'child_process';

/** Canonicalize a git remote URL (https / ssh / scp-style / .git / trailing slash) to host/owner/repo, lowercased. */
export function normalizeRemote(url: string): string | null {
  let s = (url || '').trim();
  if (!s) return null;
  const scpStyle = !s.includes('://') && /^[^/]+@[^/]+:/.test(s); // user@host:owner/repo
  if (scpStyle) {
    s = s.replace(/^[^@]+@/, '');   // strip user@
    s = s.replace(':', '/');        // host:owner → host/owner (first colon only)
  } else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme (https:// ssh:// …)
    s = s.replace(/^[^@/]+@/, '');                 // strip user@ (ssh://git@host/…)
  }
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '');
  s = s.toLowerCase();
  return s || null;
}

/** Read + normalize `git -C <cwd> remote get-url origin`. Null if not a git repo / no origin. */
export function projectRemoteKey(cwd: string): string | null {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeRemote(url);
  } catch {
    return null;
  }
}
