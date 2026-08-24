// core/src/search/prompt-index.ts
// SQLite FTS5 index over the USER PROMPTS of every session on this node — the
// preferred backing store for the `search` tool.
//
// WHY PROMPTS ONLY: assistant text and tool output are volume, not topic. Scoring a
// whole transcript ranks by how much was said, so a 14k-turn session outranks the
// 400-turn one that actually did the work. Prompts are where intent lives.
//
// WHY THE DATA SERVICE'S sql BACKEND: it already IS this — an external-content FTS5
// table kept in sync by triggers, in WAL, running in a worker thread so its blocking
// native calls never stall the main event loop. Standing up a second SQLite store
// beside it would duplicate all of that. We talk to the backend DIRECTLY rather than
// through DataService because `search` must work on a node where the operator has
// left dataServiceEnabled off — the service is an ACL/sync layer, not the storage.
// The dataset is still registered, so `data_query` reaches the same file when enabled.
import * as fs from 'fs';
import * as path from 'path';
import { SqlBackend } from '../data/backends/sql-backend';
import { getDatasetRegistry } from '../data/dataset-registry';
import { thisNodeId } from '../data/paths';
import { getDataDir } from '../utils/path-utils';
import type { DataRecord } from '../data/types';
import { classifyPromptForIndex } from './prompt-classifier';
import { tokenizeFts } from '../data/backends/fts-query';

export const PROMPT_DATASET = 'session-prompts';

/** Indexed as generated columns so project/scope filtering stays a real index seek. */
const INDEXED_FIELDS: Array<{ path: string; type: 'text' | 'number' }> = [
  { path: 'sessionId', type: 'text' },
  { path: 'project', type: 'text' },
  { path: 'host', type: 'text' },
  { path: 'ts', type: 'text' },
  { path: 'turnIndex', type: 'number' },
  { path: 'promptClass', type: 'text' },
  { path: 'synthetic', type: 'number' },
];

/**
 * Per-file position marker. Session jsonl is APPEND-ONLY, so re-indexing means
 * parsing from `bytes` to EOF — never the whole file. A full fleet rebuild is
 * thousands of files and transcripts up to 23k turns; it must never be on a
 * search's critical path.
 */
interface Watermark {
  bytes: number;    // byte offset already indexed
  mtimeMs: number;  // guards against a truncate/rewrite (offset then invalid)
  lines: number;    // line index reached, so turn numbering survives a restart
  prompts: number;  // real prompts contributed (for status reporting)
}

interface IndexState { version: number; files: Record<string, Watermark>; }

const STATE_VERSION = 1;

/** A single prompt hit, already resolved to its session. */
export interface PromptHit {
  id: string;
  sessionId: string;
  project: string;
  ts: string;
  turnIndex: number;
  promptClass: string;
  text: string;
}

export interface PromptSearchResult {
  /** 'and' = every term matched; 'or' = widened after AND found nothing. */
  mode: 'and' | 'or';
  hits: PromptHit[];
  /** Distinct sessions represented in `hits`. */
  sessions: Array<{ sessionId: string; project: string; ts: string; best: PromptHit; matches: number }>;
}

export class PromptIndex {
  private backend: SqlBackend;
  private state: IndexState = { version: STATE_VERSION, files: {} };
  private statePath: string;
  private ready = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(storeDirOverride?: string, statePathOverride?: string) {
    this.backend = new SqlBackend(storeDirOverride);
    this.statePath = statePathOverride || path.join(getDataDir(), 'prompt-index-state.json');
  }

  // ─── lifecycle ────────────────────────────────────────────────────────

