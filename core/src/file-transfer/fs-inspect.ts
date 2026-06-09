/**
 * Filesystem inspect interface — drives → directories → files — over the
 * node-to-node transport, so an MCP agent can see the REAL directory structure
 * on each owned node and copy files to/from known locations.
 *
 * Scope: whole filesystem. The trust boundary is the hub's same-user gate (a
 * node only talks to other nodes owned by the same account), so there is no
 * receive-root sandbox here — unlike the file-transfer receiver's safeJoin.
 *
 * Performance contract (deliberate, see the project rules on not blocking the
 * event loop and not doing unnecessary disk work):
 *   - Every read is async (fs/promises). Nothing here is *Sync.
 *   - Listing is SHALLOW (one level) and ENTRY-CAPPED. We never recurse, so a
 *     list of a huge tree can't fan out into a giant disk walk.
 *   - Results are cached in-memory with a short TTL. A cache hit touches no
 *     disk at all. The cache is invalidated explicitly (markDirty) when a
 *     transfer writes into a directory, and can be bypassed per-call (refresh).
 *   - The cache is size-bounded (LRU eviction) so it can't grow without limit.
 */
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import type { DirEntry } from './types';

const TTL_MS = Number(process.env.LM_FS_CACHE_TTL_MS) || 10_000;
const MAX_ENTRIES = Number(process.env.LM_FS_LIST_MAX) || 2000;
const MAX_CACHE = Number(process.env.LM_FS_CACHE_MAX) || 500;

export interface StatInfo {
  path: string;
  name: string;
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
  symlinkTarget?: string;
}

export interface FsListResult {
  path: string;
  entries: DirEntry[];
  /** True when more entries than MAX_ENTRIES were found; entries is the head. */
  truncated: boolean;
  /** Total child count in the directory (before any pattern filter). */
  total: number;
  /** When a pattern was given: how many children matched (before the cap). */
  matched?: number;
  /** Echo of the filter applied, if any. */
  pattern?: string;
}

