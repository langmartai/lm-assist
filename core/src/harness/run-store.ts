/**
 * The harness run index — an event-sourced JSONL file of every recorded run.
 *
 * Why event-sourced rather than one JSON file per run: a run is written 5-7
 * times (start, resolved, spawned, first output, abort, settle, enrichment) and
 * each write must be cheap, synchronous and unable to break the run it
 * describes. An append of one small line is all three. `start` sets a record,
 * `patch` merges into it, and the reader folds the file into a Map, reading only
 * the bytes appended since the last read. Compaction folds the history back down
 * to one `start` line per record (house precedent: file-transfer/job-store.ts).
 *
 * 🔴 NOTHING HERE MAY THROW INTO A RUN. A read-only data dir, a full disk or a
 * torn line costs the record, never the run: every write is try/catch'd and a
 * failure is logged once per class, by run id only — never content, which may
 * hold a prompt.
 *
 * Status is stored as `running` until the run settles, and the SERVED value is
 * derived (deriveStatus): a record whose owning Core died cannot have written its
 * own end, so "running" on disk is only believed while that Core is provably the
 * same process — pid AND start ticks, because a pid alone is reused.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDevRepo } from '../utils/path-utils';
import { harnessRunsRoot, resolveRecordRunDir, runIndexFile } from './run-paths';
import {
  RUN_LIMITS,
  type HarnessRunRecord,
  type HarnessRunRow,
  type HarnessRunStatus,
  type HarnessRunnerSummary,
  type RunIndexLine,
} from './run-types';
import type { TranscriptSourceRef } from './transcript';
import { sweepStaleOpencodeConfigs } from './opencode';

type MetaLine = Extract<RunIndexLine, { op: 'meta' }>;

interface FoldState {
  file: string;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes consumed so far — always just past a '\n', so a torn tail is re-read. */
  byteOffset: number;
  lines: number;
  records: Map<string, HarnessRunRecord>;
  meta: MetaLine | null;
}

let fold: FoldState | null = null;

const emptyFold = (file: string, ino = -1): FoldState => ({
  file, ino, size: 0, mtimeMs: 0, byteOffset: 0, lines: 0, records: new Map(), meta: null,
});

// ── failure logging ─────────────────────────────────────────────────────────

const loggedClasses = new Set<string>();

/**
 * Log a store failure ONCE per class. Only the run id and the error code: an
 * error message can quote a path, and nothing here may echo a prompt.
 */
export function logRunStoreFailure(cls: string, id: string | undefined, err: unknown): void {
  if (loggedClasses.has(cls)) return;
  loggedClasses.add(cls);
  const code = (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : typeof err);
  console.warn(`[harness-runs] ${cls} failed${id ? ` (run ${id})` : ''}: ${code}`);
}

// ── read path ───────────────────────────────────────────────────────────────

function applyLine(state: FoldState, line: RunIndexLine): void {
  switch (line.op) {
    case 'start':
      if (line.rec && typeof line.rec.id === 'string') state.records.set(line.rec.id, { ...line.rec });
      break;
    case 'patch': {
      const rec = typeof line.id === 'string' ? state.records.get(line.id) : undefined;
      if (rec && line.patch && typeof line.patch === 'object') Object.assign(rec, line.patch);
      break;
    }
    case 'meta':
      state.meta = line;
      break;
  }
}

/**
 * Fold the index, reading only what was appended since the last call.
 *
 * A shrunk file or a new inode means compaction replaced it, so the fold starts
 * over. A last line with no '\n' is a write still in progress (or torn by a
 * crash) and is left for the next read rather than parsed half-written.
 */
