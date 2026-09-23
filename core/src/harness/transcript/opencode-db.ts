/**
 * OpenCode's SQLite store → normalized events, and the lmharness session list
 * that backfill reads.
 *
 * 🔴 opencode.db is the OPERATOR's database, not ours: harness runs share it
 * with their own OpenCode use (the harness does not relocate XDG dirs). Rules,
 * each one measured rather than assumed:
 *
 *   - Opened readonly + fileMustExist, per call, closed in `finally`. A readonly
 *     reader leaves the db and WAL bytes unchanged (only -shm read-marks move),
 *     and reads fine during another connection's open write transaction.
 *   - One-shot `.get()`/`.all()` only — no iterate(), no BEGIN. A reader that
 *     holds a transaction open blocks WAL truncation (measured: wal_checkpoint
 *     (TRUNCATE) returned busy until the reader finished).
 *   - Never `immutable=1` and never a copied file: both read a stale or torn
 *     snapshot of a live WAL database.
 *   - Only the constant SQL below, with explicit columns, on session/message/part.
 *     `account`, `control_account`, `credential` and `session_share` hold tokens
 *     and secrets; nothing here names them.
 *   - NEVER `opencode export`: measured to MUTATE the DB (it bumps
 *     project.time_updated and checkpoints the WAL), and it costs ~1.7 s and
 *     ~320 MB per call against ~5 ms for the direct read.
 *
 * Reading one session with (b) + (c) was verified canonical-JSON-equal to
 * `opencode export`'s messages for the same session.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HarnessEvent, LegacyOpencodeSession, LegacyUsage, NativeUnavailableReason, TextEvent, TurnEvent } from './types';
import { type ParsedTranscript, filesFromTools, finiteNum, str, unionCapped } from './capture';
import {
  markOpencodeFinal,
  opencodeApiError,
  opencodeToolEvent,
  opencodeUsage,
  reasoningEvent,
} from './opencode-stream';

export const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/;
const PART_MAX_BYTES = 262144;
const FILES_TOUCHED_MAX = 50;

// ─── the only SQL ────────────────────────────────────────────────────────────

const SQL_SESSION =
  'SELECT id, directory, title, version, model, agent, parent_id, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?';
const SQL_MESSAGES =
  'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 2000';
const SQL_PARTS =
  "SELECT id, message_id, length(data) AS n, CASE WHEN length(data) <= 262144 THEN data END AS data, json_extract(data,'$.type') AS type, json_extract(data,'$.tool') AS tool, json_extract(data,'$.callID') AS call_id, json_extract(data,'$.state.status') AS status FROM part WHERE session_id = ? ORDER BY message_id, id LIMIT 5000";
/**
 * 'lmharness' is opencode.ts PROVIDER_ID, repeated as a literal so this string stays
 * a constant — and so a pure reader does not import the module that spawns children.
 */
const SQL_HARNESS_SESSIONS =
  "SELECT id FROM session WHERE json_extract(model,'$.providerID') = 'lmharness' AND parent_id IS NULL ORDER BY time_created LIMIT 500";
/**
 * The transcript version: one tiny indexed query, so a poll can skip an unchanged session.
 *
 * 🔴 It must move on EVERY row the transcript is built from. OpenCode 1.18.29 upserts a
 * step's terminal state (error, time.completed, finish) onto the MESSAGE row, and tool
 * status / streamed text onto existing PART rows, and neither write moves
 * session.time_updated or the part count. A version of those two alone served a cached
 * mid-run parse ("killed_step") after the step had ended in an API error. So the newest
 * message/part time_updated is folded into the first field — `o:<n>:<n>` is unchanged.
 */
const SQL_VERSION =
  'SELECT max(s.time_updated, coalesce((SELECT max(time_updated) FROM message WHERE session_id = ?), 0), ' +
  'coalesce((SELECT max(time_updated) FROM part WHERE session_id = ?), 0)) AS time_updated, ' +
  '(SELECT count(*) FROM part WHERE session_id = ?) AS n FROM session s WHERE s.id = ?';

