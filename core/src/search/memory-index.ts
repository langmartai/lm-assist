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
import { getProjectsDir } from '../utils/path-utils';
import type { DataRecord } from '../data/types';
import { rankedFtsSearch } from './fts-rank';

export const MEMORY_DATASET = 'memory-files';

const INDEXED_FIELDS: Array<{ path: string; type: 'text' | 'number' }> = [
  { path: 'projectId', type: 'text' },
  { path: 'filename', type: 'text' },
  { path: 'host', type: 'text' },
  { path: 'mtimeMs', type: 'number' },
];

/** Per-prompt-file cap on indexed text. Memory files are small; this is a backstop. */
const MAX_INDEXED_TEXT = 40000;

interface Watermark { mtimeMs: number; size: number }
interface IndexState { version: number; files: Record<string, Watermark>; }
const STATE_VERSION = 1;

export interface MemoryHit {
  projectId: string;
  filename: string;
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
  private state: IndexState = { version: STATE_VERSION, files: {} };
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
      if (raw && raw.version === STATE_VERSION && raw.files) this.state = raw;
    } catch { /* first run */ }
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

  /** `~/.claude/projects/<encoded>/memory/*.md` — the live, authoritative local set. */
  private listMemoryFiles(): Array<{ file: string; projectId: string }> {
    const root = getProjectsDir();
    const out: Array<{ file: string; projectId: string }> = [];
    let dirs: string[];
    try { dirs = fs.readdirSync(root); } catch { return out; }
    for (const d of dirs) {
      const mem = path.join(root, d, 'memory');
      try {
        if (!fs.statSync(mem).isDirectory()) continue;
        for (const f of fs.readdirSync(mem)) {
          if (f.endsWith('.md')) out.push({ file: path.join(mem, f), projectId: d });
        }
      } catch { /* no memory dir for this project */ }
    }
    return out;
  }

  /**
   * Index one memory file if it changed. Unlike session transcripts these are REWRITTEN
   * in place rather than appended, so the watermark is (mtime, size) and the whole file
   * is re-read — there is no meaningful tail.
   */
  async indexFile(filePath: string, projectId: string): Promise<boolean> {
    await this.init();
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { return false; }
    const prev = this.state.files[filePath];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return false;

    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
    const filename = path.basename(filePath);
    const rec: DataRecord = {
      id: `${projectId}::${filename}`,
      version: 1,
      fields: { projectId, filename, host: thisNodeId(), mtimeMs: st.mtimeMs },
      // Whole file: memory files ARE the topical signal — unlike a transcript there is
      // no assistant chatter or tool output to exclude.
      text: `${filename}\n${raw}`.slice(0, MAX_INDEXED_TEXT),
      createdAt: new Date(st.mtimeMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.backend.put(MEMORY_DATASET, rec);
    } catch {
      return false;   // watermark not advanced — the next pass retries this file
    }
    this.state.files[filePath] = { mtimeMs: st.mtimeMs, size: st.size };
    this.scheduleFlush();
    return true;
  }

  /** Index everything changed. Cheap: a few hundred small files, stat-gated. */
  async refresh(): Promise<number> {
    await this.init();
    let n = 0;
    for (const { file, projectId } of this.listMemoryFiles()) {
      try { if (await this.indexFile(file, projectId)) n++; } catch { /* skip one bad file */ }
    }
    this.flushState();
    return n;
  }

  /**
   * Ranked filenames for a query, best first. Null means the query had no indexable
   * terms — "cannot search", not "matched nothing".
   */
  async search(query: string, opts: { projectId?: string; need?: number } = {}): Promise<MemorySearchResult | null> {
    await this.init();
    const filter: any[] = [];
    if (opts.projectId) filter.push({ field: 'projectId', op: 'eq', value: opts.projectId });
    const r = await rankedFtsSearch(this.backend, MEMORY_DATASET, query, { filter, need: opts.need });
    if (!r) return null;
    return {
      mode: r.mode,
      truncated: r.truncated,
      hits: r.records.map((rec, i) => ({
        projectId: String(rec.fields?.projectId ?? ''),
        filename: String(rec.fields?.filename ?? ''),
        rank: i,
      })),
    };
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
