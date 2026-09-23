/**
 * One-shot backfill of harness runs that predate the recorder.
 *
 * DEV ONLY. Measured: the published 0.2.4 package ships no harness code, so every
 * legacy run on disk came from a dev Core — a prod Core has nothing to recover,
 * and backfilling in both would list the same runs twice.
 *
 * Lazy (first GET of the runs or runners list), once per index (a `meta` line
 * marks it done), and READ-ONLY on its sources: qwen run dirs are only read (and
 * tightened to 0700), and OpenCode's database is only ever read through the
 * transcript layer's readonly, column-whitelisted queries. A source that cannot
 * be read becomes a warning on the meta line, never a failed request.
 *
 * Legacy OpenCode sessions have no execution id, so they are identified the only
 * way the DB allows: the harness's fixed provider id (`lmharness`). An operator
 * provider of the same name would match too, which is why every backfilled
 * record is marked `inferred`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDevRepo } from '../utils/path-utils';
import { RUN_ID_RE, RUN_LIMITS, type HarnessRunRecord, type HarnessRunUsage } from './run-types';
import { legacyRunsRoot, otherModeRunIndexFile, runIndexFile } from './run-paths';
import { collectSecrets, redactString } from './redact';
import {
  allRuns,
  foldIndexFileReadOnly,
  getBackfillMeta,
  hasRun,
  logRunStoreFailure,
  sourceRefFor,
  startRun,
  writeBackfillMeta,
} from './run-store';
import { inferLegacyQwenRun, listLmharnessSessions, opencodeDbPath, summarizeRun } from './transcript';
import type { LegacyUsage } from './transcript';

/** Upper bound on legacy dirs examined, so a pathological data dir cannot stall a request. */
const QWEN_SCAN_CAP = 2000;

export interface BackfillState {
  done: boolean;
  at?: number;
  qwen: number;
  opencode: number;
  warnings?: string[];
}

/** Index files a backfill was already attempted against in this process. */
const attempted = new Set<string>();

function usageFrom(u: LegacyUsage | undefined): HarnessRunUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    reasoningTokens: u.reasoning ?? null,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: 0,
    totalTokens: u.total ?? 0,
    reported: Boolean(u.reported),
  };
}

const clip = (s: string | null | undefined, n: number, secrets: string[]): string | undefined =>
  typeof s === 'string' && s ? redactString(s, secrets).slice(0, n) : undefined;

/**
 * Tool counts by native name, from the run's native transcript. A recorded run
 * gets these from the recorder's post-run enrichment; a backfilled one is
 * written once and never enriched, so without this every legacy run would be
 * missing from the per-runner top-tools list while still counting toolCalls.
 */
function toolStats(rec: HarnessRunRecord): Partial<HarnessRunRecord> {
  try {
    const e = summarizeRun(sourceRefFor(rec, false));
    return (e.toolCalls ?? 0) > 0 ? { toolsByName: e.toolsByName, toolErrors: e.toolErrors } : {};
  } catch {
    return {};
  }
}

/** `agent-<epochMs>-<rand>` — the id agent-api generates — carries its own start time. */
function epochFromId(name: string): number | null {
  const m = /^agent-(\d{13})-/.exec(name);
  return m ? Number(m[1]) : null;
}

