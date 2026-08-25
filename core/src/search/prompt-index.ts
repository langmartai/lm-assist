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
import { thisNodeId, dataRoot } from '../data/paths';
import type { DataRecord } from '../data/types';
import { classifyPromptForIndex } from './prompt-classifier';
import { tokenizeFts } from '../data/backends/fts-query';

export const PROMPT_DATASET = 'session-prompts';

/**
 * Is this .jsonl a real SESSION transcript we should index?
 *
 * Subagent transcripts (`<session>/subagents/agent-*.jsonl`) are excluded. Their
 * user-channel messages are the ORCHESTRATOR's task prompt, not something a person
 * typed, so they are the very noise this index exists to keep out — and their filename
 * is not a session id, so a hit would hand the caller `detail("agent-a1ae09…")`, which
 * resolves to nothing.
 *
 * This predicate is shared by the backfill and the live watcher on purpose. They used to
 * disagree — the backfill only walked one level deep while the watcher (chokidar, depth 3)
 * happily fed it subagent files — so whether a session appeared in results depended on
 * whether it was indexed live or by backfill.
 */
export function isIndexableSessionFile(filePath: string): boolean {
  if (!filePath.endsWith('.jsonl')) return false;
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\\/g, '/');
  if (base.startsWith('agent-')) return false;
  return !/(^|[/\\])subagents[/\\]/.test(filePath);
}

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
  /**
   * True when the prompt-row scan hit its ceiling, so `sessions` is a PREFIX of the
   * matches, not all of them. Callers must render the count as "at least N" — a capped
   * result presented as a total is the same class of lie this whole feature replaced.
   */
  truncated: boolean;
  /** Prompt rows actually scanned, for the honest-reporting line. */
  scannedRows: number;
}

/** Hard ceiling on prompt rows pulled for one search. Bounds worst-case memory + time. */
const MAX_SCAN_ROWS = 5000;
/** Bytes read per pass. Bounds peak memory regardless of transcript size. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Widened window used when a single line exceeds READ_CHUNK_BYTES. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** Lines parsed between event-loop yields during a scan. */
const YIELD_EVERY_LINES = 500;
/** Per-prompt cap on indexed text. */
const MAX_INDEXED_TEXT = 20000;
/** Extra sessions hydrated beyond the caller's page, so a small page change needs no refetch. */
const HYDRATE_MARGIN = 10;
/** Upper bound on retained raw hits — diagnostics only; the renderer uses `sessions`. */
const HITS_KEPT = 200;

