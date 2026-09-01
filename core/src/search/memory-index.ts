// core/src/search/memory-index.ts
// SQLite FTS5 index over LOCAL memory files, sharing the ranked-search path with the
// session prompt index (see fts-rank.ts).
//
// WHY: memory search scored files with `lower.includes(token)` — unanchored substring,
// OR semantics, no threshold. Measured on this node, "auto model discovery and publish"
// matched 110 of 121 memory files, dragged in by `and` hitting inside
// `command`/`understand`/`expand`. That is the same defect that made session search
// return every session; the memory corpus was simply small enough to hide it.
//
// SCOPE — LOCAL FILES ONLY. Memory from other hosts is metadata pulled from peers and
// never lands on this disk, so it cannot be indexed here. Those paths keep the
// substring scorer, which is why that scorer was fixed rather than replaced.
import * as fs from 'fs';
import * as path from 'path';
import { SqlBackend } from '../data/backends/sql-backend';
import { getDatasetRegistry } from '../data/dataset-registry';
import { thisNodeId, dataRoot } from '../data/paths';
import { getProjectsDir, legacyEncodeProjectPath } from '../utils/path-utils';
import type { DataRecord } from '../data/types';
import { rankedFtsSearch } from './fts-rank';
import { expandCjk, hasCjk } from '../data/backends/fts-query';

export const MEMORY_DATASET = 'memory-files';

const INDEXED_FIELDS: Array<{ path: string; type: 'text' | 'number' }> = [
  { path: 'projectId', type: 'text' },
  { path: 'filename', type: 'text' },
  { path: 'host', type: 'text' },
  { path: 'source', type: 'text' },     // 'live' | 'repo'
  { path: 'mtimeMs', type: 'number' },
];

/** Per-prompt-file cap on indexed text. Memory files are small; this is a backstop. */
const MAX_INDEXED_TEXT = 40000;

interface Watermark { mtimeMs: number; size: number; id: string }
interface IndexState { version: number; epoch: number; files: Record<string, Watermark>; }
const STATE_VERSION = 2;
/** Bump to force a rebuild when the stored shape changes (see PromptIndex.INDEX_EPOCH).
 *  3: index repo host-mirrors too; record ids gained a host segment.
 *  4: skip git worktrees, which triplicated a repo's tracked mirrors. */
const INDEX_EPOCH = 4;

export interface MemoryHit {
  projectId: string;
  filename: string;
  /** Which host's memory this is — this node for `live`, a peer for a repo mirror. */
  host: string;
  source: 'live' | 'repo';
  /** bm25 rank position, 0 = best. */
  rank: number;
}

export interface MemorySearchResult {
  mode: 'and' | 'or';
  hits: MemoryHit[];
  truncated: boolean;
}

export class MemoryIndex {
  private backend: SqlBackend;
  private state: IndexState = { version: STATE_VERSION, epoch: INDEX_EPOCH, files: {} };
  private statePath: string;
  private ready = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(storeDirOverride?: string, statePathOverride?: string) {
    this.backend = new SqlBackend(storeDirOverride);
    // dataRoot(), never getDataDir(): the store is dev/prod split and a shared watermark
    // file would let one Core's progress convince the other that an EMPTY store is full.
    this.statePath = statePathOverride || path.join(dataRoot(), 'memory-index-state.json');
  }

