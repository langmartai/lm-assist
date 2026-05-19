/**
 * Memory Cache — LMDB-backed cache for Claude Code memory directories
 *
 * Caches and watches two kinds of memory dirs:
 *
 *  1. `<configDir>/projects/<slug>/memory/` — the live auto-memory dir
 *     written by Claude Code at session start / save / update.
 *
 *  2. `<cwd>/memory/<host-id>/` — the in-repo mirror introduced by the
 *     "Project Memory Sync" CLAUDE.md convention. Each host owns its
 *     own subdirectory under the repo's `memory/` folder; `_hosts.md`
 *     is the registry of host-ids.
 *
 * Lookups are by absolute directory path. The cache returns a
 * MemoryDirData snapshot with parsed frontmatter and a short body
 * preview for each `.md` file. Full body is read lazily by getFileBody().
 *
 * Watcher uses chokidar with a 500 ms debounce, same as SessionCache.
 * On change/add/unlink we re-parse the affected directory and fire
 * `onMemoryChange` callbacks for SSE broadcast.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import { MemoryCacheStore } from './memory-cache-store';
import { getStartupProfiler } from './startup-profiler';
import { getClaudeConfigDir, getProjectsDir, legacyEncodeProjectPath } from './utils/path-utils';
import { parseFrontmatter, MemoryFrontmatter, isValidMemoryFrontmatter } from './utils/frontmatter';

// ─── Types ──────────────────────────────────────────────────

export type MemorySource = 'live' | `repo:${string}`;

export interface MemoryFile {
  /** Where the file came from — `live` or `repo:<host-id>` */
  source: MemorySource;
  /** Bare filename, e.g. `project_broker_boundary.md` */
  filename: string;
  /** Absolute path on disk */
  filePath: string;
  /** Parsed YAML frontmatter (may be empty if malformed) */
  frontmatter: MemoryFrontmatter;
  /** First ~500 chars of body, for list views */
  bodyPreview: string;
  /** Last-modified time (ms since epoch) */
  mtimeMs: number;
  /** File size in bytes */
  sizeBytes: number;
}

export interface MemoryDirData {
  /** Absolute dir path that this entry caches */
  dirPath: string;
  /** Which source this dir represents */
  source: MemorySource;
  /** Files in the dir, excluding MEMORY.md and _hosts.md */
  files: MemoryFile[];
  /** Raw MEMORY.md content (empty string if not present) */
  indexRaw: string;
  /** mtime of the dir (max of all file mtimes — for invalidation) */
  maxMtimeMs: number;
  /** When we last re-parsed the dir */
  lastParsedMs: number;
}

export interface ProjectMemorySnapshot {
  /** Project slug (encoded) */
  projectId: string;
  /** Decoded cwd */
  projectPath: string;
  /** Path to live auto-memory dir (may not exist) */
  liveDir: string;
  /** Path to repo-mirror base dir (`<cwd>/memory/`), if present */
  repoBaseDir?: string;
  /** My-host-id resolved from `_hosts.md`, if known */
  myHostId?: string;
  /** All host-ids found under repoBaseDir */
  hosts: string[];
  /** Sources actually present on disk */
  sources: MemorySource[];
}

// ─── Constants ──────────────────────────────────────────────

const BODY_PREVIEW_CHARS = 500;
const DEBOUNCE_MS = 500;
const INDEX_FILE = 'MEMORY.md';
const HOSTS_REGISTRY = '_hosts.md';

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Resolve `<cwd>/memory/<host-id>/` directories that exist on disk.
 * Reads `_hosts.md` if present, else falls back to filesystem scan.
 */
function discoverRepoHosts(repoBaseDir: string): string[] {
  if (!fs.existsSync(repoBaseDir) || !fs.statSync(repoBaseDir).isDirectory()) {
    return [];
  }
  const hosts: string[] = [];
  for (const entry of fs.readdirSync(repoBaseDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
      hosts.push(entry.name);
    }
  }
  return hosts.sort();
}

/**
 * Try to read `<cwd>/memory/_hosts.md` and parse a my-host-id hint.
 * The registry is a markdown table; this is a best-effort match against
 * the current OS + cwd. Returns undefined if nothing matches.
 */