function backfillQwen(secrets: string[], warnings: string[]): number {
  const root = legacyRunsRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warnings.push(`qwen: legacy root unreadable (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
    return 0;
  }
  let scanned = 0;
  let added = 0;
  for (const name of names) {
    if (scanned >= QWEN_SCAN_CAP) {
      warnings.push(`qwen: stopped after ${QWEN_SCAN_CAP} legacy dirs`);
      break;
    }
    if (!RUN_ID_RE.test(name)) continue;
    const dir = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (!fs.lstatSync(path.join(dir, 'qwen-home')).isDirectory()) continue;
    } catch {
      continue;
    }
    // A dir with a capture or prompt file was made by a RECORDING Core (a prod
    // one shares this root) — it has its own record there, not a legacy run.
    if (fs.existsSync(path.join(dir, 'stdout.log')) || fs.existsSync(path.join(dir, 'prompt.txt'))) continue;
    if (hasRun(name)) continue;
    scanned += 1;

    const inf = inferLegacyQwenRun(dir);
    const startedAt = epochFromId(name) ?? inf.startedAt ?? st.mtimeMs;
    const endedAt = inf.endedAt ?? undefined;
    const now = Date.now();
    const rec: HarnessRunRecord = {
      v: 1,
      id: name,
      executionId: name,
      runner: 'qwen',
      origin: 'backfill',
      inferred: true,
      core: 'unknown',
      corePid: null,
      status: inf.status,
      background: null,
      promptPreview: (clip(inf.promptPreview, RUN_LIMITS.promptPreviewChars, secrets) ?? '').trim(),
      promptChars: inf.promptChars ?? inf.promptPreview?.length ?? 0,
      cwd: inf.cwd,
      cwdDefaulted: false,
      model: inf.model,
      providerProfile: null,
      baseUrlHost: null,
      timeoutMs: null,
      maxTurns: null,
      // The qwen harness has always passed --max-session-turns.
      maxTurnsEnforced: true,
      startedAt,
      ...(endedAt !== undefined ? { endedAt, durationMs: Math.max(0, endedAt - startedAt) } : {}),
      ...(inf.sessionId ? { sessionId: inf.sessionId } : {}),
      ...(inf.cliVersion ? { cliVersion: inf.cliVersion } : {}),
      numTurns: inf.numTurns,
      toolCalls: inf.toolCalls,
      usage: usageFrom(inf.usage),
      costUsd: null,
      resultPreview: clip(inf.resultPreview, RUN_LIMITS.resultPreviewChars, secrets),
      error: clip(inf.error, RUN_LIMITS.errorChars, secrets),
      filesTouched: (inf.filesTouched ?? []).slice(0, RUN_LIMITS.filesTouchedMax),
      runDir: `harness-runs/${name}`,
      native: { kind: 'qwen-chat' },
      updatedAt: now,
    };
    // Legacy dirs were created 0775 and hold transcripts; tighten them while here.
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to insist on */ }
    if (startRun({ ...rec, ...toolStats(rec) })) added += 1;
  }
  return added;
}

function backfillOpencode(secrets: string[], warnings: string[]): number {
  const dbPath = opencodeDbPath();
  const listed = listLmharnessSessions(dbPath);
  if (!listed.available) {
    // No OpenCode on this node is the normal case, not something to warn about.
    if (listed.reason && listed.reason !== 'OPENCODE_DB_MISSING') warnings.push(`opencode: ${listed.reason}`);
    return 0;
  }
  // Both modes share the operator's opencode.db and write the same provider id, so a
  // session is legacy only if NO recorder could own it. Read the other mode's index too
  // (read-only), and skip every session created at or after the first recorded OpenCode
  // run in either: a session that new belongs to some recorder — including a run in
  // flight here whose session id is not sniffed yet (its row exists seconds before the
  // first stdout frame names it), whose startedAt precedes its session's time_created.
  const recorded = [...allRuns(), ...foldIndexFileReadOnly(otherModeRunIndexFile())];
  const recordedSessions = new Set(recorded.map((r) => r.sessionId).filter(Boolean));
  let cutoff: number | undefined;
  for (const r of recorded) {
    if (r.origin === 'recorded' && r.runner === 'opencode' && Number.isFinite(r.startedAt)) {
      cutoff = cutoff === undefined ? r.startedAt : Math.min(cutoff, r.startedAt);
    }
  }
  let added = 0;
  for (const s of listed.sessions) {
    const id = `oc-${s.sessionId}`;
    if (!RUN_ID_RE.test(id) || recordedSessions.has(s.sessionId) || hasRun(id)) continue;
    if (cutoff !== undefined && s.startedAt >= cutoff) continue;
    const endedAt = s.endedAt ?? undefined;
    const rec: HarnessRunRecord = {
      v: 1,
      id,
      executionId: null,
      runner: 'opencode',
      origin: 'backfill',
      inferred: true,
      core: 'unknown',
      corePid: null,
      status: s.status,
      background: null,
      promptPreview: (clip(s.promptPreview, RUN_LIMITS.promptPreviewChars, secrets) ?? '').trim(),
      promptChars: s.promptChars ?? s.promptPreview?.length ?? 0,
      cwd: s.directory,
      cwdDefaulted: false,
      model: s.model,
      providerProfile: null,
      baseUrlHost: null,
      timeoutMs: null,
      maxTurns: null,
      maxTurnsEnforced: false,
      startedAt: s.startedAt,
      ...(endedAt !== undefined ? { endedAt, durationMs: Math.max(0, endedAt - s.startedAt) } : {}),
      sessionId: s.sessionId,
      ...(s.version ? { cliVersion: s.version } : {}),
      numTurns: s.numTurns,
      toolCalls: s.toolCalls,
      usage: usageFrom(s.usage),
      costUsd: null,
      error: clip(s.error, RUN_LIMITS.errorChars, secrets),
      runDir: null,
      native: { kind: 'opencode-db', dbPath },
      updatedAt: Date.now(),
    };
    if (startRun({ ...rec, ...toolStats(rec) })) added += 1;
  }
  return added;
}

/**
 * Backfill once if it has not run for this index, and report the state.
 *
 * On prod it never runs: `done: true` with no `at` means "nothing to backfill
 * here", not that a backfill happened.
 */
export function ensureBackfill(): BackfillState {
  let meta = null;
  try { meta = getBackfillMeta(); } catch { /* treated as not done */ }
  if (meta) return { done: true, at: meta.at, ...meta.backfill };
  if (!isDevRepo()) return { done: true, qwen: 0, opencode: 0 };

  const file = runIndexFile();
  if (attempted.has(file)) return { done: false, qwen: 0, opencode: 0 };
  attempted.add(file);

  const warnings: string[] = [];
  let secrets: string[] = [];
  try { secrets = collectSecrets(); } catch { /* the generic patterns still apply */ }
  let qwen = 0;
  let opencode = 0;
  try {
    qwen = backfillQwen(secrets, warnings);
  } catch (err) {
    logRunStoreFailure('backfill-qwen', undefined, err);
    warnings.push('qwen: backfill failed');
  }
  try {
    opencode = backfillOpencode(secrets, warnings);
  } catch (err) {
    logRunStoreFailure('backfill-opencode', undefined, err);
    warnings.push('opencode: backfill failed');
  }
  const backfill = { qwen, opencode, warnings };
  if (writeBackfillMeta(backfill)) {
    // Report the line's own timestamp, so this answer and every later one agree.
    const written = getBackfillMeta();
    if (written) return { done: true, at: written.at, ...written.backfill };
  }
  return { done: false, ...backfill };
}
