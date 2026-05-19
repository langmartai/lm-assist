/**
 * Memory API Implementation
 *
 * Sub-API on TierControlApiImpl exposing read access to Claude Code
 * memory directories — both the live auto-memory dir
 * (`~/.claude/projects/<slug>/memory/`) and the in-repo per-host
 * mirror (`<cwd>/memory/<host-id>/`).
 *
 * Designed to back two consumers:
 *   - the standalone `/memory/*` routes
 *   - the `?includeMemory=...` join on `/sessions/:id` and friends
 */

import * as fs from 'fs';
import * as path from 'path';
import { wrapResponse, wrapError } from './helpers';
import { getMemoryCache, MemoryCache, MemoryDirData, MemoryFile, MemorySource, ProjectMemorySnapshot } from '../memory-cache';
import { getProjectsService } from '../projects-service';
import { getSessionCache } from '../session-cache';
import { decodePath, legacyEncodeProjectPath, getProjectsDir } from '../utils/path-utils';
import { tokenize } from '../search/text-scorer';
import { classifyShareability, Shareability } from '../utils/memory-shareability';
import { MemoryFrontmatter } from '../utils/frontmatter';
import type { ApiResponse } from '../types/control-api';

// ─── Public response shapes ─────────────────────────────────

export type MemoryDetail = 'index' | 'list' | 'full' | 'relevant';

export interface MemoryListEntry {
  source: MemorySource;
  filename: string;
  frontmatter: MemoryFile['frontmatter'];
  bodyPreview: string;
  mtimeMs: number;
  sizeBytes: number;
  shareability?: Shareability;
  /** Populated when detail=relevant — score from text-scorer */
  relevanceScore?: number;
}

export interface MemoryFullEntry extends MemoryListEntry {
  body: string;
}

export interface MemoryProjectListing {
  projectId: string;
  projectPath: string;
  liveDir: string;
  repoBaseDir?: string;
  myHostId?: string;
  hosts: string[];
  sources: MemorySource[];
  detail: MemoryDetail;
  index?: { raw: string; entries: Array<{ title: string; filename: string; hook: string }> };
  files?: Array<MemoryListEntry | MemoryFullEntry>;
  /** Sum of all file sizes returned (for cap awareness on detail=full) */
  totalBytes?: number;
  /** Set true when detail=full hits the 500KB aggregate cap */
  truncated?: boolean;
  lastParsedMs: number;
}

export interface MemoryProjectSummary {
  projectId: string;
  projectPath: string;
  hasLive: boolean;
  hasRepo: boolean;
  hostCount: number;
  fileCount: number;
  maxMtimeMs: number;
}

export interface MemorySourcesInfo {
  projectId: string;
  projectPath: string;
  sources: Array<{
    source: MemorySource;
    dirPath: string;
    fileCount: number;
    maxMtimeMs: number;
  }>;
  myHostId?: string;
  hosts: string[];
}

export interface MemoryDiff {
  projectId: string;
  myHostId?: string;
  liveOnly: string[];
  repoOnly: string[];
  differing: string[];
}