/** Every column the SQL above reads. A table missing one is a schema this build cannot read. */
const REQUIRED_COLUMNS: Record<'session' | 'message' | 'part', string[]> = {
  session: [
    'id', 'directory', 'title', 'version', 'model', 'agent', 'parent_id', 'time_created', 'time_updated',
    'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write',
  ],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_updated', 'data'],
};

// ─── driver + connection ─────────────────────────────────────────────────────

/** Where OpenCode keeps its store. HOME-based: the harness child env carries HOME and no XDG vars. */
export function opencodeDbPath(): string {
  return process.env.LM_HARNESS_OPENCODE_DB || path.join(process.env.HOME || os.homedir(), '.local/share/opencode/opencode.db');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let Driver: any = null;
let driverError: string | null = null;

/** better-sqlite3 is native; a node installed with --ignore-scripts has no binding. Cache the failure. */
function loadDriver(): any {
  if (Driver) return Driver;
  if (driverError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Driver = require('better-sqlite3');
    return Driver;
  } catch (e) {
    driverError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export type DbOutcome<T> = { ok: true; value: T } | { ok: false; reason: NativeUnavailableReason; detail?: string };

function reasonFor(e: unknown): { reason: NativeUnavailableReason; detail: string } {
  const code = (e as { code?: unknown })?.code;
  const detail = typeof code === 'string' ? code : e instanceof Error ? e.message.slice(0, 200) : 'error';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT') return { reason: 'OPENCODE_DB_BUSY', detail };
  if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code === 'SQLITE_ERROR') return { reason: 'UNSUPPORTED_SCHEMA', detail };
  // CANTOPEN on a file that exists (permissions, a vanished -shm dir) is transient
  // from the reader's point of view; there is no better code to hand the UI.
  return { reason: 'OPENCODE_DB_BUSY', detail };
}

/**
 * Open, check, run `fn`, close. Never throws.
 *
 * `fn` may use one-shot `.get()` / `.all()` only (see the header).
 */
function withDb<T>(dbPath: string | null | undefined, fn: (db: any) => DbOutcome<T>): DbOutcome<T> {
  if (!dbPath || path.basename(dbPath) !== 'opencode.db') return { ok: false, reason: 'OPENCODE_DB_MISSING' };
  try {
    if (!fs.statSync(dbPath).isFile()) return { ok: false, reason: 'OPENCODE_DB_MISSING' };
  } catch {
    return { ok: false, reason: 'OPENCODE_DB_MISSING' };
  }
  const D = loadDriver();
  if (!D) return { ok: false, reason: 'SQLITE_UNAVAILABLE', detail: driverError ?? undefined };
  let db: any = null;
  try {
    db = new D(dbPath, { readonly: true, fileMustExist: true, timeout: 500 });
    db.pragma('busy_timeout = 500');
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      const have = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
      const missing = cols.filter((c) => !have.has(c));
      if (missing.length) return { ok: false, reason: 'UNSUPPORTED_SCHEMA', detail: `${table}: ${missing.join(',')}` };
    }
    return fn(db);
  } catch (e) {
    const r = reasonFor(e);
    return { ok: false, reason: r.reason, detail: r.detail };
  } finally {
    if (db) try { db.close(); } catch { /* ignore */ }
  }
}

function parseJson(s: unknown): any {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * The exact inverse of how `opencode run` (1.18.29, read off the binary) stores the
 * message it was given, for the ONE argv element the harness passes after `--`:
 *
 *   a => a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a
 *
 * So a prompt with a space is wrapped in quotes AND has every inner `"` escaped as
 * `\"`; a prompt without one is stored untouched. The inverse is unambiguous: every
 * `"` in the forward output inside the wrapper carries the backslash opencode added.
 */
export function stripPromptQuotes(s: string): string {
  return s.length >= 2 && s.includes(' ') && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1).replace(/\\"/g, '"')
    : s;
}

// ─── one session ─────────────────────────────────────────────────────────────

interface SessionRow {
  id: string; directory: string | null; title: string | null; version: string | null; model: string | null;
  agent: string | null; parent_id: string | null; time_created: number; time_updated: number;
  tokens_input: number | null; tokens_output: number | null; tokens_reasoning: number | null;
  tokens_cache_read: number | null; tokens_cache_write: number | null;
}
interface MessageRow { id: string; time_created: number; data: string }
interface PartRow {
  id: string; message_id: string; n: number; data: string | null;
  type: string | null; tool: string | null; call_id: string | null; status: string | null;
}

interface SessionRead {
  session: SessionRow;
  parsed: ParsedTranscript;
  /** Facts backfill needs beyond the events. */
  assistants: number;
  toolParts: number;
  firstUserText?: string;
  lastAssistant?: any;
}

function readSessionRows(db: any, sessionId: string): { session: SessionRow; messages: MessageRow[]; parts: PartRow[] } | null {
  const session = db.prepare(SQL_SESSION).get(sessionId) as SessionRow | undefined;
  if (!session) return null;
  const messages = db.prepare(SQL_MESSAGES).all(sessionId) as MessageRow[];
  const parts = db.prepare(SQL_PARTS).all(sessionId) as PartRow[];
  return { session, messages, parts };
}

function sessionModelId(session: SessionRow): string | undefined {
  return str(parseJson(session.model)?.id);
}

/**
 * message + part rows → the normalized event list.
 *
 * `live`: the run is still going, so the LAST assistant message having no finish is
 * the step in progress, not a killed one — no killed_step marker and no (empty) turn
 * separator for it. Its parts still show. An earlier unfinished step, or any read of a
 * finished run, keeps the marker.
 */
function buildSession(rows: { session: SessionRow; messages: MessageRow[]; parts: PartRow[] }, opts: { live?: boolean } = {}): SessionRead {
  const { session, messages, parts } = rows;
  const events: HarnessEvent[] = [];
  const parsed: ParsedTranscript = {
    events,
    filesTouched: [],
    warnings: [],
    partial: messages.length >= 2000 || parts.length >= 5000,
    sessionId: session.id,
  };
  if (session.version) parsed.cliVersion = session.version;
  if (session.title) parsed.title = session.title;
  if (session.directory) parsed.cwd = session.directory;
  parsed.model = sessionModelId(session);

  const partsByMsg = new Map<string, PartRow[]>();
  for (const p of parts) {
    const list = partsByMsg.get(p.message_id);
    if (list) list.push(p);
    else partsByMsg.set(p.message_id, [p]);
  }

  const out: SessionRead = { session, parsed, assistants: 0, toolParts: 0 };
  let turn = 0;
  let tooBig = 0;
  let lastAssistantId: string | undefined;
  if (opts.live) {
    for (const m of messages) if (parseJson(m.data)?.role === 'assistant') lastAssistantId = m.id;
  }

  for (const m of messages) {
    const data = parseJson(m.data);
    if (!data || typeof data !== 'object') continue;
    const created = finiteNum(data.time?.created) ?? m.time_created;
    const mparts = partsByMsg.get(m.id) ?? [];

    if (data.role === 'user') {
      const texts: string[] = [];
      for (const p of mparts) {
        const pd = p.data === null ? null : parseJson(p.data);
        if ((pd?.type ?? p.type) === 'text' && typeof pd?.text === 'string') texts.push(pd.text);
      }
      const text = stripPromptQuotes(texts.join('\n'));
      events.push({ seq: 0, kind: 'user', text, at: created });
      if (out.firstUserText === undefined) out.firstUserText = text;
      continue;
    }
    if (data.role !== 'assistant') continue;

    turn++;
    out.assistants++;
    out.lastAssistant = data;
    for (const p of mparts) {
      const type = p.type;
      if (type === 'tool') out.toolParts++;
      if (p.data === null) {
        // Over the 256 KB cap: the row is never loaded, only its identifying columns.
        tooBig++;
        if (type === 'tool') {
          const ev = opencodeToolEvent({ tool: p.tool, callID: p.call_id, state: { status: p.status } }, created, turn);
          ev.truncated = true;
          events.push(ev);
        } else if (type === 'text' || type === 'reasoning') {
          const text = `[${p.n} bytes not loaded: over the ${PART_MAX_BYTES / 1024} KB part cap]`;
          events.push(type === 'text' ? { seq: 0, kind: 'text', text, at: created, turn } : { seq: 0, kind: 'reasoning', text, at: created, turn });
        }
        continue;
      }
      const pd = parseJson(p.data);
      if (!pd || typeof pd !== 'object') continue;
      const at = finiteNum(pd.time?.start) ?? finiteNum(pd.state?.time?.start) ?? created;
      if (pd.type === 'reasoning') {
        events.push(reasoningEvent(pd, at, turn));
      } else if (pd.type === 'text') {
        if (typeof pd.text === 'string') {
          const ev: TextEvent = { seq: 0, kind: 'text', text: pd.text, at, turn };
          events.push(ev);
        }
      } else if (pd.type === 'tool') {
        events.push(opencodeToolEvent(pd, at, turn));
      }
      // step-start / step-finish carry nothing the message row does not.
    }
    if (data.error && typeof data.error === 'object') {
      events.push(opencodeApiError(data.error, finiteNum(data.time?.completed) ?? created, turn));
    }
    const completed = finiteNum(data.time?.completed);
    const unfinished = !data.finish && completed === undefined && !data.error;
    if (unfinished && opts.live && m.id === lastAssistantId) continue;
    if (unfinished) {
      events.push({ seq: 0, kind: 'lifecycle', phase: 'killed_step', at: created, turn, detail: 'this step never completed: the run was killed or the process died mid-step' });
    }
    const tev: TurnEvent = { seq: 0, kind: 'turn', turn, at: completed ?? created };
    const model = str(data.modelID);
    if (model) {
      tev.model = model;
      parsed.model = model;
    }
    const finish = str(data.finish);
    if (finish) tev.finish = finish;
    const createdAt = finiteNum(data.time?.created);
    if (completed !== undefined && createdAt !== undefined) tev.latencyMs = Math.max(0, completed - createdAt);
    const usage = opencodeUsage(data.tokens);
    if (usage) tev.usage = usage;
    events.push(tev);
  }

  if (tooBig) parsed.warnings.push(`PART_TOO_LARGE: ${tooBig} part(s) over ${PART_MAX_BYTES / 1024} KB were not loaded`);
  if (parsed.partial) parsed.warnings.push('TOO_LARGE: the session exceeds the message/part read limits; the transcript is partial');
  markOpencodeFinal(events);
  parsed.filesTouched = unionCapped([filesFromTools(events)], FILES_TOUCHED_MAX);
  return out;
}

/** `o:<session.time_updated>:<part count>`. */
export function opencodeSessionVersion(dbPath: string | null, sessionId: string | null): DbOutcome<string> {
  if (!sessionId) return { ok: false, reason: 'NO_SESSION_ID' };
  if (!OPENCODE_SESSION_RE.test(sessionId)) return { ok: false, reason: 'SESSION_NOT_FOUND', detail: 'not an OpenCode session id' };
  return withDb(dbPath, (db) => {
    const row = db.prepare(SQL_VERSION).get(sessionId, sessionId, sessionId, sessionId) as { time_updated: number; n: number } | undefined;
    if (!row) return { ok: false, reason: 'SESSION_NOT_FOUND' };
    return { ok: true, value: `o:${row.time_updated}:${row.n}` };
  });
}

/**
 * Read one session. `lookup` lets the caller serve a cached parse for an
 * unchanged version without the three full queries.
 */
export function readOpencodeSession(
  dbPath: string | null,
  sessionId: string | null,
  lookup?: (version: string) => ParsedTranscript | undefined,
  opts: { live?: boolean } = {},
): DbOutcome<{ version: string; parsed: ParsedTranscript }> {
  if (!sessionId) return { ok: false, reason: 'NO_SESSION_ID' };
  if (!OPENCODE_SESSION_RE.test(sessionId)) return { ok: false, reason: 'SESSION_NOT_FOUND', detail: 'not an OpenCode session id' };
  return withDb(dbPath, (db) => {
    const vrow = db.prepare(SQL_VERSION).get(sessionId, sessionId, sessionId, sessionId) as { time_updated: number; n: number } | undefined;
    if (!vrow) return { ok: false, reason: 'SESSION_NOT_FOUND' };
    const version = `o:${vrow.time_updated}:${vrow.n}`;
    const hit = lookup?.(version);
    if (hit) return { ok: true, value: { version, parsed: hit } };
    const rows = readSessionRows(db, sessionId);
    if (!rows) return { ok: false, reason: 'SESSION_NOT_FOUND' };
    return { ok: true, value: { version, parsed: buildSession(rows, opts).parsed } };
  });
}

// ─── backfill ────────────────────────────────────────────────────────────────

function legacyUsage(s: SessionRow): LegacyUsage {
  const input = finiteNum(s.tokens_input) ?? 0;
  const reasoning = finiteNum(s.tokens_reasoning) ?? 0;
  // Output folds reasoning in, exactly as parseOpencodeStream does for a recorded
  // run — so a backfilled row and a recorded one report comparable figures. The
  // reasoning figure is still given on its own.
  const output = (finiteNum(s.tokens_output) ?? 0) + reasoning;
  return {
    input,
    output,
    reasoning,
    cacheRead: finiteNum(s.tokens_cache_read) ?? 0,
    total: input + output,
    reported: input > 0 || output > 0,
  };
}

function legacyStatus(last: any): { status: LegacyOpencodeSession['status']; error?: string } {
  if (!last) return { status: 'unknown' };
  if (last.error && typeof last.error === 'object') {
    const ev = opencodeApiError(last.error, undefined);
    return { status: 'failed', error: `${ev.errorType ?? 'Error'}: ${ev.message}`.slice(0, 2000) };
  }
  if (last.finish === 'stop') return { status: 'succeeded' };
  if (!last.finish && finiteNum(last.time?.completed) === undefined) return { status: 'aborted' };
  return { status: 'unknown' };
}

/**
 * Every top-level session the opencode harness created, identified by the
 * provider id it writes into its config (`lmharness`). A child session belongs
 * to its parent's run and is not a run of its own.
 */
export function listLmharnessSessions(
  dbPath?: string,
): { available: boolean; reason?: NativeUnavailableReason; sessions: LegacyOpencodeSession[] } {
  const r = withDb(dbPath ?? opencodeDbPath(), (db) => {
    const ids = db.prepare(SQL_HARNESS_SESSIONS).all() as Array<{ id: string }>;
    const sessions: LegacyOpencodeSession[] = [];
    for (const { id } of ids) {
      if (!OPENCODE_SESSION_RE.test(id)) continue;
      try {
        const rows = readSessionRows(db, id);
        if (!rows) continue;
        const read = buildSession(rows);
        const s = read.session;
        const last = read.lastAssistant;
        const st = legacyStatus(last);
        const item: LegacyOpencodeSession = {
          sessionId: s.id,
          directory: s.directory ?? null,
          title: s.title ?? null,
          version: s.version ?? null,
          model: sessionModelId(s) ?? str(last?.modelID) ?? null,
          startedAt: s.time_created,
          endedAt: finiteNum(last?.time?.completed) ?? finiteNum(s.time_updated) ?? null,
          status: st.status,
          numTurns: read.assistants,
          toolCalls: read.toolParts,
          usage: legacyUsage(s),
        };
        if (st.error) item.error = st.error;
        if (read.firstUserText !== undefined) {
          item.promptPreview = read.firstUserText.trim().slice(0, 300);
          // The full length, as the recorder stores prompt.length — not the preview's.
          item.promptChars = read.firstUserText.length;
        }
        sessions.push(item);
      } catch {
        // One unreadable session must not cost the rest.
        continue;
      }
    }
    return { ok: true, value: sessions };
  });
  return r.ok ? { available: true, sessions: r.value } : { available: false, reason: r.reason, sessions: [] };
}
