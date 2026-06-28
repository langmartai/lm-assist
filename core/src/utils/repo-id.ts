// Resolve a working directory to its project (leaf name) + best-effort GitHub
// `owner/repo` (from the git origin remote). Used to tag MCP resources (sessions,
// executions, mission detail) with project/repo provenance so an LLM knows which
// codebase a result belongs to. All functions are best-effort and NEVER throw.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoId {
  /** The working directory's leaf name — a human label even when there's no git remote. */
  project: string;
  /** `owner/repo` parsed from the git `origin` remote, when present. */
  repo?: string;
}

/**
 * PURE — normalize a HOSTED git remote URL to `owner/repo` (no host, no `.git`).
 * Accepts scp-style (`git@host:owner/repo(.git)`) and url-style
 * (`scheme://host/owner/repo(.git)`). Returns null for a bare local path (no
 * host segment — e.g. `/srv/git/x.git`, `file:///srv/x.git`) or <2 path segments.
 */
function normalizeRemoteUrl(rawUrl: string): string | null {
  let u = rawUrl.trim();
  if (!u) return null;
  const scp = u.match(/^[^/@]+@[^/:]+:(.+)$/); // git@host:owner/repo(.git)
  const url = scp ? null : u.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i); // scheme://host/owner/repo(.git)
  if (scp) u = scp[1];
  else if (url) u = url[1];
  else return null; // not a hosted remote (local path / unrecognized) → no owner/repo
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, ''); // strip trailing /, then .git, then any leftover /
  const parts = u.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('/');
}

/**
 * PURE — extract `owner/repo` from a git config's `[remote "origin"]` url.
 * Handles scp-style (`git@host:owner/repo.git`) and url-style
 * (`https://host/owner/repo(.git)`, `ssh://git@host/owner/repo.git`). Returns
 * the LAST two path segments as `owner/repo`; null when no origin url parses.
 */
export function parseOriginRepo(gitConfig: string): string | null {
  if (!gitConfig) return null;
  let inOrigin = false;
  let url: string | null = null;
  for (const raw of gitConfig.split('\n')) {
    const line = raw.trim();
    const section = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]/i);
    if (section) { inOrigin = section[1] === 'origin'; continue; }
    if (line.startsWith('[')) { inOrigin = false; continue; }
    if (inOrigin && !url) {
      const m = line.match(/^url\s*=\s*(.+)$/i);
      if (m) url = m[1].trim();
    }
  }
  return url ? normalizeRemoteUrl(url) : null;
}

/** Cross-platform leaf of a path (handles both `/` and `\` regardless of host OS). */
function leafOf(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * Resolve a working directory to its project (leaf name) + best-effort git
 * `owner/repo`. NEVER throws — a non-git (or cross-host, unreadable) cwd yields
 * project only; an empty/invalid cwd yields null. `readFile` is injectable for
 * tests; it defaults to reading `<cwd>/.git/config`.
 */
export function repoOf(
  cwd: string | undefined | null,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): RepoId | null {
  if (!cwd || typeof cwd !== 'string') return null;
  const project = leafOf(cwd);
  if (!project) return null;
  let repo: string | undefined;
  try {
    repo = parseOriginRepo(readFile(join(cwd, '.git', 'config'))) ?? undefined;
  } catch { /* non-git / cross-host cwd → project only */ }
  return { project, repo };
}

const memo = new Map<string, RepoId | null>();

/** repoOf memoized by cwd for the process lifetime (a cwd's git remote doesn't change mid-run). */
export function repoOfCached(cwd: string | undefined | null): RepoId | null {
  const key = cwd || '';
  if (memo.has(key)) return memo.get(key)!;
  const r = repoOf(cwd);
  memo.set(key, r);
  return r;
}