export interface MemoryFileResponse {
  projectId: string;
  source: MemorySource;
  filename: string;
  filePath: string;
  frontmatter: MemoryFile['frontmatter'];
  body: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface MemoryBatchCheckRequest {
  projects: Array<{ projectId: string; knownMaxMtime?: number }>;
}

export interface MemoryBatchCheckResponse {
  results: Array<{
    projectId: string;
    maxMtimeMs: number;
    changed: boolean;
  }>;
}

export interface CrossHostQueryOptions {
  query?: string;
  limit?: number;
  /** Which shareability classes to include. Default: ['project-domain'] */
  include?: Shareability[];
  /** Restrict to these host folders. Default: all non-my-host folders */
  hostFilter?: string[];
}

export interface CrossHostResult {
  source: MemorySource;
  filename: string;
  frontmatter: MemoryFrontmatter;
  bodyPreview: string;
  mtimeMs: number;
  sizeBytes: number;
  shareability: Shareability;
  relevanceScore: number;
  presentLocally: boolean;
  /** When presentLocally is true, the local copy's mtime — for staleness checks */
  localMtimeMs?: number;
  /** When presentLocally is true, the local copy's size */
  localSizeBytes?: number;
}

export interface CrossHostResponse {
  projectId: string;
  myHostId?: string;
  query: string;
  hostsScanned: string[];
  results: CrossHostResult[];
  total: number;
}

export interface ImportCandidate {
  source: MemorySource;
  filename: string;
  frontmatter: MemoryFrontmatter;
  body: string;
  bodyPreview: string;
  mtimeMs: number;
  sizeBytes: number;
  shareability: Shareability;
  /** Reason this file is being suggested */
  reason: 'not-present-locally' | 'newer-than-local';
  /** Filled when newer-than-local */
  localMtimeMs?: number;
  localSizeBytes?: number;
  /** Optional score against query if q= was provided */
  relevanceScore?: number;
}

export interface ImportCandidatesResponse {
  projectId: string;
  myHostId?: string;
  query?: string;
  hostsScanned: string[];
  candidates: ImportCandidate[];
  total: number;
}

// ─── Internals ──────────────────────────────────────────────

const FULL_DETAIL_CAP_BYTES = 500 * 1024;

/**
 * Parse a MEMORY.md into one-line index entries:
 *   - [Title](filename.md) — hook text
 */
function parseIndexEntries(raw: string): Array<{ title: string; filename: string; hook: string }> {
  const entries: Array<{ title: string; filename: string; hook: string }> = [];
  const re = /^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—|--|-)?\s*(.*)$/;
  for (const line of raw.split('\n')) {
    const m = line.trim().match(re);
    if (!m) continue;
    entries.push({
      title: m[1].trim(),
      filename: m[2].trim(),
      hook: m[3].trim(),
    });
  }
  return entries;
}

/**
 * Resolve a session ID to its project cwd by scanning projects-service.
 * Returns undefined if the session is unknown.
 */