  /** Register the dataset + open the store. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.ready) return;
    const registry = getDatasetRegistry();
    if (!registry.get(PROMPT_DATASET)) {
      registry.create({
        id: PROMPT_DATASET,
        backend: 'sql',
        title: 'Session user-prompt index (system)',
        visibility: 'local-only',
        system: true,
        // read-only THROUGH the data service: the indexer is the only writer, so a
        // data_put must not be able to inject rows the watermarks don't know about.
        readOnly: true,
        config: { kind: 'sql', indexedFields: INDEXED_FIELDS },
        acl: [{ principal: '*', actions: ['read', 'query'] }],
        syncMode: 'none',
      });
    }
    await this.backend.createDataset({
      id: PROMPT_DATASET,
      backend: 'sql',
      ownerNode: thisNodeId(),
      config: { kind: 'sql', indexedFields: INDEXED_FIELDS },
    } as any);
    this.loadState();
    this.ready = true;
  }

  private loadState(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as IndexState;
      // A version bump invalidates every watermark rather than mixing schemas —
      // stale offsets against a changed record shape would silently skip content.
      if (raw && raw.version === STATE_VERSION && raw.files) this.state = raw;
    } catch { /* first run — empty state */ }
  }

  /** Debounced: a busy session fires the watcher constantly; the state file must not. */
  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushState();
    }, 2000);
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
    } catch { /* best effort; a lost flush costs a re-scan, never correctness */ }
  }

  // ─── indexing ─────────────────────────────────────────────────────────

  /**
   * Index the UNREAD TAIL of one session file. Returns how many real prompts were added.
   *
   * The watermark is only trusted while the file has grown from the same base: if it
   * shrank, or mtime moved backwards, the offset could point mid-record, so the file is
   * re-read from the start. Append-only in practice, defensive in code.
   */
  async indexFile(filePath: string, opts: { sessionId?: string; project?: string } = {}): Promise<number> {
    await this.init();
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { return 0; }

    const key = filePath;
    const prev = this.state.files[key];
    const rewound = !prev || st.size < prev.bytes || st.mtimeMs < prev.mtimeMs;
    const from = rewound ? 0 : prev.bytes;
    if (!rewound && st.size === prev.bytes) return 0;    // nothing appended — the common case

    let chunk: string;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const len = st.size - from;
        if (len <= 0) return 0;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, from);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return 0; }

    // A trailing partial line (writer mid-append) must NOT be consumed: stop at the last
    // newline and leave the remainder for the next pass, or the record is lost forever.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return 0;
    const consumed = Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8');
    const lines = chunk.slice(0, lastNl).split('\n');

    const sessionId = opts.sessionId || path.basename(filePath, '.jsonl');
    let lineIndex = rewound ? 0 : prev.lines;
    let project = opts.project || '';
    let added = 0;
    const now = new Date().toISOString();
    const host = thisNodeId();

    for (const line of lines) {
      const at = lineIndex++;
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!project && msg.cwd) project = msg.cwd;
      if (msg.type !== 'user') continue;

      const content = msg.message?.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'text') text += b.text;
      } else if (typeof content === 'string') {
        text = content;
      }
      if (!text.trim()) continue;

      const c = classifyPromptForIndex(text, msg.isMeta);
      if (!c.indexText) continue;

      const rec: DataRecord = {
        id: `${sessionId}:${at}`,
        version: 1,
        fields: {
          sessionId,
          project,
          host,
          ts: msg.timestamp || '',
          turnIndex: at,
          promptClass: c.promptClass,
          // stored 0/1: SQLite has no boolean, and the generated column is compared numerically
          synthetic: c.synthetic ? 1 : 0,
        },
        // FTS indexes `text` only — this is the whole reason boilerplate is classified
        // rather than concatenated in.
        text: c.indexText.slice(0, 20000),
        createdAt: msg.timestamp || now,
        updatedAt: now,
      };
      try {
        await this.backend.put(PROMPT_DATASET, rec);
        if (!c.synthetic) added++;
      } catch { /* one bad row must not abort the file */ }
    }

    this.state.files[key] = {
      bytes: from + consumed,
      mtimeMs: st.mtimeMs,
      lines: lineIndex,
      prompts: (rewound ? 0 : prev.prompts) + added,
    };
    this.scheduleFlush();
    return added;
  }

  // ─── search ───────────────────────────────────────────────────────────

  /**
   * Rank prompts by bm25 and group them into sessions.
   *
   * AND first, OR only if AND found nothing: a distinctive multi-word query should
   * return the few sessions containing ALL its terms, not everything containing any
   * of them. Widening is reported to the caller so a loose result is never presented
   * as a precise one.
   */
  async search(query: string, opts: {
    project?: string;
    since?: string;
    limit?: number;
    includeSynthetic?: boolean;
  } = {}): Promise<PromptSearchResult | null> {
    await this.init();
    if (tokenizeFts(query).length === 0) return null;   // nothing searchable in the query

    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const base: any[] = [];
    if (opts.project) base.push({ field: 'project', op: 'eq', value: opts.project });
    if (opts.since) base.push({ field: 'ts', op: 'gte', value: opts.since });
    if (!opts.includeSynthetic) base.push({ field: 'synthetic', op: 'eq', value: 0 });

    for (const mode of ['and', 'or'] as const) {
      const r = await this.backend.query(PROMPT_DATASET, {
        filter: base, fts: query, ftsMode: mode, limit,
      });
      const recs = (r.records || []).filter((x) => x.deleted !== true);
      if (recs.length === 0) continue;
      const hits: PromptHit[] = recs.map((rec) => ({
        id: rec.id,
        sessionId: String(rec.fields?.sessionId ?? ''),
        project: String(rec.fields?.project ?? ''),
        ts: String(rec.fields?.ts ?? ''),
        turnIndex: Number(rec.fields?.turnIndex ?? 0),
        promptClass: String(rec.fields?.promptClass ?? 'user'),
        text: rec.text || '',
      }));
      // Records arrive in bm25 order, so a session's rank is its BEST prompt's rank —
      // first appearance wins. Counting matches per session as a tiebreak would let a
      // long session win on repetition again, which is the bug being fixed.
      const bySession = new Map<string, { sessionId: string; project: string; ts: string; best: PromptHit; matches: number }>();
      for (const h of hits) {
        const cur = bySession.get(h.sessionId);
        if (cur) { cur.matches++; continue; }
        bySession.set(h.sessionId, { sessionId: h.sessionId, project: h.project, ts: h.ts, best: h, matches: 1 });
      }
      return { mode, hits, sessions: [...bySession.values()] };
    }
    return { mode: 'and', hits: [], sessions: [] };
  }

  /** Indexed-corpus summary, for honest "why did you fall back" reporting. */
  status(): { files: number; prompts: number } {
    const files = Object.keys(this.state.files);
    let prompts = 0;
    for (const f of files) prompts += this.state.files[f].prompts || 0;
    return { files: files.length, prompts };
  }

  /** True once at least one file is indexed — i.e. the FTS path can answer at all. */
  hasContent(): boolean { return Object.keys(this.state.files).length > 0; }

  isIndexed(filePath: string): boolean { return !!this.state.files[filePath]; }
}

let instance: PromptIndex | null = null;
export function getPromptIndex(): PromptIndex {
  if (!instance) instance = new PromptIndex();
  return instance;
}
/** Tests only — drop the singleton so a fresh temp-dir instance can be installed. */
export function resetPromptIndex(next?: PromptIndex | null): void { instance = next ?? null; }