function readIndex(): FoldState {
  const file = runIndexFile();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    fold = emptyFold(file);
    return fold;
  }
  if (!fold || fold.file !== file || fold.ino !== st.ino || st.size < fold.byteOffset) {
    fold = emptyFold(file, st.ino);
  }
  if (st.size === fold.size && st.mtimeMs === fold.mtimeMs) return fold;

  if (st.size > fold.byteOffset) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const want = st.size - fold.byteOffset;
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, fold.byteOffset + got);
        if (n <= 0) break;
        got += n;
      }
      // Split on the '\n' BYTE: it never occurs inside a multi-byte UTF-8
      // sequence, so a chunk boundary cannot corrupt a character.
      const lastNl = buf.subarray(0, got).lastIndexOf(0x0a);
      if (lastNl >= 0) {
        for (const raw of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
          if (!raw) continue;
          fold.lines += 1;
          let line: RunIndexLine;
          try {
            line = JSON.parse(raw);
          } catch {
            continue;
          }
          if (line && typeof line === 'object') applyLine(fold, line);
        }
        fold.byteOffset += lastNl + 1;
      }
    } catch (err) {
      logRunStoreFailure('read', undefined, err);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing to do */ }
    }
  }
  fold.size = st.size;
  fold.mtimeMs = st.mtimeMs;
  return fold;
}

// ── write path ──────────────────────────────────────────────────────────────

const chmodded = new Set<string>();