function resolveMyHostId(repoBaseDir: string, cwd: string): string | undefined {
  const hostsFile = path.join(repoBaseDir, HOSTS_REGISTRY);
  if (!fs.existsSync(hostsFile)) return undefined;

  let content: string;
  try {
    content = fs.readFileSync(hostsFile, 'utf-8');
  } catch {
    return undefined;
  }

  const isWindows = process.platform === 'win32';
  // The registry table rows look like:
  //   | `windows-desk` | Windows 11 | ... | C:\Users\...\memory\ | ... |
  // Find a row whose backtick-quoted first cell mentions the current OS hint
  // and whose path field's drive letter matches cwd. This is best-effort.
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    if (line.trim().startsWith('| host-id') || line.trim().startsWith('|---')) continue;
    const idMatch = line.match(/\|\s*`([^`]+)`/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const lowered = line.toLowerCase();
    if (isWindows && lowered.includes('windows')) return id;
    if (!isWindows && (lowered.includes('linux') || lowered.includes('ubuntu') || lowered.includes('macos') || lowered.includes('darwin'))) {
      return id;
    }
  }
  return undefined;
}

// ─── MemoryCache class ──────────────────────────────────────

export class MemoryCache {
  private store: MemoryCacheStore;

  private watcher: FSWatcher | null = null;
  private watchedPaths: Set<string> = new Set();
  private pendingUpdates: Map<string, NodeJS.Timeout> = new Map();
  private isWatching = false;

  private onChangeCallbacks: Array<(dirPath: string, data: MemoryDirData) => void> = [];

  constructor(baseDir?: string) {
    const profiler = getStartupProfiler();
    profiler.start('memoryLmdbOpen', 'LMDB Open', 'MemoryCache');
    this.store = new MemoryCacheStore(baseDir);
    profiler.end('memoryLmdbOpen');
  }

  // ─── Callbacks ──────────────────────────────────────────

  onMemoryChange(cb: (dirPath: string, data: MemoryDirData) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  private fireOnChange(dirPath: string, data: MemoryDirData): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(dirPath, data);
      } catch {
        /* swallow */
      }
    }
  }

  // ─── Path resolution ────────────────────────────────────

  /**
   * Build a ProjectMemorySnapshot for a given project (by decoded cwd).
   * Does not parse files — just lists what's present.
   */
  resolveProject(cwd: string): ProjectMemorySnapshot {
    const projectsDir = getProjectsDir();
    const legacyKey = legacyEncodeProjectPath(cwd);
    const liveDir = path.join(projectsDir, legacyKey, 'memory');
    const repoBaseDir = path.join(cwd, 'memory');

    const hostsFound = fs.existsSync(repoBaseDir) ? discoverRepoHosts(repoBaseDir) : [];
    const myHostId = hostsFound.length > 0 ? resolveMyHostId(repoBaseDir, cwd) : undefined;

    const sources: MemorySource[] = [];
    if (fs.existsSync(liveDir)) sources.push('live');
    for (const h of hostsFound) sources.push(`repo:${h}` as MemorySource);

    return {
      projectId: legacyKey,
      projectPath: cwd,
      liveDir,
      repoBaseDir: fs.existsSync(repoBaseDir) ? repoBaseDir : undefined,
      myHostId,
      hosts: hostsFound,
      sources,
    };
  }

  // ─── Read path ──────────────────────────────────────────

  /**
   * Parse a single memory directory and store it in the cache.
   * Called on watcher events and from getDirData().
   */
  private parseDir(dirPath: string, source: MemorySource): MemoryDirData {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      // Dir missing or unreadable — empty snapshot
      return {
        dirPath,
        source,
        files: [],
        indexRaw: '',
        maxMtimeMs: 0,
        lastParsedMs: Date.now(),
      };
    }

    const files: MemoryFile[] = [];
    let indexRaw = '';
    let maxMtimeMs = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;

      const filePath = path.join(dirPath, entry.name);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;

      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      if (entry.name === INDEX_FILE) {
        indexRaw = content;
        continue;
      }
      if (entry.name === HOSTS_REGISTRY) {
        continue;
      }

      const { frontmatter, body } = parseFrontmatter(content);
      files.push({
        source,
        filename: entry.name,
        filePath,
        frontmatter,
        bodyPreview: body.slice(0, BODY_PREVIEW_CHARS),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }

    // Sort by mtime desc (newest first), matching Claude Code's `kF8` listing
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      dirPath,
      source,
      files,
      indexRaw,
      maxMtimeMs,
      lastParsedMs: Date.now(),
    };
  }

  /**
   * Get cached MemoryDirData for a directory, re-parsing if needed.
   * Cache invalidation: if maxMtime on disk is newer than cached,
   * re-parse. If dir does not exist, return empty snapshot.
   */
  getDirData(dirPath: string, source: MemorySource): MemoryDirData {
    if (!fs.existsSync(dirPath)) {
      return {
        dirPath,
        source,
        files: [],
        indexRaw: '',
        maxMtimeMs: 0,
        lastParsedMs: Date.now(),
      };
    }

    const cached = this.store.getDirData(dirPath);
    if (cached) {
      // Quick freshness check: stat the dir
      try {
        const dirStat = fs.statSync(dirPath);
        // Only re-parse if dir mtime is newer than our last parse
        if (dirStat.mtimeMs <= cached.lastParsedMs) {
          return cached;
        }
      } catch {
        /* fall through to re-parse */
      }
    }

    const data = this.parseDir(dirPath, source);
    void this.store.putDirData(dirPath, data);
    this.fireOnChange(dirPath, data);
    return data;
  }

  /**
   * Read the full body of a single file. Always hits disk — cheap.
   */
  getFileBody(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Aggregate memory for a project across all sources.
   */
  getForProject(cwd: string, opts: {
    sources?: 'all' | 'live' | 'repo';
    hostFilter?: string[];
  } = {}): {
    snapshot: ProjectMemorySnapshot;
    dirs: MemoryDirData[];
  } {
    const snap = this.resolveProject(cwd);
    const wantLive = opts.sources !== 'repo';
    const wantRepo = opts.sources !== 'live';

    const dirs: MemoryDirData[] = [];

    if (wantLive && fs.existsSync(snap.liveDir)) {
      dirs.push(this.getDirData(snap.liveDir, 'live'));
    }

    if (wantRepo && snap.repoBaseDir) {
      const hosts = opts.hostFilter && opts.hostFilter.length > 0
        ? snap.hosts.filter(h => opts.hostFilter!.includes(h))
        : snap.hosts;
      for (const host of hosts) {
        const dir = path.join(snap.repoBaseDir, host);
        dirs.push(this.getDirData(dir, `repo:${host}` as MemorySource));
      }
    }

    return { snapshot: snap, dirs };
  }

  /**
   * Diff live vs my-host repo mirror. Returns:
   *  - liveOnly: filenames present in live but missing from repo:<myHost>
   *  - repoOnly: filenames present in repo:<myHost> but missing from live
   *  - differing: filenames present in both but with different mtime/size
   *
   * If myHostId is unknown, repo side is empty.
   */
  getDiff(cwd: string): {
    liveOnly: string[];
    repoOnly: string[];
    differing: string[];
    myHostId?: string;
  } {
    const snap = this.resolveProject(cwd);
    if (!snap.myHostId || !snap.repoBaseDir) {
      const live = fs.existsSync(snap.liveDir)
        ? this.getDirData(snap.liveDir, 'live').files.map(f => f.filename)
        : [];
      return { liveOnly: live, repoOnly: [], differing: [], myHostId: snap.myHostId };
    }

    const liveData = this.getDirData(snap.liveDir, 'live');
    const repoDir = path.join(snap.repoBaseDir, snap.myHostId);
    const repoData = this.getDirData(repoDir, `repo:${snap.myHostId}` as MemorySource);

    const liveByName = new Map(liveData.files.map(f => [f.filename, f]));
    const repoByName = new Map(repoData.files.map(f => [f.filename, f]));

    const liveOnly: string[] = [];
    const repoOnly: string[] = [];
    const differing: string[] = [];

    for (const [name, lf] of liveByName) {
      const rf = repoByName.get(name);
      if (!rf) {
        liveOnly.push(name);
      } else if (lf.sizeBytes !== rf.sizeBytes || Math.abs(lf.mtimeMs - rf.mtimeMs) > 1000) {
        differing.push(name);
      }
    }
    for (const name of repoByName.keys()) {
      if (!liveByName.has(name)) repoOnly.push(name);
    }

    return { liveOnly, repoOnly, differing, myHostId: snap.myHostId };
  }

  // ─── Batch / poll ───────────────────────────────────────

  /**
   * Lightweight poll: return max mtime across all memory sources
   * for a project. Caller compares against their known value.
   */
  getMaxMtime(cwd: string): number {
    const { dirs } = this.getForProject(cwd, { sources: 'all' });
    let max = 0;
    for (const d of dirs) {
      if (d.maxMtimeMs > max) max = d.maxMtimeMs;
    }
    return max;
  }

  // ─── Watcher ────────────────────────────────────────────

  /**
   * Start watching all memory dirs. Watches:
   *  - `<configDir>/projects/* /memory/` (live)
   *  - any `<cwd>/memory/* /` that's already in the cache
   */
  startWatching(): void {
    if (this.isWatching) return;

    const projectsDir = getProjectsDir();
    const watchPaths: string[] = [];

    // Watch live auto-memory across all projects (one dir up so add/unlink
    // of memory/ subdirs gets seen)
    if (fs.existsSync(projectsDir)) {
      watchPaths.push(projectsDir);
    }

    // Repo mirror dirs already known from cache
    for (const dirPath of this.store.listDirPaths()) {
      if (fs.existsSync(dirPath)) watchPaths.push(dirPath);
    }

    // Pre-discover repo memory dirs for every known project so we receive
    // push events from the start, not only after a query touches them.
    if (fs.existsSync(projectsDir)) {
      let projectDirNames: string[] = [];
      try { projectDirNames = fs.readdirSync(projectsDir); } catch { /* empty */ }
      for (const slug of projectDirNames) {
        let cwd: string;
        try {
          // Lazy require to avoid circular import with utils/path-utils
          const { decodePath } = require('./utils/path-utils');
          cwd = decodePath(slug);
        } catch { continue; }
        const repoBase = path.join(cwd, 'memory');
        if (!fs.existsSync(repoBase)) continue;
        try {
          for (const entry of fs.readdirSync(repoBase, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
              const hostDir = path.join(repoBase, entry.name);
              if (!watchPaths.includes(hostDir)) watchPaths.push(hostDir);
            }
          }
        } catch { /* skip unreadable repo */ }
      }
    }

    if (watchPaths.length === 0) return;

    this.watcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      // depth: 3 → projects/<slug>/memory/<file>.md
      depth: 3,
      ignored: [/node_modules/, /\.git/, /\.lmdb/],
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const onEvent = (event: 'add' | 'change' | 'unlink', filePath: string) => {
      if (!filePath.endsWith('.md')) return;
      const dir = path.dirname(filePath);
      this.scheduleUpdate(dir);
    };

    this.watcher.on('add', (fp) => onEvent('add', fp));
    this.watcher.on('change', (fp) => onEvent('change', fp));
    this.watcher.on('unlink', (fp) => onEvent('unlink', fp));
    this.watcher.on('error', (err) => {
      console.error('[MemoryCache] Watcher error:', err);
    });

    this.isWatching = true;
    watchPaths.forEach(p => this.watchedPaths.add(p));
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.isWatching = false;
    this.watchedPaths.clear();
    for (const t of this.pendingUpdates.values()) clearTimeout(t);
    this.pendingUpdates.clear();
  }

  /**
   * Add a path to the watcher live (used when a new project's repo
   * mirror is discovered after startup).
   */
  addWatchPath(dirPath: string): void {
    if (!this.watcher) return;
    if (this.watchedPaths.has(dirPath)) return;
    if (!fs.existsSync(dirPath)) return;
    this.watcher.add(dirPath);
    this.watchedPaths.add(dirPath);
  }

  private scheduleUpdate(dirPath: string): void {
    const existing = this.pendingUpdates.get(dirPath);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      this.pendingUpdates.delete(dirPath);
      this.refreshDir(dirPath);
    }, DEBOUNCE_MS);

    this.pendingUpdates.set(dirPath, timeout);
  }

  /**
   * Re-parse a dir and emit change events.
   * Source is derived from path layout.
   */
  private refreshDir(dirPath: string): void {
    let source: MemorySource;
    const projectsDir = getProjectsDir();
    if (dirPath.startsWith(projectsDir)) {
      source = 'live';
    } else {
      // Assume <cwd>/memory/<host-id>/
      const host = path.basename(dirPath);
      source = `repo:${host}` as MemorySource;
    }
    const data = this.parseDir(dirPath, source);
    void this.store.putDirData(dirPath, data);
    this.fireOnChange(dirPath, data);
  }

  // ─── Lifecycle ──────────────────────────────────────────

  close(): void {
    this.stopWatching();
    this.store.close();
  }
}

// ─── Singleton ──────────────────────────────────────────────

let memoryCacheInstance: MemoryCache | null = null;

export function getMemoryCache(): MemoryCache {
  if (!memoryCacheInstance) {
    const profiler = getStartupProfiler();
    profiler.start('memoryCache', 'MemoryCache');
    memoryCacheInstance = new MemoryCache();
    profiler.start('memoryCacheWatcher', 'File Watcher', 'MemoryCache');
    memoryCacheInstance.startWatching();
    profiler.end('memoryCacheWatcher');
    profiler.end('memoryCache');
    const lmdbMs = profiler.get('memoryLmdbOpen')?.toFixed(1) ?? '?';
    const watchMs = profiler.get('memoryCacheWatcher')?.toFixed(1) ?? '?';
    console.log(`[MemoryCache] LMDB-backed cache initialized (lmdb: ${lmdbMs}ms, watcher: ${watchMs}ms)`);
  }
  return memoryCacheInstance;
}

export function resetMemoryCache(): void {
  if (memoryCacheInstance) {
    memoryCacheInstance.close();
    memoryCacheInstance = null;
  }
}
