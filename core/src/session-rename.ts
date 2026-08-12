/**
 * First-class LOCAL Claude Code session rename — no TUI driving.
 *
 * The CLI's /rename appends ONE record to the session transcript:
 *
 *   {"type":"custom-title","customTitle":"<title>","sessionId":"<uuid>"}
 *
 * (shape read from real transcripts under ~/.claude/projects/ — exactly
 * three fields, one line). Every reader takes the LAST such record:
 * session-cache.ts (~913), agent-session-store.ts (~3002/~5119), and the CLI
 * itself on the next `claude --resume`. So an external append of that exact
 * shape IS the rename — the previous mechanism (driving `/rename` through a
 * tmux pane) exists only because nothing wrote this record directly.
 *
 * Live-session safety: transcripts are append-only with no lock (see
 * terminal/cc-sessions.ts). The corruption mechanism documented there is a
 * SECOND `claude --resume` writer appending message chains that fork the
 * DAG. A single one-line O_APPEND write of this metadata record does not
 * create that hazard: O_APPEND positions atomically per write, the record
 * carries no uuid/parentUuid so it cannot fork the message chain, and
 * last-record-wins keeps a later in-TUI /rename authoritative. The honest
 * limitation that remains: a LIVE session's terminal keeps showing its old
 * title until the next resume — callers report that, never hide it.
 *
 * Honesty contract: the title is RE-READ from the transcript after the
 * append (`verified`), and the previous title is reported, so a caller can
 * both confirm the rename landed and rename back.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { sessionVerdict } from './terminal/cc-sessions';

/** Matches rename_conversation's bound — a title is a sidebar label, not prose. */
export const MAX_SESSION_TITLE_LEN = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionRenameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'SessionRenameError';
  }
}

/**
 * Validate + normalize a session title to ONE line. A raw newline would
 * terminate the JSONL record early — normalization is what makes the
 * single-line append safe, so it throws rather than silently truncating.
 */
export function normalizeSessionTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SessionRenameError('INVALID_TITLE', 'title must be a string', 400);
  }
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) throw new SessionRenameError('INVALID_TITLE', 'title must not be empty', 400);
  if (t.length > MAX_SESSION_TITLE_LEN) {
    throw new SessionRenameError('INVALID_TITLE', `title must be <= ${MAX_SESSION_TITLE_LEN} chars (got ${t.length})`, 400);
  }
  return t;
}

/** Last custom-title in an iterable of lines, via the same predicate session-cache uses. */
function lastCustomTitle(lines: Iterable<string>): string | null {
  let title: string | null = null;
  for (const line of lines) {
    // Cheap pre-filter — transcripts run to many MB and custom-title records are rare.
    if (!line.includes('"custom-title"')) continue;
    try {
      const msg = JSON.parse(line) as { type?: string; customTitle?: string };
      if (msg.type === 'custom-title' && msg.customTitle) title = msg.customTitle;
    } catch {
      /* partial/foreign line — not a title record */
    }
  }
  return title;
}

/** Stream the whole transcript for the last custom-title record (may be anywhere). */
async function scanLastCustomTitle(jsonlPath: string): Promise<string | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let title: string | null = null;
  for await (const line of rl) {
    if (!line.includes('"custom-title"')) continue;
    const t = lastCustomTitle([line]);
    if (t) title = t;
  }
  return title;
}

/** Re-read the tail (the append just landed there) for verification. */
function readTailTitle(jsonlPath: string, tailBytes = 64 * 1024): string | null {
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // A mid-file start cuts the first line — drop it unless we read from 0.
    if (size > len) lines.shift();
    return lastCustomTitle(lines);
  } finally {
    fs.closeSync(fd);
  }
}

export interface AppendTitleResult {
  /** Last custom-title present BEFORE this append (null when never renamed). */
  previousTitle: string | null;
  /** The title re-read from the transcript AFTER the append. */
  readBack: string | null;
  /** readBack === the requested title — the rename is proven, not assumed. */
  verified: boolean;
  /** True when the file's last write had lost its trailing newline and we healed it. */
  repairedNewline: boolean;
}

/**
 * Append the CLI's own custom-title record to an EXISTING transcript and
 * verify by reading the title back. Never creates the file — a transcript
 * that does not exist is a session this host does not have.
 */
export async function appendCustomTitle(
  jsonlPath: string,
  sessionId: string,
  title: string,
): Promise<AppendTitleResult> {
  // fails with ENOENT before we scan — never fabricate a transcript
  const stat = await fs.promises.stat(jsonlPath);

  const previousTitle = await scanLastCustomTitle(jsonlPath);

  // If the last write was torn (no trailing \n), gluing our record onto it
  // would corrupt BOTH lines. Heal with a leading newline in the SAME write
  // so the repair and the record land in one atomic O_APPEND.
  let repairedNewline = false;
  if (stat.size > 0) {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, stat.size - 1);
      repairedNewline = last[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  // Field order matches the CLI's own record byte-for-byte.
  const record = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId });
  await fs.promises.appendFile(jsonlPath, `${repairedNewline ? '\n' : ''}${record}\n`, 'utf8');

  const readBack = readTailTitle(jsonlPath);
  return { previousTitle, readBack, verified: readBack === title, repairedNewline };
}

export interface LocalRenameResult {
  renamed: boolean;
  sessionId: string;
  title: string;
  previousTitle: string | null;
  /** Title re-read from the transcript after the append. */
  readBack: string | null;
  verified: boolean;
  /** A live owner process exists — its TUI shows the old title until resume. */
  live: boolean;
  jsonl: string;
  mechanism: 'jsonl-append';
  note?: string;
}

/**
 * Rename a local Claude Code session by uuid. Resolves the transcript +
 * liveness through the same registry the CCR verdicts use, appends the
 * custom-title record, and reports exactly what happened.
 */
export async function renameLocalSession(sessionId: string, rawTitle: unknown): Promise<LocalRenameResult> {
  const sid = String(sessionId || '').trim().toLowerCase();
  if (!UUID_RE.test(sid)) {
    throw new SessionRenameError('INVALID_SESSION_ID', `session id must be a Claude Code session uuid (got "${sessionId}")`, 400);
  }
  const title = normalizeSessionTitle(rawTitle);

  const verdict = sessionVerdict(sid);
  if (!verdict.jsonl) {
    throw new SessionRenameError('SESSION_NOT_FOUND', `no transcript for session ${sid} under ~/.claude/projects on this host`, 404);
  }

  const res = await appendCustomTitle(verdict.jsonl, sid, title);
  return {
    renamed: res.verified,
    sessionId: sid,
    title,
    previousTitle: res.previousTitle,
    readBack: res.readBack,
    verified: res.verified,
    live: verdict.live,
    jsonl: verdict.jsonl,
    mechanism: 'jsonl-append',
    note: verdict.live
      ? 'Session is LIVE: its terminal keeps showing the old title until the next resume; lm-assist session lists pick the new title up from the transcript.'
      : undefined,
  };
}
