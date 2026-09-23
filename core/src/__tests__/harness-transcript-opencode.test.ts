import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * OpenCode transcript readers: the `--format json` capture and the readonly
 * read of OpenCode's SQLite store.
 *
 * The DB is the OPERATOR's, not ours, so the properties pinned here are about
 * what the reader must never do to it or take from it:
 *   - leave the .db and -wal bytes unchanged, including while another
 *     connection holds a write transaction open;
 *   - never read the secret-bearing tables (a `credential` canary proves it);
 *   - never pass on an error's responseHeaders / responseBody.
 *
 * Everything runs against a scratch DB built here in the measured schema
 * (opencode 1.18.29 column names). NEVER the real ~/.local/share/opencode.
 */

import {
  loadTranscript,
  summarizeRun,
  listLmharnessSessions,
  type TranscriptSourceRef,
  type ToolEvent,
  type TurnEvent,
} from '../harness/transcript';
import { stripPromptQuotes } from '../harness/transcript/opencode-db';

/**
 * How `opencode run` 1.18.29 stores the one argv element the harness passes after
 * `--` (read off the installed binary): wrapped in quotes with inner quotes escaped
 * when it has a space, verbatim when it has none.
 */
const opencodeStores = (a: string) => (a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a);

/* eslint-disable @typescript-eslint/no-explicit-any */
let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const SKIP_DB = Database ? false : 'better-sqlite3 has no compiled binding on this node';

let tmp: string;
let savedDataDir: string | undefined;
let savedOcDb: string | undefined;
let dbPath: string;
let writer: any = null;

const CANARY_CRED = 'sk-test-SENTINEL-0000000000000000';
const CANARY_HEADER = 'CANARY-HEADER-cf-ray-9f9f9f';
const CANARY_BODY = 'CANARY-BODY-<html>upstream</html>';
const CANARY_TOKEN = 'CANARY-ACCESS-TOKEN-7e7e7e';
const MODEL = 'vendor-x/test-model:free';
const T0 = 1_800_000_000_000;

const S_OK = 'ses_AAAAAAAAAAAAAAAAokay01';
const S_ERR = 'ses_BBBBBBBBBBBBBBBBerr001';
const S_KILLED = 'ses_CCCCCCCCCCCCCCCCkill01';
const S_OTHER = 'ses_DDDDDDDDDDDDDDDDother1';
const S_CHILD = 'ses_EEEEEEEEEEEEEEEEchild1';
const S_BIG = 'ses_FFFFFFFFFFFFFFFFbig001';

const SCHEMA = `
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT,
  title TEXT, version TEXT, share_url TEXT, cost REAL,
  tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
CREATE INDEX part_session_idx ON part(session_id);
CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT);
CREATE TABLE account (id TEXT PRIMARY KEY, access_token TEXT, refresh_token TEXT);
`;

function buildDb(file: string, schema = SCHEMA): any {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // Keep the WAL populated, as a running OpenCode does, so its bytes are checkable.
  db.pragma('wal_autocheckpoint = 0');
  db.exec(schema);
  return db;
}