export interface DriveInfo {
  path: string;
  /** 'root' | 'home' | 'mount' | 'drive' */
  type: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// Cache — keyed by `${op}:${absPath}`. TTL + LRU. A hit does zero disk I/O.
// ---------------------------------------------------------------------------
interface CacheEntry {
  atMs: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string, refresh?: boolean): T | null {
  if (refresh) {
    cache.delete(key);
    return null;
  }
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.atMs > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU touch — move to newest.
  cache.delete(key);
  cache.set(key, e);
  return e.value as T;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { atMs: Date.now(), value });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Invalidate cached info for a path and its parent listing. Call this after a
 * write (a received file/dir) so the next list/stat reflects reality without a
 * background poll. Cheap — pure Map deletes, no disk.
 */
export function markDirty(absPath: string): void {
  const p = path.resolve(absPath);
  const parent = path.dirname(p);
  cache.delete('stat:' + p);
  cache.delete('stat:' + parent);
  // List cache keys may carry a pattern suffix ('list:<dir>\x00<filter>').
  // Drop every list entry for this dir and its parent, whatever filter made it.
  // The '\x00' sentinel after <dir> avoids prefix collisions (e.g. /home/yi vs
  // /home/yitest).
  for (const k of [...cache.keys()]) {
    if (k === 'list:' + p || k.startsWith('list:' + p + '\x00')) cache.delete(k);
    else if (k === 'list:' + parent || k.startsWith('list:' + parent + '\x00')) cache.delete(k);
  }
}

/** Drop the whole cache (test/debug). */
export function clearFsCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Inspect operations
// ---------------------------------------------------------------------------

/** Stat a single path. Never throws for a missing path — returns exists:false. */
export async function statAbs(
  absPath: string,
  opts?: { refresh?: boolean },
): Promise<StatInfo> {
  const p = path.resolve(absPath);
  const key = 'stat:' + p;
  const hit = cacheGet<StatInfo>(key, opts?.refresh);
  if (hit) return hit;

  let lst;
  try {
    lst = await fsp.lstat(p);
  } catch {
    const miss: StatInfo = {
      path: p,
      name: path.basename(p) || p,
      exists: false,
      isDir: false,
      isFile: false,
      isSymlink: false,
      size: 0,
      mode: 0,
      mtimeMs: 0,
    };
    cacheSet(key, miss);
    return miss;
  }
  const isSymlink = lst.isSymbolicLink();
  let symlinkTarget: string | undefined;
  if (isSymlink) {
    try {
      symlinkTarget = await fsp.readlink(p);
    } catch {
      /* dangling or unreadable — leave undefined */
    }
  }
  const info: StatInfo = {
    path: p,
    name: path.basename(p) || p,
    exists: true,
    isDir: lst.isDirectory(),
    isFile: lst.isFile(),
    isSymlink,
    size: lst.size,
    mode: lst.mode & 0o777,
    mtimeMs: lst.mtimeMs,
    symlinkTarget,
  };
  cacheSet(key, info);
  return info;
}

/**
 * List a directory, one level deep, capped at MAX_ENTRIES. Entries are sorted
 * by name. A child that can't be lstat'd (permissions, race) is skipped.
 */
/**
 * Convert a shell-style glob (only `*` and `?` are special) to an anchored
 * RegExp that matches a single filename. Every other regex metacharacter is
 * escaped, so `[`, `.`, `(` etc. are literal.
 */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (const c of glob) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

export async function listDirAbs(
  absPath: string,
  opts?: { refresh?: boolean; pattern?: string; regex?: boolean },
): Promise<FsListResult> {
  const p = path.resolve(absPath);
  const pat = opts?.pattern && opts.pattern.length ? opts.pattern : undefined;
  const key = 'list:' + p + (pat ? '\x00' + (opts?.regex ? 're:' : 'gl:') + pat : '');
  const hit = cacheGet<FsListResult>(key, opts?.refresh);
  if (hit) return hit;

  // readdir is a single syscall even for a large dir. We then filter by NAME
  // (pure string, no disk) BEFORE the per-entry lstat, and cap the lstat count
  // at MAX_ENTRIES — so a pattern query against a 100k-file directory only
  // stats the matches, never every child.
  const names = (await fsp.readdir(p)).sort();
  const total = names.length;
  let pool = names;
  let matched: number | undefined;
  if (pat) {
    const re = opts?.regex ? new RegExp(pat) : globToRegExp(pat);
    pool = names.filter((n) => re.test(n));
    matched = pool.length;
  }
  const slice = pool.slice(0, MAX_ENTRIES);
  const entries: DirEntry[] = [];
  for (const name of slice) {
    const childAbs = path.join(p, name);
    let st;
    try {
      st = await fsp.lstat(childAbs);
    } catch {
      continue;
    }
    entries.push({
      name,
      relPath: name,
      size: st.size,
      mode: st.mode & 0o777,
      isDir: st.isDirectory(),
      mtimeMs: st.mtimeMs,
    });
  }
  const res: FsListResult = { path: p, entries, truncated: pool.length > slice.length, total };
  if (pat) {
    res.matched = matched;
    res.pattern = pat;
  }
  cacheSet(key, res);
  return res;
}

/**
 * Enumerate top-level roots ("drives") to start browsing from. Cheap and
 * cached. On Windows this probes drive letters A–Z; on POSIX it returns '/',
 * the home dir, and any common mount points that exist.
 */
export async function listDrives(opts?: { refresh?: boolean }): Promise<DriveInfo[]> {
  const key = 'drives:';
  const hit = cacheGet<DriveInfo[]>(key, opts?.refresh);
  if (hit) return hit;

  const out: DriveInfo[] = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try {
        await fsp.access(d);
        out.push({ path: d, type: 'drive' });
      } catch {
        /* drive letter not present */
      }
    }
  } else {
    out.push({ path: '/', type: 'root' });
    out.push({ path: os.homedir(), type: 'home', label: 'home' });
    for (const m of ['/mnt', '/media', '/data', '/srv']) {
      try {
        const s = await fsp.stat(m);
        if (s.isDirectory()) out.push({ path: m, type: 'mount' });
      } catch {
        /* not present */
      }
    }
  }
  cacheSet(key, out);
  return out;
}