/** Hand the event loop back so a long scan cannot monopolise it. */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
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
    // dataRoot(), NOT getDataDir(): the sqlite store is dev/prod split ('data-dev' vs
    // 'data') but getDataDir() is not, so a shared state file would let the DEV Core's
    // watermarks convince the PROD Core that 6792 files were already indexed — into a
    // store that is actually empty. Prod would then index almost nothing, permanently,
    // and report a healthy-looking but near-empty index. The watermark must live beside
    // the store it describes.
    this.statePath = statePathOverride || path.join(dataRoot(), 'prompt-index-state.json');
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
    if (!isIndexableSessionFile(filePath)) return 0;
    let st: fs.Stats;
    try { st = fs.statSync(filePath); } catch { return 0; }

    const key = filePath;
    const prev = this.state.files[key];
    const rewound = !prev || st.size < prev.bytes || st.mtimeMs < prev.mtimeMs;
    const from = rewound ? 0 : prev.bytes;
    if (!rewound && st.size === prev.bytes) return 0;    // nothing appended — the common case

    const sessionId = opts.sessionId || path.basename(filePath, '.jsonl');
    let lineIndex = rewound ? 0 : prev.lines;
    let project = opts.project || '';
    let added = 0;
    let failed = false;
    const now = new Date().toISOString();
    const host = thisNodeId();

    // Walk the tail in BOUNDED chunks, yielding to the event loop as we go.
    //
    // Both halves of that are load-bearing, and both were measured. (1) Reading
    // `st.size - from` in one `allocUnsafe` is unbounded: on first boot `from` is 0, so a
    // multi-hundred-MB transcript would be allocated and decoded whole. (2) JSON.parse of
    // every line is synchronous main-thread work, and the only yield used to be
    // `await put()` — which fires ONLY for indexed prompts, while ~92% of files produce
    // none, so those parsed start-to-finish with nothing yielding at all. A single
    // 5.9MB / 12,747-line transcript held the loop for 191ms. That is the
    // core-event-loop-blocking failure class, and this runs at every Core boot.
    let pos = from;
    let sinceYield = 0;
    let fd: number;
    try { fd = fs.openSync(filePath, 'r'); } catch { return 0; }
    try {
      while (pos < st.size) {
        let want = Math.min(READ_CHUNK_BYTES, st.size - pos);
        let buf = Buffer.allocUnsafe(want);
        // allocUnsafe hands back UNINITIALISED memory, so only the bytes readSync
        // reports as read may be decoded — a short read would otherwise stringify
        // whatever happened to be on the heap.
        let got = fs.readSync(fd, buf, 0, want, pos);
        if (got <= 0) break;

        // The line boundary is found in RAW BYTES. Decoding first and re-encoding a slice
        // to measure it round-trips through UTF-8: an invalid byte becomes U+FFFD and
        // re-encodes to a DIFFERENT length, so the watermark would drift from the real
        // offset and every later read would start mid-record. 0x0A cannot occur inside a
        // multi-byte UTF-8 sequence, so scanning bytes is exact.
        let lastNl = buf.lastIndexOf(0x0a, got - 1);
        if (lastNl < 0) {
          // No complete line in this window. At EOF that is a partial trailing write —
          // leave it for the next pass. Otherwise one line is longer than the chunk.
          if (pos + got >= st.size) break;
          want = Math.min(MAX_LINE_BYTES, st.size - pos);
          buf = Buffer.allocUnsafe(want);
          got = fs.readSync(fd, buf, 0, want, pos);
          lastNl = got > 0 ? buf.lastIndexOf(0x0a, got - 1) : -1;
          // A single line beyond MAX_LINE_BYTES would otherwise stall this file forever.
          if (lastNl < 0) { pos += got; continue; }
        }

        const lines = buf.toString('utf8', 0, lastNl).split('\n');
        pos += lastNl + 1;

        for (const line of lines) {
          const at = lineIndex++;
          if (++sinceYield >= YIELD_EVERY_LINES) { sinceYield = 0; await yieldToLoop(); }
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
            // FTS indexes `text` only — this is the whole reason boilerplate is
            // classified rather than concatenated in.
            text: c.indexText.slice(0, MAX_INDEXED_TEXT),
            createdAt: msg.timestamp || now,
            updatedAt: now,
          };
          try {
            await this.backend.put(PROMPT_DATASET, rec);
            if (!c.synthetic) added++;
          } catch {
            // One bad row must not abort the file — but it must not be silently skipped
            // FOREVER either. Advancing the watermark past a row that never persisted
            // loses it with no repair path short of a full rebuild. Record ids are
            // deterministic (`sessionId:lineIndex`) and put() is an upsert, so re-reading
            // this tail next pass is idempotent: the safe move is not to advance.
            failed = true;
          }
        }
        await yieldToLoop();
      }
    } catch {
      return added;
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    const consumed = pos - from;

    if (failed) {
      // Leave the watermark where it was; the next event re-reads this tail.
      this.scheduleFlush();
      return added;
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
    /** How many distinct SESSIONS the caller needs (offset + page size). Drives the row budget. */
    need?: number;
    /** Explicit prompt-ROW budget, honoured exactly. Omit to derive it from `need`. */
    limit?: number;
    includeSynthetic?: boolean;
  } = {}): Promise<PromptSearchResult | null> {
    await this.init();
    if (tokenizeFts(query).length === 0) return null;   // nothing searchable in the query

    // Rows are PROMPTS; results are SESSIONS, and one session can own many matching
    // prompts. A fixed row budget therefore silently truncates the session list: measured
    // on this node, "session" yielded 114 sessions at 200 rows and 171 at 1000. The budget
    // escalates until the rows are exhausted (=> the count is exact) or the ceiling is hit
    // (=> the count is reported as a floor).
    const need = Math.max(opts.need ?? 1, 1);
    // An explicit row budget is honoured EXACTLY (a floor would make the option a lie);
    // the default scales with the page being asked for, with 200 as a sane minimum.
    const startRows = Math.min(Math.max(opts.limit ?? Math.max(need * 10, 200), 1), MAX_SCAN_ROWS);
    const base: any[] = [];
    if (opts.project) base.push({ field: 'project', op: 'eq', value: opts.project });
    if (opts.since) base.push({ field: 'ts', op: 'gte', value: opts.since });
    if (!opts.includeSynthetic) base.push({ field: 'synthetic', op: 'eq', value: 0 });

    for (const mode of ['and', 'or'] as const) {
      let rows = startRows;
      let recs: DataRecord[] = [];
      let exhausted = false;
      for (;;) {
        const r = await this.backend.query(PROMPT_DATASET, {
          filter: base, fts: query, ftsMode: mode, limit: rows,
          // The ranking pass needs ids and fields, never the documents. Carrying `text`
          // shipped the full matched corpus across the worker boundary — measured at
          // 23.7MB for one broad query at the row ceiling — for a renderer that shows at
          // most a couple of dozen 220-char snippets. `total` is never read here either,
          // and computing it costs a second COUNT scan on every escalation step.
          omitText: true, countTotal: false,
        });
        recs = (r.records || []).filter((x) => x.deleted !== true);
        // Fewer rows back than asked for ⇒ we have every match; the count is exact.
        exhausted = (r.records || []).length < rows;
        if (exhausted || rows >= MAX_SCAN_ROWS) break;
        if (countSessions(recs) > need) break;   // enough to satisfy this page
        rows = Math.min(rows * 2, MAX_SCAN_ROWS);
      }
      if (recs.length === 0) continue;
      const hits: PromptHit[] = recs.map((rec) => ({
        id: rec.id,
        sessionId: String(rec.fields?.sessionId ?? ''),
        project: String(rec.fields?.project ?? ''),
        ts: String(rec.fields?.ts ?? ''),
        turnIndex: Number(rec.fields?.turnIndex ?? 0),
        promptClass: String(rec.fields?.promptClass ?? 'user'),
        text: '',   // hydrated below, for the rendered page only
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
      const sessions = [...bySession.values()];
      // Fetch the matching prompt's text ONLY for the sessions that will be rendered —
      // a bounded handful of point reads instead of streaming every matched document.
      for (const s of sessions.slice(0, Math.min(need + HYDRATE_MARGIN, sessions.length))) {
        try {
          const full = await this.backend.get(PROMPT_DATASET, s.best.id);
          if (full?.text) s.best.text = full.text;
        } catch { /* snippet is presentation only — a miss must not fail the search */ }
      }
      return {
        mode,
        // Bounded: the caller renders sessions, and retaining every matched row here is
        // what made a broad query hold the whole result set in memory.
        hits: hits.slice(0, HITS_KEPT),
        sessions,
        truncated: !exhausted,
        scannedRows: recs.length,
      };
    }
    return { mode: 'and', hits: [], sessions: [], truncated: false, scannedRows: 0 };
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

/** Distinct sessions among a record page — used to size the row budget. */
function countSessions(recs: DataRecord[]): number {
  const seen = new Set<string>();
  for (const r of recs) seen.add(String(r.fields?.sessionId ?? ''));
  return seen.size;
}

let instance: PromptIndex | null = null;
export function getPromptIndex(): PromptIndex {
  if (!instance) instance = new PromptIndex();
  return instance;
}
/** Tests only — drop the singleton so a fresh temp-dir instance can be installed. */
export function resetPromptIndex(next?: PromptIndex | null): void { instance = next ?? null; }