let msgSeq = 0;
function seed(db: any): void {
  db.prepare('INSERT INTO credential VALUES (?, ?)').run('c1', CANARY_CRED);
  db.prepare('INSERT INTO account VALUES (?, ?, ?)').run('a1', CANARY_TOKEN, CANARY_TOKEN);

  const session = (id: string, provider: string, t: number, parent: string | null = null, title = 'Synthetic session') =>
    db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
      VALUES (?, 'global', ?, 'slug', '/work/oc', '/', ?, '0.0.0-test', 0, 1000, 20, 30, 0, 0, 'build', ?, ?, ?)`)
      .run(id, parent, title, JSON.stringify({ id: MODEL, providerID: provider, variant: 'default' }), t, t + 5000);
  const message = (sid: string, t: number, data: unknown) => {
    const id = `msg_${String(++msgSeq).padStart(6, '0')}`;
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, sid, t, t, JSON.stringify(data));
    return id;
  };
  let partSeq = 0;
  const part = (sid: string, mid: string, data: unknown) =>
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${mid}_${String(++partSeq).padStart(4, '0')}`, mid, sid, T0, T0, JSON.stringify(data));
  const userMsg = (sid: string, t: number, prompt: string) => {
    const mid = message(sid, t, { role: 'user', time: { created: t }, agent: 'build', model: { providerID: 'lmharness', modelID: MODEL } });
    part(sid, mid, { type: 'text', text: opencodeStores(prompt) });
  };
  const asst = (sid: string, t: number, extra: Record<string, unknown>) =>
    message(sid, t, {
      parentID: 'msg_x', role: 'assistant', mode: 'build', agent: 'build', path: { cwd: '/work/oc', root: '/' },
      cost: 0, modelID: MODEL, providerID: 'lmharness', ...extra,
    });

  // A clean two-step run: write a file, then answer.
  session(S_OK, 'lmharness', T0);
  userMsg(S_OK, T0 + 10, 'Create hello.txt containing PONG, then reply DONE.');
  let m = asst(S_OK, T0 + 20, {
    time: { created: T0 + 20, completed: T0 + 3020 }, finish: 'tool-calls',
    tokens: { total: 160, input: 100, output: 10, reasoning: 50, cache: { read: 1, write: 2 } },
  });
  part(S_OK, m, { type: 'step-start' });
  part(S_OK, m, { type: 'reasoning', text: 'I will write it.', time: { start: T0 + 100, end: T0 + 150 } });
  part(S_OK, m, { type: 'tool', tool: 'write', callID: 'write_1', state: {
    status: 'completed', input: { content: 'PONG', filePath: '/tmp/x/hello.txt' }, output: 'Wrote file successfully.',
    metadata: { diagnostics: {}, filepath: '/tmp/x/hello.txt', exists: false, truncated: false },
    title: 'tmp/x/hello.txt', time: { start: T0 + 200, end: T0 + 230 } } });
  part(S_OK, m, { type: 'tool', tool: 'edit', callID: 'edit_1', state: {
    status: 'completed', input: { filePath: '/work/oc/a.ts', oldString: 'a', newString: 'b' }, output: 'Edit applied successfully.',
    metadata: { diagnostics: {}, diff: '--- a.ts\n+++ a.ts\n-a\n+b\n', filediff: { file: '/work/oc/a.ts', patch: '--- a.ts\n+++ a.ts\n-a\n+b\n', additions: 1, deletions: 1 }, truncated: false },
    title: 'a.ts', time: { start: T0 + 240, end: T0 + 260 } } });
  part(S_OK, m, { type: 'step-finish', reason: 'tool-calls', tokens: { total: 160, input: 100, output: 10, reasoning: 50, cache: { read: 1, write: 2 } }, cost: 0 });
  m = asst(S_OK, T0 + 3100, {
    time: { created: T0 + 3100, completed: T0 + 4300 }, finish: 'stop',
    tokens: { total: 125, input: 110, output: 5, reasoning: 10, cache: { read: 0, write: 0 } },
  });
  part(S_OK, m, { type: 'step-start' });
  part(S_OK, m, { type: 'text', text: 'DONE', time: { start: T0 + 4200, end: T0 + 4210 } });
  part(S_OK, m, { type: 'step-finish', reason: 'stop', tokens: {}, cost: 0 });

  // A provider 500: the error carries the upstream's headers and body.
  session(S_ERR, 'lmharness', T0 + 10_000);
  userMsg(S_ERR, T0 + 10_010, 'say hi');
  asst(S_ERR, T0 + 10_020, {
    time: { created: T0 + 10_020, completed: T0 + 12_000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error: { name: 'APIError', data: {
      message: 'Internal Server Error', statusCode: 500, isRetryable: true,
      responseHeaders: { 'cf-ray': CANARY_HEADER }, responseBody: CANARY_BODY, metadata: { url: 'https://gateway.invalid/v1' },
    } },
  });

  // Killed mid-step: the last assistant has neither finish nor time.completed.
  session(S_KILLED, 'lmharness', T0 + 20_000);
  userMsg(S_KILLED, T0 + 20_010, 'count to 500 slowly');
  m = asst(S_KILLED, T0 + 20_020, {
    time: { created: T0 + 20_020, completed: T0 + 21_000 }, finish: 'tool-calls',
    tokens: { input: 50, output: 5, reasoning: 5, cache: { read: 0, write: 0 } },
  });
  part(S_KILLED, m, { type: 'tool', tool: 'bash', callID: 'bash_1', state: {
    status: 'completed', input: { command: 'seq 1 5' }, output: '1\n2\n3\n4\n5\n', metadata: { exit: 0 }, title: 'seq', time: { start: T0 + 20_100, end: T0 + 20_200 } } });
  asst(S_KILLED, T0 + 21_100, { time: { created: T0 + 21_100 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });

  // Not ours: another provider, and a child session of a harness run.
  session(S_OTHER, 'someprovider', T0 + 30_000);
  userMsg(S_OTHER, T0 + 30_010, 'manual test');
  session(S_CHILD, 'lmharness', T0 + 40_000, S_OK);
  userMsg(S_CHILD, T0 + 40_010, 'subtask');

  // One tool part over the 256 KB load cap.
  session(S_BIG, 'lmharness', T0 + 50_000);
  userMsg(S_BIG, T0 + 50_010, 'dump the log');
  m = asst(S_BIG, T0 + 50_020, { time: { created: T0 + 50_020, completed: T0 + 51_000 }, finish: 'stop', tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
  part(S_BIG, m, { type: 'tool', tool: 'bash', callID: 'bash_big', state: {
    status: 'completed', input: { command: 'cat big.log' }, output: 'y'.repeat(300 * 1024), title: 'cat', time: { start: T0 + 50_100, end: T0 + 50_200 } } });
}

before(() => {
  savedDataDir = process.env.LM_ASSIST_DATA_DIR;
  savedOcDb = process.env.LM_HARNESS_OPENCODE_DB;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-transcript-oc-'));
  process.env.LM_ASSIST_DATA_DIR = path.join(tmp, 'data');
  dbPath = path.join(tmp, 'share', 'opencode', 'opencode.db');
  process.env.LM_HARNESS_OPENCODE_DB = dbPath;
  if (Database) {
    writer = buildDb(dbPath);
    seed(writer);
  }
});

after(() => {
  if (writer) try { writer.close(); } catch { /* ignore */ }
  if (savedDataDir === undefined) delete process.env.LM_ASSIST_DATA_DIR;
  else process.env.LM_ASSIST_DATA_DIR = savedDataDir;
  if (savedOcDb === undefined) delete process.env.LM_HARNESS_OPENCODE_DB;
  else process.env.LM_HARNESS_OPENCODE_DB = savedOcDb;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ref(over: Partial<TranscriptSourceRef> = {}): TranscriptSourceRef {
  return {
    runner: 'opencode', runDir: null, capturePath: null, promptPath: null, sessionId: S_OK,
    opencodeDbPath: dbPath, live: false, startedAt: T0, ...over,
  };
}
const load = (r: TranscriptSourceRef, source: 'auto' | 'captured' | 'native' = 'auto') =>
  loadTranscript(r, { source, offset: 0, limit: 1000, maxField: 65536 });

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function assertNoCanary(label: string, value: unknown): void {
  const json = JSON.stringify(value);
  for (const c of [CANARY_CRED, CANARY_HEADER, CANARY_BODY, CANARY_TOKEN, 'responseHeaders', 'responseBody', 'gateway.invalid']) {
    assert.ok(!json.includes(c), `${label} leaked ${c}`);
  }
}

// ─── captured --format json ──────────────────────────────────────────────────

test('stream: steps become turns; tool_use merges by callID; reasoning stays separate; errors drop the response', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  const capturePath = path.join(dir, 'stdout.log');
  const promptPath = path.join(dir, 'prompt.txt');
  const sid = 'ses_0123456789abcdefSTREAM';
  const frame = (type: string, part: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type, timestamp: T0, sessionID: sid, part: { id: 'prt_x', messageID: 'msg_x', sessionID: sid, ...part }, ...extra });
  const frames = [
    frame('step_start', { type: 'step-start' }),
    frame('reasoning', { type: 'reasoning', text: 'thinking', time: { start: T0, end: T0 + 40 } }),
    frame('tool_use', { type: 'tool', tool: 'write', callID: 'c1', state: {
      status: 'completed', input: { filePath: '/tmp/x/hello.txt', content: 'PONG' }, output: 'Wrote file successfully.',
      title: 'hello.txt', time: { start: T0 + 50, end: T0 + 80 } } }),
    // The only measured stdout tool frame carried just a status; a later state fills in.
    frame('tool_use', { type: 'tool', tool: 'read', callID: 'c2', state: { status: 'running', input: { filePath: '/work/nope' } } }),
    frame('tool_use', { type: 'tool', tool: 'read', callID: 'c2', state: { status: 'error', error: 'File not found: /work/nope' } }),
    frame('step_finish', { type: 'step-finish', reason: 'tool-calls', tokens: { total: 150, input: 100, output: 0, reasoning: 50, cache: { read: 1, write: 2 } } }),
    frame('step_start', { type: 'step-start' }),
    frame('text', { type: 'text', text: 'DONE', time: { start: T0 + 90, end: T0 + 95 } }),
    frame('step_finish', { type: 'step-finish', reason: 'stop', tokens: { total: 8, input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
    { type: 'error', timestamp: T0, sessionID: sid, error: { name: 'APIError', data: {
      message: 'Too Many Requests', statusCode: 429, isRetryable: true,
      responseHeaders: { 'cf-ray': CANARY_HEADER }, responseBody: CANARY_BODY } } },
  ];
  fs.writeFileSync(capturePath, frames.map((f, i) => `${T0 + i}\t${JSON.stringify(f)}`).join('\n') + '\n');
  fs.writeFileSync(promptPath, 'Create hello.txt');

  const res = load(ref({ runDir: dir, capturePath, promptPath, sessionId: null, live: true }));
  assert.equal(res.source, 'captured');
  assert.deepEqual(res.events.map((e) => e.kind),
    ['user', 'lifecycle', 'reasoning', 'tool', 'tool', 'turn', 'text', 'turn', 'api_error']);
  const reasoning = res.events[2];
  assert.ok(reasoning.kind === 'reasoning' && reasoning.durationMs === 40);

  const [write, read] = res.events.filter((e): e is ToolEvent => e.kind === 'tool');
  assert.equal(write.status, 'completed');
  assert.equal(write.output, 'Wrote file successfully.');
  assert.equal(write.durationMs, 30);
  assert.equal(read.status, 'error');
  assert.equal(read.nativeStatus, 'error');
  assert.equal(read.error, 'File not found: /work/nope');
  assert.deepEqual(read.input, { filePath: '/work/nope' }, 'a later state without input keeps the earlier input');

  const turns = res.events.filter((e): e is TurnEvent => e.kind === 'turn');
  assert.deepEqual(turns.map((t) => [t.turn, t.finish]), [[1, 'tool-calls'], [2, 'stop']]);
  assert.deepEqual(turns[0].usage, { input: 100, output: 0, reasoning: 50, cacheRead: 1, cacheWrite: 2 });

  const text = res.events[6];
  assert.ok(text.kind === 'text' && text.final === true);
  const err = res.events[8];
  assert.ok(err.kind === 'api_error');
  assert.deepEqual({ t: err.errorType, m: err.message, s: err.statusCode, r: err.retryable },
    { t: 'APIError', m: 'Too Many Requests', s: 429, r: true });
  assert.deepEqual(res.filesTouched, ['/tmp/x/hello.txt']);
  assertNoCanary('stream transcript', res);

  const sum = summarizeRun(ref({ runDir: dir, capturePath, promptPath, sessionId: null, live: false }));
  assert.equal(sum.toolCalls, 2);
  assert.equal(sum.toolErrors, 1);
  assert.equal(sum.reasoningTokens, 50);
  assert.equal(sum.sessionId, sid);
});

// ─── SQLite ──────────────────────────────────────────────────────────────────

test('db: a session reads as user → steps → turns, prompt unquoted, one merged tool event with its diff', { skip: SKIP_DB }, () => {
  const res = load(ref());
  assert.equal(res.source, 'opencode-db');
  assert.match(res.version, /^o:\d+:\d+$/);
  assert.deepEqual(res.events.map((e) => e.kind), ['user', 'reasoning', 'tool', 'tool', 'turn', 'text', 'turn']);
  const u = res.events[0];
  assert.ok(u.kind === 'user' && u.text === 'Create hello.txt containing PONG, then reply DONE.');

  const [write, edit] = res.events.filter((e): e is ToolEvent => e.kind === 'tool');
  assert.equal(write.name, 'write');
  assert.equal(write.callId, 'write_1');
  assert.equal(write.output, 'Wrote file successfully.');
  assert.equal(write.title, 'tmp/x/hello.txt');
  assert.equal(write.durationMs, 30);
  assert.equal(write.diff, undefined);
  assert.deepEqual(edit.diff, { patch: '--- a.ts\n+++ a.ts\n-a\n+b\n', file: '/work/oc/a.ts', added: 1, removed: 1 });

  const turns = res.events.filter((e): e is TurnEvent => e.kind === 'turn');
  assert.deepEqual(turns[0], {
    seq: 4, kind: 'turn', turn: 1, at: T0 + 3020, model: MODEL, finish: 'tool-calls', latencyMs: 3000,
    usage: { input: 100, output: 10, reasoning: 50, cacheRead: 1, cacheWrite: 2 },
  });
  const text = res.events[5];
  assert.ok(text.kind === 'text' && text.final === true && text.text === 'DONE');
  assert.equal(res.cliVersion, '0.0.0-test');
  assert.equal(res.title, 'Synthetic session');
  assert.deepEqual(res.filesTouched, ['/tmp/x/hello.txt', '/work/oc/a.ts']);

  const sum = summarizeRun(ref());
  assert.deepEqual(sum.toolsByName, { edit: 1, write: 1 });
  assert.equal(sum.reasoningTokens, 60);
});

test('db: an errored step becomes api_error WITHOUT the response headers or body', { skip: SKIP_DB }, () => {
  const res = load(ref({ sessionId: S_ERR }));
  const err = res.events.find((e) => e.kind === 'api_error');
  assert.ok(err && err.kind === 'api_error');
  assert.equal(err.errorType, 'APIError');
  assert.equal(err.message, 'Internal Server Error');
  assert.equal(err.statusCode, 500);
  assert.equal(err.retryable, true);
  assertNoCanary('errored session', res);
});

test('db: a step with neither finish nor completion is a killed_step', { skip: SKIP_DB }, () => {
  const res = load(ref({ sessionId: S_KILLED }));
  const killed = res.events.find((e) => e.kind === 'lifecycle');
  assert.ok(killed && killed.kind === 'lifecycle' && killed.phase === 'killed_step' && killed.turn === 2);
  assert.equal(res.events.some((e) => e.kind === 'text' && e.final), false);
});

test('db: while the run is LIVE the step in progress is not reported as killed; after, it is', { skip: SKIP_DB }, () => {
  const live = load(ref({ sessionId: S_KILLED, live: true }), 'native');
  assert.equal(live.events.some((e) => e.kind === 'lifecycle' && e.phase === 'killed_step'), false);
  assert.deepEqual(live.events.filter((e): e is TurnEvent => e.kind === 'turn').map((t) => t.turn), [1],
    'no empty turn separator for the step still streaming');
  assert.ok(live.events.some((e) => e.kind === 'tool'), 'the finished step still shows');
  // Same DB version, terminal read: the cache must not hand back the live parse.
  const dead = load(ref({ sessionId: S_KILLED, live: false }), 'native');
  assert.equal(dead.version, live.version);
  assert.ok(dead.events.some((e) => e.kind === 'lifecycle' && e.phase === 'killed_step'));
});

test('db: an in-place update of a message row moves the version, so a cached mid-run parse is not served', { skip: SKIP_DB }, () => {
  const file = path.join(tmp, 'stale', 'opencode.db');
  const db = buildDb(file);
  const sid = 'ses_GGGGGGGGGGGGGGGGstale1';
  db.prepare(`INSERT INTO session (id, parent_id, directory, title, version, tokens_input, tokens_output, tokens_reasoning,
    tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
    VALUES (?, NULL, '/w', 't', '0.0.0-test', 0, 0, 0, 0, 0, 'build', ?, ?, ?)`)
    .run(sid, JSON.stringify({ id: MODEL, providerID: 'lmharness' }), T0, T0 + 5);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_u', sid, T0, T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_u', 'msg_u', sid, T0, T0, JSON.stringify({ type: 'text', text: opencodeStores('say hi') }));
  const asst = { role: 'assistant', modelID: MODEL, providerID: 'lmharness', time: { created: T0 + 10 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_a', sid, T0 + 10, T0 + 10, JSON.stringify(asst));

  const r = ref({ sessionId: sid, opencodeDbPath: file });
  const mid = load(r, 'native');
  assert.ok(mid.events.some((e) => e.kind === 'lifecycle' && e.phase === 'killed_step'));

  // What OpenCode does when the step then fails: ONLY the message row is upserted —
  // no new part, and session.time_updated is left alone.
  db.prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?').run(JSON.stringify({
    ...asst, time: { created: T0 + 10, completed: T0 + 67_000 },
    error: { name: 'APIError', data: { message: 'Internal Server Error', statusCode: 500, isRetryable: true } },
  }), T0 + 67_000, 'msg_a');
  db.close();

  const after = load(r, 'native');
  assert.notEqual(after.version, mid.version, 'the version must move on a message-row update');
  assert.match(after.version, /^o:\d+:\d+$/);
  assert.ok(after.events.some((e) => e.kind === 'api_error' && e.message === 'Internal Server Error'));
  assert.equal(after.events.some((e) => e.kind === 'lifecycle' && e.phase === 'killed_step'), false);
});

test('stripPromptQuotes is the exact inverse of how opencode stores the prompt', () => {
  for (const p of [
    'Write the word "PONG" into hello.txt, then reply DONE.',
    'say \\"hi\\" now',
    '"DONE"',
    'DONE',
    '-x say hi',
    '"quoted with space"',
    'a',
  ]) {
    assert.equal(stripPromptQuotes(opencodeStores(p)), p, `round trip of ${JSON.stringify(p)}`);
  }
  assert.equal(stripPromptQuotes('"Write the word \\"PONG\\" into x, then reply DONE."'), 'Write the word "PONG" into x, then reply DONE.');
  assert.equal(stripPromptQuotes('"DONE"'), '"DONE"', 'no space: opencode never wrapped it');
});

test('db: a part over 256 KB is never loaded — it becomes a truncated tool', { skip: SKIP_DB }, () => {
  const res = load(ref({ sessionId: S_BIG }));
  const tool = res.events.find((e): e is ToolEvent => e.kind === 'tool');
  assert.ok(tool);
  assert.equal(tool.name, 'bash');
  assert.equal(tool.callId, 'bash_big');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.truncated, true);
  assert.equal(tool.output, undefined);
  assert.ok(res.warnings.some((w) => w.startsWith('PART_TOO_LARGE')));
  assert.ok(JSON.stringify(res).length < 64 * 1024);
});

test('db: listLmharnessSessions returns top-level lmharness sessions only, with inferred outcomes', { skip: SKIP_DB }, () => {
  const r = listLmharnessSessions(dbPath);
  assert.equal(r.available, true);
  assert.deepEqual(r.sessions.map((s) => s.sessionId), [S_OK, S_ERR, S_KILLED, S_BIG]);
  const by = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
  assert.equal(by[S_OK].status, 'succeeded');
  assert.equal(by[S_OK].numTurns, 2);
  assert.equal(by[S_OK].toolCalls, 2);
  assert.equal(by[S_OK].promptPreview, 'Create hello.txt containing PONG, then reply DONE.');
  assert.equal(by[S_OK].promptChars, 'Create hello.txt containing PONG, then reply DONE.'.length, 'the full length, not the preview\'s');
  assert.equal(by[S_OK].model, MODEL);
  assert.equal(by[S_OK].startedAt, T0);
  assert.equal(by[S_OK].endedAt, T0 + 4300);
  assert.equal(by[S_OK].directory, '/work/oc');
  // Output folds reasoning in, as the recorded opencode runs' usage does.
  assert.deepEqual(by[S_OK].usage, { input: 1000, output: 50, reasoning: 30, cacheRead: 0, total: 1050, reported: true });
  assert.equal(by[S_ERR].status, 'failed');
  assert.equal(by[S_ERR].error, 'APIError: Internal Server Error');
  assert.equal(by[S_KILLED].status, 'aborted');
  assert.equal(by[S_KILLED].endedAt, T0 + 20_000 + 5000, 'no completion → session.time_updated');
  assertNoCanary('session list', r);
});

test('db: nothing secret ever comes out, from any read', { skip: SKIP_DB }, () => {
  for (const sid of [S_OK, S_ERR, S_KILLED, S_BIG]) {
    assertNoCanary(`transcript ${sid}`, load(ref({ sessionId: sid })));
    assertNoCanary(`summary ${sid}`, summarizeRun(ref({ sessionId: sid })));
  }
  assertNoCanary('list', listLmharnessSessions(dbPath));
});

test('db: the .db and -wal bytes are unchanged by reads, including one during an open write transaction', { skip: SKIP_DB }, () => {
  const wal = `${dbPath}-wal`;
  assert.ok(fs.statSync(wal).size > 0, 'the fixture keeps a populated WAL');
  const before = [sha(dbPath), sha(wal)];

  load(ref());
  listLmharnessSessions(dbPath);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const res = load(ref({ sessionId: S_KILLED }));
    assert.equal(res.source, 'opencode-db', 'a readonly reader is not blocked by a writer');
  } finally {
    writer.exec('ROLLBACK');
  }
  summarizeRun(ref());

  assert.deepEqual([sha(dbPath), sha(wal)], before);
});

test('db: a schema missing a column this reader needs is UNSUPPORTED_SCHEMA, not an empty transcript', { skip: SKIP_DB }, () => {
  const other = path.join(tmp, 'old-schema', 'opencode.db');
  const db = buildDb(other, SCHEMA.replace('tokens_reasoning INTEGER, ', ''));
  db.close();
  const res = load(ref({ opencodeDbPath: other }));
  assert.equal(res.source, 'none');
  assert.equal(res.sources.native.available, false);
  assert.equal(res.sources.native.reason, 'UNSUPPORTED_SCHEMA');
  const list = listLmharnessSessions(other);
  assert.deepEqual([list.available, list.reason, list.sessions.length], [false, 'UNSUPPORTED_SCHEMA', 0]);
});

test('db: a missing file, or one not named opencode.db, is OPENCODE_DB_MISSING', () => {
  for (const p of [path.join(tmp, 'absent', 'opencode.db'), path.join(tmp, 'x.sqlite'), '']) {
    const res = load(ref({ opencodeDbPath: p || null }));
    assert.equal(res.sources.native.reason, 'OPENCODE_DB_MISSING', `path=${p}`);
  }
  assert.deepEqual(listLmharnessSessions(path.join(tmp, 'absent', 'opencode.db')),
    { available: false, reason: 'OPENCODE_DB_MISSING', sessions: [] });
});

test('db: an invalid session id is refused before any query; an unknown one is SESSION_NOT_FOUND', { skip: SKIP_DB }, () => {
  for (const sid of ["ses_x' OR 1=1 --", '../../etc/passwd', 'ses_short', `${S_OK} `]) {
    const res = load(ref({ sessionId: sid }));
    assert.equal(res.sources.native.reason, 'SESSION_NOT_FOUND', `sid=${sid}`);
    assert.deepEqual(res.events, []);
  }
  assert.equal(load(ref({ sessionId: 'ses_ZZZZZZZZZZZZZZZZnone01' })).sources.native.reason, 'SESSION_NOT_FOUND');
  assert.equal(load(ref({ sessionId: null })).sources.native.reason, 'NO_SESSION_ID');
});