  async init(): Promise<void> {
    if (this.ready) return;
    const registry = getDatasetRegistry();
    if (!registry.get(MEMORY_DATASET)) {
      registry.create({
        id: MEMORY_DATASET,
        backend: 'sql',
        title: 'Memory file index (system)',
        visibility: 'local-only',
        system: true,
        readOnly: true,          // the indexer is the only writer
        config: { kind: 'sql', indexedFields: INDEXED_FIELDS },
        acl: [{ principal: '*', actions: ['read', 'query'] }],
        syncMode: 'none',
      });
    }
    await this.backend.createDataset({
      id: MEMORY_DATASET, backend: 'sql', ownerNode: thisNodeId(),
      config: { kind: 'sql', indexedFields: INDEXED_FIELDS },
    } as any);
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as IndexState;
      if (raw && raw.version === STATE_VERSION && raw.files) {
        this.state = { ...raw, epoch: typeof raw.epoch === 'number' ? raw.epoch : 0 };
      }
    } catch { /* first run */ }
    if (this.state.epoch !== INDEX_EPOCH) {
      try {
        await this.backend.dropDataset(MEMORY_DATASET);
        await this.backend.createDataset({
          id: MEMORY_DATASET, backend: 'sql', ownerNode: thisNodeId(),
          config: { kind: 'sql', indexedFields: INDEXED_FIELDS },
        } as any);
      } catch { /* rebuild is best effort; a stale store still answers */ }
      this.state = { version: STATE_VERSION, epoch: INDEX_EPOCH, files: {} };
      this.dirty = true;
      this.flushState();
    }
    this.ready = true;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushState(); }, 2000);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flushState(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.statePath);   // atomic — a torn state file loses every watermark
      this.dirty = false;
    } catch { /* a lost flush costs a re-scan, never correctness */ }
  }

  /**
   * Every memory file reachable on this disk:
   *
   *  - LIVE   `~/.claude/projects/<encoded>/memory/*.md` — this host's own memory.
   *  - REPO   `<cwd>/memory/<host-id>/*.md` — OTHER hosts' memory, git-synced into the
   *           project as mirrors.
   *
   * The mirrors matter: cross-host memory search reads exactly these directories, so it
   * can be bm25-ranked like everything else. (An earlier note claimed peer memory "never
   * lands on local disk" and therefore could not be indexed — that was wrong; 164 mirrored
   * files were sitting in the repos at the time.)
   *
   * Project cwds come from the session cache rather than from decoding the project
   * directory name: that encoding replaces `/` with `-` and is lossy for any path that
   * already contains a hyphen (`my-hyphenated-project` would decode to `my/hyphenated/project`).
   */
  private listMemoryFiles(): Array<{ file: string; projectId: string; host: string; source: 'live' | 'repo' }> {
    const out: Array<{ file: string; projectId: string; host: string; source: 'live' | 'repo' }> = [];
    const me = thisNodeId();

    const root = getProjectsDir();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { /* no projects dir */ }
    for (const d of dirs) {
      const mem = path.join(root, d, 'memory');
      try {
        if (!fs.statSync(mem).isDirectory()) continue;
        for (const f of fs.readdirSync(mem)) {
          if (f.endsWith('.md')) out.push({ file: path.join(mem, f), projectId: d, host: me, source: 'live' });
        }
      } catch { /* no memory dir for this project */ }
    }

    for (const cwd of this.projectCwds()) {
      const base = path.join(cwd, 'memory');
      const projectId = legacyEncodeProjectPath(cwd);
      let hosts: string[] = [];
      try {
        if (!fs.statSync(base).isDirectory()) continue;
        hosts = fs.readdirSync(base, { withFileTypes: true })
          // `_hosts.md` and dot-dirs are registry/bookkeeping, not a host's memory.
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
          .map((e) => e.name);
      } catch { continue; }
      for (const host of hosts) {
        const dir = path.join(base, host);
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.md')) out.push({ file: path.join(dir, f), projectId, host, source: 'repo' });
          }
        } catch { /* unreadable mirror */ }
      }
    }
    return out;
  }

  /** Distinct project cwds known to this node, from the session cache (accurate, unlike decoding). */
  private projectCwds(): string[] {
    try {
      const { getSessionCache } = require('../session-cache') as typeof import('../session-cache');
      const seen = new Set<string>();
      for (const s of getSessionCache().getAllSessionsFromCache()) {
        const cwd = s.cacheData?.cwd;
        if (!cwd) continue;
        // Skip git worktrees. `<repo>/memory/<host>/` is TRACKED, so every worktree checks
        // out the same mirrors and the same memory file would be indexed once per
        // worktree — measured, one file appeared three times from a single host purely
        // because two mission worktrees existed beside the main checkout. A worktree is
        // not a separate project for memory; the parent checkout already covers it.
        if (cwd.includes('/.claude/worktrees/') || cwd.includes('\\.claude\\worktrees\\')) continue;
        seen.add(cwd);
      }
      return [...seen];
    } catch {
      return [];
    }
  }

  /**
   * Index one memory file if it changed. Unlike session transcripts these are REWRITTEN
   * in place rather than appended, so the watermark is (mtime, size) and the whole file
   * is re-read — there is no meaningful tail.
   */
  async indexFile(filePath: string, projectId: string, host?: string, source: 'live' | 'repo' = 'live'): Promise<boolean> {
    await this.init();
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { return false; }
    const prev = this.state.files[filePath];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return false;

    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
    const filename = path.basename(filePath);
    const owner = host || thisNodeId();
    const rec: DataRecord = {
      // Host is part of the id: the same filename legitimately exists for several hosts
      // (a live copy plus one mirror per peer), and collapsing them would let one host's
      // memory overwrite another's.
      id: `${projectId}::${owner}::${filename}`,
      version: 1,
      fields: { projectId, filename, host: owner, source, mtimeMs: st.mtimeMs },
      // Whole file: memory files ARE the topical signal — unlike a transcript there is
      // no assistant chatter or tool output to exclude.
      text: (() => {
        const body = `${filename}\n${raw}`.slice(0, MAX_INDEXED_TEXT);
        // Memory files are the likeliest place for Chinese notes; without bigrams a CJK
        // query only matches a whole unbroken run. Appended, so the body stays readable.
        return hasCjk(body) ? `${body}\n${expandCjk(body)}` : body;
      })(),
      createdAt: new Date(st.mtimeMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.backend.put(MEMORY_DATASET, rec);
    } catch {
      return false;   // watermark not advanced — the next pass retries this file
    }
    this.state.files[filePath] = { mtimeMs: st.mtimeMs, size: st.size, id: rec.id };
    this.scheduleFlush();
    return true;
  }

  /** Index everything changed. Cheap: a few hundred small files, stat-gated. */
  async refresh(): Promise<number> {
    await this.init();
    let n = 0;
    for (const { file, projectId, host, source } of this.listMemoryFiles()) {
      try { if (await this.indexFile(file, projectId, host, source)) n++; } catch { /* skip one bad file */ }
    }
    this.flushState();
    return n;
  }

  /**
   * Ranked filenames for a query, best first. Null means the query had no indexable
   * terms — "cannot search", not "matched nothing".
   */
  async search(query: string, opts: { projectId?: string; host?: string; source?: 'live' | 'repo'; need?: number } = {}): Promise<MemorySearchResult | null> {
    await this.init();
    const filter: any[] = [];
    if (opts.projectId) filter.push({ field: 'projectId', op: 'eq', value: opts.projectId });
    if (opts.host) filter.push({ field: 'host', op: 'eq', value: opts.host });
    if (opts.source) filter.push({ field: 'source', op: 'eq', value: opts.source });
    const r = await rankedFtsSearch(this.backend, MEMORY_DATASET, query, { filter, need: opts.need });
    if (!r) return null;
    return {
      mode: r.mode,
      truncated: r.truncated,
      hits: r.records.map((rec, i) => ({
        projectId: String(rec.fields?.projectId ?? ''),
        filename: String(rec.fields?.filename ?? ''),
        host: String(rec.fields?.host ?? ''),
        source: (rec.fields?.source === 'repo' ? 'repo' : 'live') as 'live' | 'repo',
        rank: i,
      })),
    };
  }

  /** Drop rows for memory files that no longer exist (same rationale as PromptIndex). */
  async pruneMissing(): Promise<number> {
    await this.init();
    let removed = 0;
    for (const filePath of Object.keys(this.state.files)) {
      if (fs.existsSync(filePath)) continue;
      const known = this.state.files[filePath];
      try { await this.backend.delete(MEMORY_DATASET, known.id); }
      catch { continue; }
      delete this.state.files[filePath];
      removed++;
    }
    if (removed > 0) { this.dirty = true; this.flushState(); }
    return removed;
  }

  hasContent(): boolean { return Object.keys(this.state.files).length > 0; }
  status(): { files: number } { return { files: Object.keys(this.state.files).length }; }
}

let instance: MemoryIndex | null = null;
export function getMemoryIndex(): MemoryIndex {
  if (!instance) instance = new MemoryIndex();
  return instance;
}
/** Tests only. */
export function resetMemoryIndex(next?: MemoryIndex | null): void { instance = next ?? null; }