function resolveSessionToCwd(sessionId: string): string | undefined {
  // Scan known projects for a session file matching this id
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const slug of dirs) {
    const candidate = path.join(projectsDir, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      // Decode the slug to a cwd
      try {
        return decodePath(slug);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function pickFiles(
  dirs: MemoryDirData[],
  detail: MemoryDetail,
  opts: { query?: string; limit?: number } = {},
): { files: Array<MemoryListEntry | MemoryFullEntry>; totalBytes: number; truncated: boolean } {
  const out: Array<MemoryListEntry | MemoryFullEntry> = [];
  let totalBytes = 0;
  let truncated = false;

  // Relevant mode: score, dedup by filename (prefer live > repo:<host>),
  // sort by score desc, slice to limit, then read bodies
  if (detail === 'relevant') {
    const limit = opts.limit ?? 5;
    const queryStr = opts.query ?? '';
    const queryTokens = tokenize(queryStr);
    const queryLower = queryStr.toLowerCase();

    // Dedup pass — same filename may appear in live + repo:<myHost> mirrors.
    // Keep one entry per filename, preferring 'live' source.
    const bestByName = new Map<string, MemoryFile>();
    for (const d of dirs) {
      for (const f of d.files) {
        const prev = bestByName.get(f.filename);
        if (!prev) {
          bestByName.set(f.filename, f);
          continue;
        }
        // Prefer 'live' source; on tie, take the newer mtime
        const prevIsLive = prev.source === 'live';
        const fIsLive = f.source === 'live';
        if (fIsLive && !prevIsLive) {
          bestByName.set(f.filename, f);
        } else if (fIsLive === prevIsLive && f.mtimeMs > prev.mtimeMs) {
          bestByName.set(f.filename, f);
        }
      }
    }

    const scored: Array<{ file: MemoryFile; score: number }> = [];
    for (const f of bestByName.values()) {
      const score = scoreMemoryFile(f, queryTokens, queryLower);
      if (score > 0) scored.push({ file: f, score });
    }
    scored.sort((a, b) => b.score - a.score);

    for (const { file: f, score } of scored.slice(0, limit)) {
      let body = '';
      try { body = fs.readFileSync(f.filePath, 'utf-8'); } catch { /* skip */ }
      out.push({
        source: f.source,
        filename: f.filename,
        frontmatter: f.frontmatter,
        bodyPreview: f.bodyPreview,
        mtimeMs: f.mtimeMs,
        sizeBytes: f.sizeBytes,
        shareability: classifyShareability(f.filename, f.frontmatter),
        relevanceScore: score,
        body,
      } as MemoryFullEntry);
    }
    return { files: out, totalBytes: out.reduce((s, x: any) => s + (x.body?.length || 0), 0), truncated: false };
  }

  // Non-relevant modes: index/list/full
  for (const d of dirs) {
    for (const f of d.files) {
      const base: MemoryListEntry = {
        source: f.source,
        filename: f.filename,
        frontmatter: f.frontmatter,
        bodyPreview: f.bodyPreview,
        mtimeMs: f.mtimeMs,
        sizeBytes: f.sizeBytes,
        shareability: classifyShareability(f.filename, f.frontmatter),
      };
      if (detail === 'full') {
        if (totalBytes + f.sizeBytes > FULL_DETAIL_CAP_BYTES) {
          truncated = true;
          out.push(base);
          continue;
        }
        try {
          const body = fs.readFileSync(f.filePath, 'utf-8');
          totalBytes += f.sizeBytes;
          out.push({ ...base, body } as MemoryFullEntry);
        } catch {
          out.push(base);
        }
      } else {
        out.push(base);
      }
    }
  }
  return { files: out, totalBytes, truncated };
}

/**
 * Score a memory file against a query, mirroring the style of
 * text-scorer.scoreSession. Weights:
 *   - frontmatter.name × 5 (most signal-dense)
 *   - frontmatter.description × 4
 *   - body × 1
 * Full-query substring matches add a flat 10 × weight bonus.
 */
function scoreMemoryFile(file: MemoryFile, queryTokens: string[], queryLower: string): number {
  if (queryTokens.length === 0 && !queryLower) return 0;
  let score = 0;

  const scoreText = (text: string | undefined, weight: number) => {
    if (!text) return;
    const lower = text.toLowerCase();
    if (queryLower && lower.includes(queryLower)) {
      score += 10 * weight;
    }
    for (const tok of queryTokens) {
      if (lower.includes(tok)) score += weight;
    }
  };

  scoreText(file.frontmatter.name, 5);
  scoreText(file.frontmatter.description, 4);
  scoreText(file.bodyPreview, 1);
  // Filename also carries signal — useful for "broker" → broker_boundary
  scoreText(file.filename, 2);

  return score;
}

// ─── Public API ──────────────────────────────────────────────

export interface GetByProjectOpts {
  detail?: MemoryDetail;
  sources?: 'all' | 'live' | 'repo';
  hostFilter?: string[];
  /** Required when detail='relevant' */
  relevanceQuery?: string;
  /** Used for detail='relevant'; default 5 */
  limit?: number;
}

export interface MemoryApi {
  listProjects(): Promise<ApiResponse<MemoryProjectSummary[]>>;
  getByProject(projectId: string, opts?: GetByProjectOpts): Promise<ApiResponse<MemoryProjectListing>>;
  getIndex(projectId: string, opts?: { source?: 'live' | `repo:${string}` }): Promise<ApiResponse<{ raw: string; entries: Array<{ title: string; filename: string; hook: string }> }>>;
  getFile(projectId: string, source: MemorySource, filename: string): Promise<ApiResponse<MemoryFileResponse>>;
  getSources(projectId: string): Promise<ApiResponse<MemorySourcesInfo>>;
  getDiff(projectId: string): Promise<ApiResponse<MemoryDiff>>;
  hasUpdate(projectId: string, sinceMs: number): Promise<ApiResponse<{ projectId: string; maxMtimeMs: number; changed: boolean }>>;
  batchCheck(req: MemoryBatchCheckRequest): Promise<ApiResponse<MemoryBatchCheckResponse>>;

  // Cross-host relevance query
  crossHost(projectId: string, opts?: CrossHostQueryOptions): Promise<ApiResponse<CrossHostResponse>>;

  // Session-resolution helper used by /sessions/:id join
  getForSession(sessionId: string, opts?: GetByProjectOpts): Promise<ApiResponse<MemoryProjectListing | null>>;

  // Sync helper — what should Claude Code consider importing from other hosts?
  // lm-assist is read-only; Claude Code does the actual writes.
  getImportCandidates(projectId: string, opts?: { query?: string; hostFilter?: string[]; limit?: number }): Promise<ApiResponse<ImportCandidatesResponse>>;

  // Cache control
  warm(projectIds?: string[]): Promise<ApiResponse<{ warmed: number }>>;
  clear(projectId?: string): Promise<ApiResponse<{ cleared: number }>>;
}

export interface MemoryApiDeps {
  cache?: MemoryCache;
}

export function createMemoryApiImpl(deps: MemoryApiDeps = {}): MemoryApi {
  const cache = deps.cache || getMemoryCache();

  function resolveProjectIdToCwd(projectId: string): string | null {
    // projectId may already be an encoded slug or a decoded path
    const projectsDir = getProjectsDir();

    // 1) Try ProjectsService — handles all encoding variants
    const ps = getProjectsService();
    const project = ps.getProject(projectId);
    if (project) {
      const storage1 = path.join(projectsDir, project.encodedPath || legacyEncodeProjectPath(project.path));
      const storage2 = path.join(projectsDir, legacyEncodeProjectPath(project.path));
      if (fs.existsSync(storage1) || fs.existsSync(storage2)) return project.path;
    }

    // 2) Direct decode + verify the project's storage dir actually exists.
    // Without this check, decodePath happily returns "/totally/fake/project"
    // for a bogus slug and the rest of the code path silently returns
    // empty results instead of a clear 404.
    try {
      const cwd = decodePath(projectId);
      const slug = projectId;
      const legacySlug = legacyEncodeProjectPath(cwd);
      if (fs.existsSync(path.join(projectsDir, slug))
        || fs.existsSync(path.join(projectsDir, legacySlug))
        || fs.existsSync(cwd) /* allow projects with repo memory but no live dir */) {
        return cwd;
      }
    } catch { /* fall through */ }
    return null;
  }

  return {
    listProjects: async () => {
      const start = Date.now();
      try {
        const projectsDir = getProjectsDir();
        const summaries: MemoryProjectSummary[] = [];
        if (!fs.existsSync(projectsDir)) {
          return wrapResponse(summaries, start);
        }
        for (const slug of fs.readdirSync(projectsDir)) {
          const projectStorage = path.join(projectsDir, slug);
          if (!fs.statSync(projectStorage).isDirectory()) continue;
          const liveMem = path.join(projectStorage, 'memory');
          let cwd: string;
          try {
            cwd = decodePath(slug);
          } catch {
            continue;
          }
          const snap = cache.resolveProject(cwd);
          if (!fs.existsSync(liveMem) && !snap.repoBaseDir) continue;
          const { dirs } = cache.getForProject(cwd, { sources: 'all' });
          const fileCount = dirs.reduce((sum, d) => sum + d.files.length, 0);
          const maxMtime = dirs.reduce((m, d) => Math.max(m, d.maxMtimeMs), 0);
          summaries.push({
            projectId: snap.projectId,
            projectPath: snap.projectPath,
            hasLive: fs.existsSync(liveMem),
            hasRepo: !!snap.repoBaseDir,
            hostCount: snap.hosts.length,
            fileCount,
            maxMtimeMs: maxMtime,
          });
        }
        // Sort by max mtime desc
        summaries.sort((a, b) => b.maxMtimeMs - a.maxMtimeMs);
        return wrapResponse(summaries, start);
      } catch (e) {
        return wrapError('MEMORY_LIST_PROJECTS_ERROR', String(e), start);
      }
    },

    getByProject: async (projectId, opts = {}) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);

        const detail: MemoryDetail = opts.detail ?? 'list';
        const { snapshot, dirs } = cache.getForProject(cwd, {
          sources: opts.sources ?? 'all',
          hostFilter: opts.hostFilter,
        });

        // Make sure freshly-discovered repo dirs are also being watched
        for (const d of dirs) cache.addWatchPath(d.dirPath);

        const out: MemoryProjectListing = {
          projectId: snapshot.projectId,
          projectPath: snapshot.projectPath,
          liveDir: snapshot.liveDir,
          repoBaseDir: snapshot.repoBaseDir,
          myHostId: snapshot.myHostId,
          hosts: snapshot.hosts,
          sources: snapshot.sources,
          detail,
          lastParsedMs: dirs.reduce((m, d) => Math.max(m, d.lastParsedMs), 0),
        };

        // Index from the first dir that has one (prefer live)
        const indexSource = dirs.find(d => d.source === 'live' && d.indexRaw)
          || dirs.find(d => d.indexRaw);
        if (indexSource) {
          out.index = {
            raw: indexSource.indexRaw,
            entries: parseIndexEntries(indexSource.indexRaw),
          };
        }

        if (detail !== 'index') {
          const picked = pickFiles(dirs, detail, {
            query: opts.relevanceQuery,
            limit: opts.limit,
          });
          out.files = picked.files;
          if (detail === 'full') {
            out.totalBytes = picked.totalBytes;
            out.truncated = picked.truncated;
          }
        }

        return wrapResponse(out, start);
      } catch (e) {
        return wrapError('MEMORY_GET_PROJECT_ERROR', String(e), start);
      }
    },

    getIndex: async (projectId, opts = {}) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const { dirs } = cache.getForProject(cwd, { sources: opts.source ? (opts.source === 'live' ? 'live' : 'repo') : 'all' });
        const target = opts.source
          ? dirs.find(d => d.source === opts.source)
          : (dirs.find(d => d.source === 'live' && d.indexRaw) || dirs.find(d => d.indexRaw));
        const raw = target?.indexRaw || '';
        return wrapResponse({ raw, entries: parseIndexEntries(raw) }, start);
      } catch (e) {
        return wrapError('MEMORY_INDEX_ERROR', String(e), start);
      }
    },

    getFile: async (projectId, source, filename) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const { dirs } = cache.getForProject(cwd, {
          sources: source === 'live' ? 'live' : 'repo',
          hostFilter: source.startsWith('repo:') ? [source.slice(5)] : undefined,
        });
        const target = dirs.find(d => d.source === source);
        if (!target) return wrapError('SOURCE_NOT_FOUND', `Source not found: ${source}`, start);
        const file = target.files.find(f => f.filename === filename);
        if (!file) return wrapError('FILE_NOT_FOUND', `File not found: ${filename}`, start);
        const body = cache.getFileBody(file.filePath) || '';
        const resp: MemoryFileResponse = {
          projectId: legacyEncodeProjectPath(cwd),
          source,
          filename,
          filePath: file.filePath,
          frontmatter: file.frontmatter,
          body,
          mtimeMs: file.mtimeMs,
          sizeBytes: file.sizeBytes,
        };
        return wrapResponse(resp, start);
      } catch (e) {
        return wrapError('MEMORY_FILE_ERROR', String(e), start);
      }
    },

    getSources: async (projectId) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const { snapshot, dirs } = cache.getForProject(cwd, { sources: 'all' });
        const resp: MemorySourcesInfo = {
          projectId: snapshot.projectId,
          projectPath: snapshot.projectPath,
          sources: dirs.map(d => ({
            source: d.source,
            dirPath: d.dirPath,
            fileCount: d.files.length,
            maxMtimeMs: d.maxMtimeMs,
          })),
          myHostId: snapshot.myHostId,
          hosts: snapshot.hosts,
        };
        return wrapResponse(resp, start);
      } catch (e) {
        return wrapError('MEMORY_SOURCES_ERROR', String(e), start);
      }
    },

    getDiff: async (projectId) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const diff = cache.getDiff(cwd);
        return wrapResponse({
          projectId: legacyEncodeProjectPath(cwd),
          ...diff,
        }, start);
      } catch (e) {
        return wrapError('MEMORY_DIFF_ERROR', String(e), start);
      }
    },

    hasUpdate: async (projectId, sinceMs) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const maxMtimeMs = cache.getMaxMtime(cwd);
        return wrapResponse({
          projectId: legacyEncodeProjectPath(cwd),
          maxMtimeMs,
          changed: maxMtimeMs > sinceMs,
        }, start);
      } catch (e) {
        return wrapError('MEMORY_HAS_UPDATE_ERROR', String(e), start);
      }
    },

    batchCheck: async (req) => {
      const start = Date.now();
      try {
        const results: MemoryBatchCheckResponse['results'] = [];
        for (const item of req.projects || []) {
          const cwd = resolveProjectIdToCwd(item.projectId);
          if (!cwd) {
            results.push({ projectId: item.projectId, maxMtimeMs: 0, changed: false });
            continue;
          }
          const maxMtimeMs = cache.getMaxMtime(cwd);
          results.push({
            projectId: item.projectId,
            maxMtimeMs,
            changed: typeof item.knownMaxMtime === 'number' ? maxMtimeMs > item.knownMaxMtime : true,
          });
        }
        return wrapResponse({ results }, start);
      } catch (e) {
        return wrapError('MEMORY_BATCH_CHECK_ERROR', String(e), start);
      }
    },

    getForSession: async (sessionId, opts = {}) => {
      const start = Date.now();
      try {
        // Try session cache first — much faster if the session is already loaded
        let cwd: string | undefined;
        try {
          const sessionCache = getSessionCache();
          // We don't know the full session path, but session-cache stores by path
          // Best effort: scan projects dir like resolveSessionToCwd does
          cwd = resolveSessionToCwd(sessionId);
        } catch {
          cwd = resolveSessionToCwd(sessionId);
        }
        if (!cwd) {
          // Session not found — return null payload (not an error: includeMemory is optional)
          return wrapResponse(null, start);
        }
        const detail: MemoryDetail = opts.detail ?? 'list';
        const { snapshot, dirs } = cache.getForProject(cwd, {
          sources: opts.sources ?? 'all',
          hostFilter: opts.hostFilter,
        });
        for (const d of dirs) cache.addWatchPath(d.dirPath);

        const out: MemoryProjectListing = {
          projectId: snapshot.projectId,
          projectPath: snapshot.projectPath,
          liveDir: snapshot.liveDir,
          repoBaseDir: snapshot.repoBaseDir,
          myHostId: snapshot.myHostId,
          hosts: snapshot.hosts,
          sources: snapshot.sources,
          detail,
          lastParsedMs: dirs.reduce((m, d) => Math.max(m, d.lastParsedMs), 0),
        };

        const indexSource = dirs.find(d => d.source === 'live' && d.indexRaw)
          || dirs.find(d => d.indexRaw);
        if (indexSource) {
          out.index = {
            raw: indexSource.indexRaw,
            entries: parseIndexEntries(indexSource.indexRaw),
          };
        }

        if (detail !== 'index') {
          const picked = pickFiles(dirs, detail, {
            query: opts.relevanceQuery,
            limit: opts.limit,
          });
          out.files = picked.files;
          if (detail === 'full') {
            out.totalBytes = picked.totalBytes;
            out.truncated = picked.truncated;
          }
        }

        return wrapResponse(out, start);
      } catch (e) {
        return wrapError('MEMORY_GET_FOR_SESSION_ERROR', String(e), start);
      }
    },

    crossHost: async (projectId, opts = {}) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);

        const snap = cache.resolveProject(cwd);
        if (!snap.repoBaseDir) {
          return wrapResponse({
            projectId: snap.projectId,
            myHostId: snap.myHostId,
            query: opts.query ?? '',
            hostsScanned: [],
            results: [],
            total: 0,
          }, start);
        }

        // Default scope: all hosts except my own
        const allHosts = snap.hosts;
        const otherHosts = opts.hostFilter && opts.hostFilter.length > 0
          ? opts.hostFilter.filter(h => allHosts.includes(h))
          : allHosts.filter(h => h !== snap.myHostId);

        const includeSet = new Set<Shareability>(
          opts.include && opts.include.length > 0 ? opts.include : ['project-domain']
        );

        const queryStr = opts.query ?? '';
        const queryTokens = tokenize(queryStr);
        const queryLower = queryStr.toLowerCase();
        const limit = opts.limit ?? 10;

        // Build a map of locally-present files (live dir) so we can flag
        // presence and surface local mtime/size for staleness checks.
        const localByName = new Map<string, MemoryFile>();
        if (fs.existsSync(snap.liveDir)) {
          const liveDir = cache.getDirData(snap.liveDir, 'live');
          for (const f of liveDir.files) localByName.set(f.filename, f);
        }

        // Dedup across hosts: same filename in multiple host folders → keep
        // the newest. Map key is filename.
        const bestByName = new Map<string, { file: MemoryFile; shareability: Shareability }>();
        for (const host of otherHosts) {
          const dirPath = path.join(snap.repoBaseDir, host);
          if (!fs.existsSync(dirPath)) continue;
          const data = cache.getDirData(dirPath, `repo:${host}` as MemorySource);
          cache.addWatchPath(dirPath);
          for (const f of data.files) {
            const shareability = classifyShareability(f.filename, f.frontmatter);
            if (!includeSet.has(shareability)) continue;
            const prev = bestByName.get(f.filename);
            if (!prev || f.mtimeMs > prev.file.mtimeMs) {
              bestByName.set(f.filename, { file: f, shareability });
            }
          }
        }

        const results: CrossHostResult[] = [];
        for (const { file: f, shareability } of bestByName.values()) {
          const score = queryStr ? scoreMemoryFile(f, queryTokens, queryLower) : 0;
          if (queryStr && score <= 0) continue;
          const local = localByName.get(f.filename);
          results.push({
            source: f.source,
            filename: f.filename,
            frontmatter: f.frontmatter,
            bodyPreview: f.bodyPreview,
            mtimeMs: f.mtimeMs,
            sizeBytes: f.sizeBytes,
            shareability,
            relevanceScore: score,
            presentLocally: !!local,
            localMtimeMs: local?.mtimeMs,
            localSizeBytes: local?.sizeBytes,
          } as CrossHostResult);
        }

        // Sort: with query, by score desc then mtime desc; without query, by mtime desc
        results.sort((a, b) => {
          if (queryStr) {
            if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
          }
          return b.mtimeMs - a.mtimeMs;
        });

        return wrapResponse({
          projectId: snap.projectId,
          myHostId: snap.myHostId,
          query: queryStr,
          hostsScanned: otherHosts,
          results: results.slice(0, limit),
          total: results.length,
        }, start);
      } catch (e) {
        return wrapError('MEMORY_CROSS_HOST_ERROR', String(e), start);
      }
    },

    getImportCandidates: async (projectId, opts = {}) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);

        const snap = cache.resolveProject(cwd);
        if (!snap.repoBaseDir) {
          return wrapResponse({
            projectId: snap.projectId,
            myHostId: snap.myHostId,
            query: opts.query,
            hostsScanned: [],
            candidates: [],
            total: 0,
          }, start);
        }

        const otherHosts = opts.hostFilter && opts.hostFilter.length > 0
          ? opts.hostFilter.filter(h => snap.hosts.includes(h))
          : snap.hosts.filter(h => h !== snap.myHostId);

        const queryStr = opts.query ?? '';
        const queryTokens = tokenize(queryStr);
        const queryLower = queryStr.toLowerCase();

        // Local live state — used to mark presence/staleness
        const localByName = new Map<string, MemoryFile>();
        if (fs.existsSync(snap.liveDir)) {
          const liveData = cache.getDirData(snap.liveDir, 'live');
          for (const f of liveData.files) localByName.set(f.filename, f);
        }

        const candidates: ImportCandidate[] = [];
        for (const host of otherHosts) {
          const dirPath = path.join(snap.repoBaseDir, host);
          if (!fs.existsSync(dirPath)) continue;
          const data = cache.getDirData(dirPath, `repo:${host}` as MemorySource);
          cache.addWatchPath(dirPath);

          for (const f of data.files) {
            const shareability = classifyShareability(f.filename, f.frontmatter);
            // Only auto-suggest project-domain — host-local stays put,
            // ambiguous is hidden by default to avoid noise.
            if (shareability !== 'project-domain') continue;

            const local = localByName.get(f.filename);
            let reason: 'not-present-locally' | 'newer-than-local';
            if (!local) {
              reason = 'not-present-locally';
            } else if (f.mtimeMs > local.mtimeMs + 1000 || f.sizeBytes !== local.sizeBytes) {
              reason = 'newer-than-local';
            } else {
              // Local copy already in sync — skip
              continue;
            }

            const relevanceScore = queryStr ? scoreMemoryFile(f, queryTokens, queryLower) : undefined;
            // If a query was given but the file did not match, skip
            if (queryStr && (relevanceScore ?? 0) <= 0) continue;

            // Read the full body so Claude Code can write it without a second round-trip
            let body = '';
            try { body = fs.readFileSync(f.filePath, 'utf-8'); } catch { /* body stays empty */ }

            candidates.push({
              source: f.source,
              filename: f.filename,
              frontmatter: f.frontmatter,
              body,
              bodyPreview: f.bodyPreview,
              mtimeMs: f.mtimeMs,
              sizeBytes: f.sizeBytes,
              shareability,
              reason,
              localMtimeMs: local?.mtimeMs,
              localSizeBytes: local?.sizeBytes,
              relevanceScore,
            });
          }
        }

        // Sort: with query → score desc then mtime; without → mtime desc
        candidates.sort((a, b) => {
          if (queryStr) {
            const sa = a.relevanceScore ?? 0;
            const sb = b.relevanceScore ?? 0;
            if (sb !== sa) return sb - sa;
          }
          return b.mtimeMs - a.mtimeMs;
        });

        const limit = opts.limit ?? candidates.length;
        return wrapResponse({
          projectId: snap.projectId,
          myHostId: snap.myHostId,
          query: queryStr || undefined,
          hostsScanned: otherHosts,
          candidates: candidates.slice(0, limit),
          total: candidates.length,
        }, start);
      } catch (e) {
        return wrapError('MEMORY_IMPORT_CANDIDATES_ERROR', String(e), start);
      }
    },

    warm: async (projectIds) => {
      const start = Date.now();
      try {
        const projectsDir = getProjectsDir();
        let warmed = 0;
        const targets: string[] = [];
        if (projectIds && projectIds.length > 0) {
          for (const id of projectIds) {
            const cwd = resolveProjectIdToCwd(id);
            if (cwd) targets.push(cwd);
          }
        } else if (fs.existsSync(projectsDir)) {
          for (const slug of fs.readdirSync(projectsDir)) {
            try { targets.push(decodePath(slug)); } catch { /* skip */ }
          }
        }
        for (const cwd of targets) {
          cache.getForProject(cwd, { sources: 'all' });
          warmed += 1;
        }
        return wrapResponse({ warmed }, start);
      } catch (e) {
        return wrapError('MEMORY_WARM_ERROR', String(e), start);
      }
    },

    clear: async (projectId) => {
      const start = Date.now();
      try {
        // The cache exposes only per-dir state. Without a public API for
        // bulk-clear, we re-scan affected dirs which effectively refreshes
        // the cached entry.
        if (projectId) {
          const cwd = resolveProjectIdToCwd(projectId);
          if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
          const { dirs } = cache.getForProject(cwd, { sources: 'all' });
          for (const d of dirs) cache.getDirData(d.dirPath, d.source);
          return wrapResponse({ cleared: dirs.length }, start);
        }
        // Full clear: re-resolve every project
        const projectsDir = getProjectsDir();
        let cleared = 0;
        if (fs.existsSync(projectsDir)) {
          for (const slug of fs.readdirSync(projectsDir)) {
            try {
              const cwd = decodePath(slug);
              const { dirs } = cache.getForProject(cwd, { sources: 'all' });
              cleared += dirs.length;
            } catch { /* skip */ }
          }
        }
        return wrapResponse({ cleared }, start);
      } catch (e) {
        return wrapError('MEMORY_CLEAR_ERROR', String(e), start);
      }
    },
  };
}