function appendLine(line: RunIndexLine, id?: string): boolean {
  const file = runIndexFile();
  try {
    // A torn tail (a crash mid-append) would swallow this line into it and lose
    // both; starting on a fresh line keeps the damage to the torn one.
    const state = readIndex();
    const torn = state.size > state.byteOffset;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${torn ? '\n' : ''}${JSON.stringify(line)}\n`, { encoding: 'utf-8', mode: 0o600 });
    if (!chmodded.has(file)) {
      chmodded.add(file);
      try { fs.chmodSync(file, 0o600); } catch { /* a non-POSIX filesystem cannot honour it */ }
    }
    return true;
  } catch (err) {
    logRunStoreFailure(`append-${line.op}`, id, err);
    return false;
  }
}

export function startRun(rec: HarnessRunRecord): boolean {
  return appendLine({ op: 'start', at: Date.now(), rec }, rec.id);
}

/** Merge fields into a known record. A patch for an id with no start is dropped, not written. */
export function patchRun(id: string, patch: Partial<HarnessRunRecord>): boolean {
  try {
    if (!readIndex().records.has(id)) return false;
  } catch {
    return false;
  }
  const at = Date.now();
  return appendLine({ op: 'patch', at, id, patch: { ...patch, updatedAt: at } }, id);
}

export function writeBackfillMeta(backfill: MetaLine['backfill']): boolean {
  return appendLine({ op: 'meta', at: Date.now(), backfill });
}

// ── lookups (copies — the fold is never handed out to be mutated) ──────────

export function getRun(id: string): HarnessRunRecord | undefined {
  const rec = readIndex().records.get(id);
  return rec ? { ...rec } : undefined;
}

export function hasRun(id: string): boolean {
  return readIndex().records.has(id);
}

export const findRun = getRun;

/** The newest record carrying this harness session id. */
export function findRunBySessionId(sessionId: string): HarnessRunRecord | undefined {
  if (!sessionId) return undefined;
  let best: HarnessRunRecord | undefined;
  for (const rec of readIndex().records.values()) {
    if (rec.sessionId === sessionId && (!best || rec.startedAt > best.startedAt)) best = rec;
  }
  return best ? { ...best } : undefined;
}

export function allRuns(): HarnessRunRecord[] {
  return [...readIndex().records.values()].map((r) => ({ ...r }));
}

export function getBackfillMeta(): MetaLine | null {
  return readIndex().meta;
}

/**
 * Fold ANOTHER index file (the other mode's) read-only, without touching this
 * Core's fold. Bounded: a file over 64 MB is not read. Never throws.
 */
export function foldIndexFileReadOnly(file: string): HarnessRunRecord[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return [];
    const state = emptyFold(file, st.ino);
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as RunIndexLine;
        if (line && typeof line === 'object') applyLine(state, line);
      } catch { /* a torn line costs only itself */ }
    }
    return [...state.records.values()];
  } catch {
    return [];
  }
}

/** Lines and records in the folded index — for compaction thresholds and tests. */
export function indexStats(): { lines: number; records: number; bytes: number } {
  const s = readIndex();
  return { lines: s.lines, records: s.records.size, bytes: s.size };
}

// ── in-flight + liveness ────────────────────────────────────────────────────

const inFlight = new Set<string>();

export function markInFlight(id: string): void { inFlight.add(id); }
export function clearInFlight(id: string): void { inFlight.delete(id); }
export function isRunInFlight(id: string): boolean { return inFlight.has(id); }

/**
 * Field 22 of /proc/<pid>/stat: the process start time in clock ticks since
 * boot. Linux only. comm (field 2) may contain spaces and ')', so fields are
 * counted from the LAST ')'.
 */
export function readStartTicks(pid: number): number | undefined {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const v = Number(stat.slice(close + 2).split(' ')[19]);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

let selfTicks: number | undefined | null = null;
export function selfStartTicks(): number | undefined {
  if (selfTicks === null) selfTicks = readStartTicks(process.pid);
  return selfTicks;
}

const PID_CACHE_MS = 5000;
const aliveCache = new Map<string, { at: number; alive: boolean }>();

/**
 * Is `pid` still the process that wrote the record?
 *
 * On Linux the start ticks must match too — a dead Core's pid is eventually
 * reused, and "some process has that pid" would otherwise keep a dead run
 * "running" forever. Elsewhere only existence can be checked (signal 0 delivers
 * nothing). Cached 5 s: the list view derives this for every row.
 */
export function pidAlive(pid: number | null | undefined, startTicks?: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  const key = `${pid}:${startTicks ?? ''}`;
  const now = Date.now();
  const hit = aliveCache.get(key);
  if (hit && now - hit.at < PID_CACHE_MS) return hit.alive;

  let alive: boolean;
  if (process.platform === 'linux') {
    const ticks = readStartTicks(pid);
    alive = ticks !== undefined && (startTicks === undefined || ticks === startTicks);
  } else {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      alive = (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }
  if (aliveCache.size > 256) aliveCache.clear();
  aliveCache.set(key, { at: now, alive });
  return alive;
}

export interface DerivedStatus { status: HarnessRunStatus; live: boolean }

/**
 * The status to SERVE for a record (§3.4).
 *
 * Only an unended recorded run needs deriving. If this very process owns it, the
 * in-flight set is authoritative (not in flight and no end = the end write was
 * lost). If another process owns it, the run is believed only while that Core is
 * alive with the same start ticks.
 */
export function deriveStatus(rec: HarnessRunRecord): DerivedStatus {
  if (rec.origin !== 'recorded' || rec.status !== 'running' || rec.endedAt != null) {
    return { status: rec.status === 'running' ? 'unknown' : rec.status, live: false };
  }
  const owner = rec.corePid === process.pid
    && (rec.coreStartTicks === undefined || rec.coreStartTicks === selfStartTicks());
  const running = owner ? inFlight.has(rec.id) : pidAlive(rec.corePid, rec.coreStartTicks);
  return running ? { status: 'running', live: true } : { status: 'interrupted', live: false };
}

let bootTime: number | undefined | null = null;
function bootTimeMs(): number | undefined {
  if (bootTime !== null) return bootTime;
  bootTime = undefined;
  try {
    const m = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    if (m) bootTime = Number(m[1]) * 1000;
  } catch { /* not Linux */ }
  return bootTime;
}

/** USER_HZ. The kernel ABI fixes it at 100 on every architecture Node runs on. */
const CLK_TCK = 100;

/**
 * Whether an interrupted run's CHILD may still be running. REPORT ONLY.
 *
 * 🔴 Nothing may signal this pid: it was read from disk, and after a Core
 * restart it can belong to anything. The record keeps no child start ticks, so
 * identity is checked by start TIME instead — the process holding the pid must
 * have started within a few seconds of the recorded spawn.
 */
export function childAliveOf(rec: HarnessRunRecord): boolean | 'unknown' {
  const pid = rec.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (process.platform === 'linux') {
    const ticks = readStartTicks(pid);
    if (ticks === undefined) return false;
    const boot = bootTimeMs();
    if (boot === undefined) return 'unknown';
    const startedAt = boot + (ticks * 1000) / CLK_TCK;
    return Math.abs(startedAt - (rec.spawnedAt ?? rec.startedAt)) <= 5000;
  }
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM' ? 'unknown' : false;
  }
}

// ── transcript locator ──────────────────────────────────────────────────────

function regularFile(p: string): string | null {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() ? p : null;
  } catch {
    return null;
  }
}

/** Build the transcript layer's source ref from a record. Paths are absolute and validated here. */
export function sourceRefFor(rec: HarnessRunRecord, live: boolean): TranscriptSourceRef {
  const runDir = resolveRecordRunDir(rec);
  return {
    runner: rec.runner,
    runDir,
    capturePath: runDir ? regularFile(path.join(runDir, 'stdout.log')) : null,
    promptPath: runDir ? regularFile(path.join(runDir, 'prompt.txt')) : null,
    sessionId: rec.sessionId ?? null,
    opencodeDbPath: rec.native?.kind === 'opencode-db' ? rec.native.dbPath ?? null : null,
    live,
    startedAt: rec.startedAt,
  };
}

// ── listing + per-runner stats ──────────────────────────────────────────────

export const RUNNER_DISPLAY_NAMES: Record<string, string> = {
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  sdk: 'Claude SDK',
  tmux: 'Claude tmux',
};

const defaultDisplayName = (id: string): string => RUNNER_DISPLAY_NAMES[id] ?? id;

export function toRow(
  rec: HarnessRunRecord,
  d: DerivedStatus = deriveStatus(rec),
  displayName: (id: string) => string = defaultDisplayName,
): HarnessRunRow {
  const hasTranscript = d.live
    || (rec.capture?.bytes ?? 0) > 0
    || (Boolean(rec.native) && rec.status !== 'not_started' && rec.status !== 'refused');
  return {
    id: rec.id,
    executionId: rec.executionId,
    runner: rec.runner,
    runnerDisplayName: displayName(rec.runner),
    origin: rec.origin,
    inferred: rec.inferred,
    status: d.status,
    termination: rec.termination,
    background: rec.background,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    promptPreview: (rec.promptPreview ?? '').slice(0, RUN_LIMITS.rowPromptChars),
    cwd: rec.cwd,
    cwdDefaulted: rec.cwdDefaulted,
    model: rec.model,
    providerProfile: rec.providerProfile,
    sessionId: rec.sessionId,
    numTurns: rec.numTurns,
    toolCalls: rec.toolCalls,
    toolErrors: rec.toolErrors,
    usage: rec.usage,
    errorPreview: rec.error ? rec.error.slice(0, RUN_LIMITS.errorPreviewChars) : undefined,
    live: d.live,
    hasTranscript,
  };
}

export interface RunListQuery {
  runner?: string;
  statuses?: HarnessRunStatus[];
  q?: string;
  since?: number;
  includeBackfill?: boolean;
  limit?: number;
  offset?: number;
  displayName?: (id: string) => string;
}

export interface RunListResult {
  runs: HarnessRunRow[];
  counts: {
    shown: number;
    matched: number;
    total: number;
    running: number;
    byRunner: Record<string, number>;
    byStatus: Partial<Record<HarnessRunStatus, number>>;
  };
  nextOffset: number | null;
}

const clampInt = (v: number, min: number, max: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : min;

/**
 * Filtered, paged rows, newest first.
 *
 * `byRunner` and `byStatus` are FACET counts: each is taken over every filter
 * except its own, so a tab or a chip shows how many rows selecting it would give
 * under the current search — not a total that ignores the search, and not zero
 * for every tab but the selected one.
 */
export function listRuns(query: RunListQuery = {}): RunListResult {
  const limit = clampInt(query.limit ?? RUN_LIMITS.listDefault, 1, RUN_LIMITS.listMax);
  const offset = clampInt(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const q = (query.q ?? '').trim().toLowerCase().slice(0, 100);
  const statuses = query.statuses?.length ? new Set(query.statuses) : null;

  const all = [...readIndex().records.values()].map((rec) => ({ rec, d: deriveStatus(rec) }));
  const passes = (x: { rec: HarnessRunRecord; d: DerivedStatus }, skip: 'runner' | 'status' | null): boolean => {
    if (query.includeBackfill === false && x.rec.origin === 'backfill') return false;
    if (skip !== 'runner' && query.runner && x.rec.runner !== query.runner) return false;
    if (skip !== 'status' && statuses && !statuses.has(x.d.status)) return false;
    if (query.since !== undefined && x.rec.startedAt < query.since) return false;
    if (q) {
      const hay = [x.rec.promptPreview, x.rec.cwd, x.rec.model, x.rec.sessionId, x.rec.id];
      if (!hay.some((f) => typeof f === 'string' && f.toLowerCase().includes(q))) return false;
    }
    return true;
  };

  const matched = all
    .filter((x) => passes(x, null))
    .sort((a, b) => b.rec.startedAt - a.rec.startedAt || (a.rec.id < b.rec.id ? 1 : -1));

  const byRunner: Record<string, number> = {};
  for (const x of all) if (passes(x, 'runner')) byRunner[x.rec.runner] = (byRunner[x.rec.runner] ?? 0) + 1;
  const byStatus: Partial<Record<HarnessRunStatus, number>> = {};
  for (const x of all) if (passes(x, 'status')) byStatus[x.d.status] = (byStatus[x.d.status] ?? 0) + 1;

  const page = matched.slice(offset, offset + limit);
  return {
    runs: page.map((x) => toRow(x.rec, x.d, query.displayName)),
    counts: {
      shown: page.length,
      matched: matched.length,
      total: all.length,
      running: all.filter((x) => x.d.live).length,
      byRunner,
      byStatus,
    },
    nextOffset: offset + limit < matched.length ? offset + limit : null,
  };
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Outcomes that count toward a success rate. refused/not_started/unknown never ran a model. */
const RATED: ReadonlySet<HarnessRunStatus> = new Set<HarnessRunStatus>([
  'succeeded', 'failed', 'timed_out', 'aborted', 'launch_failed', 'interrupted',
]);
const FAILURES: ReadonlySet<HarnessRunStatus> = new Set<HarnessRunStatus>([
  'failed', 'timed_out', 'launch_failed', 'interrupted', 'refused',
]);

const topN = <K extends string>(counts: Map<string, number>, n: number, key: K) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([name, count]) => ({ [key]: name, count }) as Record<K, string> & { count: number });

/** Per-runner stats over a window of `windowDays` (by startedAt). */
export function summarizeRunner(
  runner: string,
  windowDays: number,
  now: number = Date.now(),
): NonNullable<HarnessRunnerSummary['stats']> {
  const since = now - windowDays * 24 * 3600 * 1000;
  const rows = [...readIndex().records.values()]
    .filter((r) => r.runner === runner && r.startedAt >= since)
    .map((rec) => ({ rec, d: deriveStatus(rec) }))
    .sort((a, b) => b.rec.startedAt - a.rec.startedAt);

  const byStatus: Partial<Record<HarnessRunStatus, number>> = {};
  const durations: number[] = [];
  const tools = new Map<string, number>();
  const models = new Map<string, number>();
  const profiles = new Map<string, number>();
  const tokens = { input: 0, output: 0, reasoning: 0, reportedRuns: 0 };
  let toolCalls = 0;
  let toolErrors = 0;
  let rated = 0;

  for (const { rec, d } of rows) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    if (RATED.has(d.status)) rated += 1;
    if (!d.live && typeof rec.durationMs === 'number' && rec.durationMs >= 0) durations.push(rec.durationMs);
    if (rec.usage?.reported) {
      tokens.reportedRuns += 1;
      tokens.input += rec.usage.inputTokens;
      tokens.output += rec.usage.outputTokens;
    }
    if (typeof rec.usage?.reasoningTokens === 'number') tokens.reasoning += rec.usage.reasoningTokens;
    toolCalls += rec.toolCalls ?? 0;
    toolErrors += rec.toolErrors ?? 0;
    for (const [name, n] of Object.entries(rec.toolsByName ?? {})) tools.set(name, (tools.get(name) ?? 0) + n);
    if (rec.model) models.set(rec.model, (models.get(rec.model) ?? 0) + 1);
    if (rec.providerProfile) profiles.set(rec.providerProfile, (profiles.get(rec.providerProfile) ?? 0) + 1);
  }
  durations.sort((a, b) => a - b);

  return {
    windowDays,
    total: rows.length,
    running: rows.filter((x) => x.d.live).length,
    byStatus,
    successRate: rated ? (byStatus.succeeded ?? 0) / rated : null,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    lastRunAt: rows.length ? rows[0].rec.startedAt : null,
    ...(rows.length ? { lastStatus: rows[0].d.status } : {}),
    tokens,
    toolCalls,
    toolErrors,
    topTools: topN(tools, 8, 'name'),
    models: topN(models, 50, 'model'),
    profiles: topN(profiles, 50, 'name'),
    recentFailures: rows
      .filter((x) => FAILURES.has(x.d.status))
      .slice(0, 5)
      .map((x) => ({
        id: x.rec.id,
        at: x.rec.endedAt ?? x.rec.startedAt,
        status: x.d.status,
        error: (x.rec.error ?? x.d.status).slice(0, 160),
      })),
  };
}

// ── compaction, retention, boot ─────────────────────────────────────────────

/** The index's size right after its last compaction (or when last seen fully folded). */
let lastCompacted: { file: string; bytes: number } | null = null;

/**
 * Rewrite the index as one `start` line per (kept) record plus the meta line:
 * tmp → rename → chmod, so a crash leaves either the old file or the new one.
 * Synchronous from read to rename, so no append of this process can land in
 * between and be lost.
 */
export function compactIndex(keep?: (rec: HarnessRunRecord) => boolean): boolean {
  const file = runIndexFile();
  const state = readIndex();
  if (state.ino === -1) return false;
  const out: string[] = [];
  for (const rec of state.records.values()) {
    if (!keep || keep(rec)) out.push(JSON.stringify({ op: 'start', at: rec.updatedAt ?? rec.startedAt, rec }));
  }
  if (state.meta) out.push(JSON.stringify(state.meta));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const content = out.length ? `${out.join('\n')}\n` : '';
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    fold = null;
    lastCompacted = { file, bytes: Buffer.byteLength(content) };
    return true;
  } catch (err) {
    logRunStoreFailure('compact', undefined, err);
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Compact when the file has grown well past its folded size.
 *
 * "Has foldable history" is not enough for the size rule: the recorder calls this
 * after every run, and the run that just finished ALWAYS has unfolded lines (its
 * start plus its patches). 500 records with full previews can legitimately exceed
 * 2 MB, so past that a bare `lines > folded` check rewrote the whole index after
 * every run, synchronously, on the response path. The size rule therefore waits
 * for the file to DOUBLE since its last compaction — amortized O(1) per run.
 */
export function maybeCompact(): boolean {
  const s = readIndex();
  const folded = s.records.size + (s.meta ? 1 : 0);
  // A freshly folded file (after a restart, or a compaction by another process)
  // is its own baseline.
  if (s.lines === folded) lastCompacted = { file: s.file, bytes: s.size };
  const base = lastCompacted?.file === s.file ? lastCompacted.bytes : 0;
  const sizeRule = s.size > Math.max(RUN_LIMITS.indexCompactBytes, 2 * base) && s.lines > folded;
  if (sizeRule || s.lines > Math.max(5000, 4 * s.records.size)) {
    return compactIndex();
  }
  return false;
}

/** LM_HARNESS_RUN_RETENTION_DAYS; 0 keeps everything. A malformed value falls back to the default. */
export function retentionDays(): number {
  const raw = process.env.LM_HARNESS_RUN_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return RUN_LIMITS.retentionDays;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : RUN_LIMITS.retentionDays;
}

/**
 * Drop terminal records older than the retention window, then all but the
 * newest N. Running records are never dropped.
 *
 * A dropped record's run dir is deleted ONLY when this Core recorded it (origin
 * `recorded`, same mode) and it resolves to a direct child of this Core's own
 * root. Legacy dirs, the other mode's dirs and anything a locator points outside
 * the root are never touched; OpenCode's DB is never ours to prune.
 */
export function applyRetention(opts: { now?: number; days?: number; maxRuns?: number } = {}): { dropped: string[]; dirsRemoved: number } {
  const days = opts.days ?? retentionDays();
  if (days <= 0) return { dropped: [], dirsRemoved: 0 };
  const now = opts.now ?? Date.now();
  const maxRuns = opts.maxRuns ?? RUN_LIMITS.retentionMaxRuns;

  const recs = [...readIndex().records.values()].map((r) => ({ ...r }));
  const terminal = recs.filter((r) => deriveStatus(r).status !== 'running');
  const ts = (r: HarnessRunRecord) => r.endedAt ?? r.startedAt;
  const drop = new Set<string>();
  const cutoff = now - days * 24 * 3600 * 1000;
  for (const r of terminal) if (ts(r) < cutoff) drop.add(r.id);
  const kept = terminal.filter((r) => !drop.has(r.id)).sort((a, b) => ts(b) - ts(a));
  for (const r of kept.slice(maxRuns)) drop.add(r.id);
  if (!drop.size) return { dropped: [], dirsRemoved: 0 };

  if (!compactIndex((r) => !drop.has(r.id))) return { dropped: [], dirsRemoved: 0 };

  const mode = isDevRepo() ? 'dev' : 'prod';
  const root = path.resolve(harnessRunsRoot());
  let dirsRemoved = 0;
  for (const r of recs) {
    if (!drop.has(r.id) || r.origin !== 'recorded' || r.core !== mode) continue;
    const abs = resolveRecordRunDir(r);
    if (!abs || path.dirname(abs) !== root) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      dirsRemoved += 1;
    } catch (err) {
      logRunStoreFailure('retention-rm', r.id, err);
    }
  }
  return { dropped: [...drop], dirsRemoved };
}

/**
 * Close out runs whose owning Core died: they can never write their own end.
 * The child is not touched — see childAliveOf.
 */
export function sweepInterrupted(now: number = Date.now()): number {
  const stale = [...readIndex().records.values()]
    .filter((r) => r.origin === 'recorded' && r.status === 'running' && r.endedAt == null)
    .filter((r) => deriveStatus(r).status === 'interrupted')
    .map((r) => r.id);
  let n = 0;
  for (const id of stale) {
    if (patchRun(id, { status: 'interrupted', termination: 'core_restart', endedAt: now })) n += 1;
  }
  return n;
}

const MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000;
const STALE_OPENCODE_CONFIG_MS = 24 * 3600 * 1000;
let initialized = false;

function runMaintenance(boot: boolean): void {
  const step = (name: string, fn: () => unknown) => {
    try { fn(); } catch (err) { logRunStoreFailure(`maintenance-${name}`, undefined, err); }
  };
  if (boot) step('interrupted', () => sweepInterrupted());
  step('retention', () => applyRetention());
  step('compact', () => {
    const s = readIndex();
    // At boot any foldable history is folded; afterwards only past the thresholds.
    if (boot && s.lines > s.records.size + (s.meta ? 1 : 0)) compactIndex();
    else maybeCompact();
  });
  step('opencode-configs', () => sweepStaleOpencodeConfigs(STALE_OPENCODE_CONFIG_MS));
}

/**
 * Boot-time maintenance: interrupted sweep, retention, compaction and the stale
 * opencode credential sweep. Deferred and try/catch'd — it must never delay or
 * fail Core's boot — and repeated on an unref'd 6 h timer.
 */
export function initHarnessRuns(): void {
  if (initialized) return;
  initialized = true;
  const imm = setImmediate(() => runMaintenance(true));
  imm.unref?.();
  const timer = setInterval(() => runMaintenance(false), MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}
