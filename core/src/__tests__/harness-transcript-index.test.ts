import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The transcript entry point: which source `auto` picks, paging, the per-field
 * cap, the version token a poll uses to skip an unchanged transcript, and the
 * enrichment the recorder stamps on a finished run.
 *
 * Source choice is the part that goes wrong quietly: a live run must show the
 * growing capture (the CLI's own store is incomplete until it exits), and a
 * finished one the richer native store — falling back, never failing, when a
 * source is missing. Fixtures are synthetic; the opencode cells use a scratch
 * DB and are skipped where better-sqlite3 has no binding.
 */

import {
  loadTranscript,
  resolveTranscriptSource,
  transcriptVersion,
  summarizeRun,
  type TranscriptSourceRef,
  type ToolEvent,
} from '../harness/transcript';

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

const T0 = 1_800_000_000_000;
const QSID = '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e';
const OSID = 'ses_0123456789abcdefINDEX1';
const MODEL = 'vendor-x/test-model:free';

before(() => {
  savedDataDir = process.env.LM_ASSIST_DATA_DIR;
  savedOcDb = process.env.LM_HARNESS_OPENCODE_DB;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-transcript-index-'));
  process.env.LM_ASSIST_DATA_DIR = path.join(tmp, 'data');
  dbPath = path.join(tmp, 'share', 'opencode', 'opencode.db');
  process.env.LM_HARNESS_OPENCODE_DB = dbPath;
  if (Database) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, model TEXT, agent TEXT,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?, 1, 1, 0, 0, 0, ?, ?)')
      .run(OSID, '/work/oc', 'Synthetic', '0.0.0-test', JSON.stringify({ id: MODEL, providerID: 'lmharness' }), 'build', T0, T0 + 10);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_1', OSID, T0, T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('prt_1', 'msg_1', OSID, T0, T0, JSON.stringify({ type: 'text', text: '"native prompt"' }));
    db.close();
  }
});

after(() => {
  if (savedDataDir === undefined) delete process.env.LM_ASSIST_DATA_DIR;
  else process.env.LM_ASSIST_DATA_DIR = savedDataDir;
  if (savedOcDb === undefined) delete process.env.LM_HARNESS_OPENCODE_DB;
  else process.env.LM_HARNESS_OPENCODE_DB = savedOcDb;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let dirSeq = 0;
function newRunDir(): string {
  const d = path.join(tmp, `run-${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeFrames(file: string, frames: unknown[]): void {
  fs.writeFileSync(file, frames.map((f, i) => `${T0 + i}\t${JSON.stringify(f)}`).join('\n') + '\n');
}

const qAsst = (uuid: string, content: unknown[], u = { input_tokens: 10, output_tokens: 1 }) =>
  ({ type: 'assistant', uuid, session_id: QSID, message: { id: uuid, model: MODEL, content, usage: u } });

/** A qwen run dir with a capture (and optionally a chat file). */
function qwenRun(opts: { chat: boolean; capture?: boolean }): TranscriptSourceRef {
  const dir = newRunDir();
  const capturePath = path.join(dir, 'stdout.log');
  const promptPath = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptPath, 'captured prompt');
  if (opts.capture !== false) {
    writeFrames(capturePath, [
      { type: 'system', subtype: 'init', session_id: QSID, model: MODEL, qwen_code_version: '0.0.0-test' },
      qAsst('a1', [{ type: 'text', text: 'hi' }]),
    ]);
  }
  if (opts.chat) {
    const chats = path.join(dir, 'qwen-home', 'projects', '-w', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, `${QSID}.jsonl`), [
      { uuid: 'r0', parentUuid: null, sessionId: QSID, timestamp: new Date(T0).toISOString(), type: 'user', cwd: '/w', version: '0.0.0-test', message: { role: 'user', parts: [{ text: 'native prompt\n\n' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return {
    runner: 'qwen', runDir: dir, capturePath, promptPath, sessionId: QSID,
    opencodeDbPath: null, live: false, startedAt: T0,
  };
}

function opencodeRun(opts: { db: 'ok' | 'missing' | 'no-session'; capture?: boolean }): TranscriptSourceRef {
  const dir = newRunDir();
  const capturePath = path.join(dir, 'stdout.log');
  const promptPath = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptPath, 'captured prompt');
  if (opts.capture !== false) {
    writeFrames(capturePath, [
      { type: 'step_start', sessionID: OSID, part: { type: 'step-start' } },
      { type: 'text', sessionID: OSID, part: { type: 'text', text: 'hi' } },
    ]);
  }
  return {
    runner: 'opencode', runDir: dir, capturePath, promptPath,
    sessionId: opts.db === 'no-session' ? null : OSID,
    opencodeDbPath: opts.db === 'missing' ? path.join(tmp, 'gone', 'opencode.db') : dbPath,
    live: false, startedAt: T0,
  };
}

const load = (r: TranscriptSourceRef, o: Partial<{ source: 'auto' | 'captured' | 'native'; offset: number; limit: number; maxField: number; redact: (s: string) => string }> = {}) =>
  loadTranscript(r, { source: 'auto', offset: 0, limit: 300, maxField: 4000, ...o });

// ─── source choice ───────────────────────────────────────────────────────────

test('auto source, qwen: live → captured; terminal → the chat file when it exists, else captured', () => {
  const withChat = qwenRun({ chat: true });
  const noChat = qwenRun({ chat: false });
  assert.equal(resolveTranscriptSource({ ...withChat, live: true }, 'auto').source, 'captured');
  assert.equal(resolveTranscriptSource({ ...noChat, live: true }, 'auto').source, 'captured');
  assert.equal(resolveTranscriptSource(withChat, 'auto').source, 'qwen-chat');
  const r = resolveTranscriptSource(noChat, 'auto');
  assert.equal(r.source, 'captured');
  assert.deepEqual(r.sources.native, { kind: 'qwen-chat', available: false, reason: 'NO_CHAT_FILE' });
  assert.equal(r.sources.captured.available, true);
  assert.ok((r.sources.captured.bytes ?? 0) > 0);

  // Live with nothing captured yet: whatever native exists.
  const noCapture = qwenRun({ chat: true, capture: false });
  assert.equal(resolveTranscriptSource({ ...noCapture, live: true }, 'auto').source, 'qwen-chat');

  // The source actually served matches the choice.
  const page = load(withChat);
  assert.equal(page.source, 'qwen-chat');
  assert.ok(page.events[0].kind === 'user' && page.events[0].text === 'native prompt');
  const livePage = load({ ...withChat, live: true });
  assert.ok(livePage.events[0].kind === 'user' && livePage.events[0].text === 'captured prompt');
});

test('auto source, opencode: live → captured; terminal → the DB when readable, else captured', { skip: SKIP_DB }, () => {
  const ok = opencodeRun({ db: 'ok' });
  assert.equal(resolveTranscriptSource({ ...ok, live: true }, 'auto').source, 'captured');
  assert.equal(resolveTranscriptSource(ok, 'auto').source, 'opencode-db');
  const page = load(ok);
  assert.equal(page.source, 'opencode-db');
  assert.ok(page.events[0].kind === 'user' && page.events[0].text === 'native prompt');

  const missing = resolveTranscriptSource(opencodeRun({ db: 'missing' }), 'auto');
  assert.equal(missing.source, 'captured');
  assert.equal(missing.sources.native.reason, 'OPENCODE_DB_MISSING');

  const noSid = resolveTranscriptSource(opencodeRun({ db: 'no-session' }), 'auto');
  assert.equal(noSid.source, 'captured');
  assert.equal(noSid.sources.native.reason, 'NO_SESSION_ID');

  // A backfilled session has no run dir and no capture at all.
  const backfill = { ...ok, runDir: null, capturePath: null, promptPath: null };
  assert.equal(resolveTranscriptSource(backfill, 'auto').source, 'opencode-db');
});

test('explicit sources fall back with a warning; a runner with no native store is captured-only', () => {
  const noChat = qwenRun({ chat: false });
  const native = load(noChat, { source: 'native' });
  assert.equal(native.source, 'captured');
  assert.ok(native.warnings.some((w) => w.startsWith('NATIVE_UNAVAILABLE: NO_CHAT_FILE')));

  const chatOnly = qwenRun({ chat: true, capture: false });
  const captured = load(chatOnly, { source: 'captured' });
  assert.equal(captured.source, 'qwen-chat');
  assert.ok(captured.warnings.some((w) => w.startsWith('CAPTURED_UNAVAILABLE')));

  const future = { ...qwenRun({ chat: false }), runner: 'future-cli' };
  const r = resolveTranscriptSource(future, 'auto');
  assert.equal(r.source, 'captured');
  assert.deepEqual(r.sources.native, { kind: null, available: false, reason: 'NOT_APPLICABLE' });

  const nothing: TranscriptSourceRef = { ...qwenRun({ chat: false, capture: false }), promptPath: null };
  const empty = load(nothing);
  assert.equal(empty.source, 'none');
  assert.deepEqual([empty.total, empty.events.length, empty.nextOffset], [0, 0, null]);
});

test('garbage refs never throw', () => {
  const file = path.join(tmp, 'plain-file');
  fs.writeFileSync(file, 'x');
  const bad: TranscriptSourceRef = {
    runner: 'qwen', runDir: file, capturePath: tmp, promptPath: tmp, sessionId: '../../x',
    opencodeDbPath: tmp, live: false, startedAt: NaN,
  };
  assert.equal(load(bad).source, 'none');
  assert.equal(load({ ...bad, runner: 'opencode' }).source, 'none');
  // Nothing could be read: the tool counts are UNKNOWN, not zero.
  const unread = summarizeRun(bad);
  assert.equal(unread.toolCalls, undefined);
  assert.equal(unread.toolErrors, undefined);
  assert.equal(unread.toolsByName, undefined);
  assert.equal(typeof transcriptVersion(bad, 'qwen-chat'), 'string');
  const weird = load(bad, { offset: -5, limit: 0, maxField: 1e9 });
  assert.equal(weird.offset, 0);
});

// ─── paging, caps, version ───────────────────────────────────────────────────

function manyTools(n: number, output = 'ok'): TranscriptSourceRef {
  const r = qwenRun({ chat: false, capture: false });
  const frames: unknown[] = [{ type: 'system', subtype: 'init', session_id: QSID }];
  for (let i = 0; i < n; i++) {
    frames.push(qAsst(`t${i}`, [{ type: 'tool_use', id: `c${i}`, name: 'read_file', input: { absolute_path: `/w/f${i}` } }]));
    frames.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: output }] } });
  }
  writeFrames(r.capturePath as string, frames);
  return { ...r, live: true };
}

test('offset/limit page through the whole list; seq is the index; nextOffset ends at null', () => {
  const r = manyTools(12); // user + lifecycle + 12 × (tool, turn) = 26 events
  const first = load(r, { limit: 10 });
  assert.equal(first.total, 26);
  assert.deepEqual(first.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(first.nextOffset, 10);
  const mid = load(r, { offset: 10, limit: 10 });
  assert.deepEqual([mid.events[0].seq, mid.nextOffset], [10, 20]);
  const last = load(r, { offset: 20, limit: 10 });
  assert.deepEqual([last.events.length, last.nextOffset, last.offset], [6, null, 20]);
  const past = load(r, { offset: 500 });
  assert.deepEqual([past.events.length, past.nextOffset, past.total], [0, null, 26]);
});

test('maxField cuts string leaves and replaces an oversize tool input; the cached parse stays whole', () => {
  const r = qwenRun({ chat: false, capture: false });
  writeFrames(r.capturePath as string, [
    qAsst('b1', [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { file_path: '/w/big.txt', content: 'z'.repeat(5000) } }]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'o'.repeat(3000) }] } },
    qAsst('b2', [{ type: 'tool_use', id: 'w2', name: 'read_file', input: { absolute_path: '/w/small' } }]),
  ]);
  const small = load(r, { maxField: 256 });
  assert.equal(small.truncated, true);
  const [big, tiny] = small.events.filter((e): e is ToolEvent => e.kind === 'tool');
  assert.equal(big.truncated, true);
  assert.equal(big.output?.length, 256);
  const input = big.input as { _truncated: boolean; preview: string; originalBytes: number };
  assert.equal(input._truncated, true);
  assert.equal(input.preview.length, 256);
  assert.equal(input.originalBytes, JSON.stringify({ file_path: '/w/big.txt', content: 'z'.repeat(5000) }).length);
  assert.deepEqual(tiny.input, { absolute_path: '/w/small' });
  assert.equal(tiny.truncated, undefined);
  const prompt = small.events[0];
  assert.ok(prompt.kind === 'user' && !prompt.truncated);

  const full = load(r, { maxField: 65536 });
  assert.equal(full.truncated, false);
  const again = full.events.find((e): e is ToolEvent => e.kind === 'tool');
  assert.equal(again?.output?.length, 3000);
  assert.equal((again?.input as { content: string }).content.length, 5000);
});

test('a cut text or reasoning event says so itself — the page flag alone let a cut answer look complete', () => {
  const r = qwenRun({ chat: false, capture: false });
  writeFrames(r.capturePath as string, [
    qAsst('t1', [{ type: 'thinking', thinking: 'h'.repeat(1000) }, { type: 'text', text: 'a'.repeat(1000) }]),
    { type: 'result', subtype: 'success', result: 'a'.repeat(1000) },
  ]);
  const small = load(r, { maxField: 256 });
  const text = small.events.find((e) => e.kind === 'text');
  const reasoning = small.events.find((e) => e.kind === 'reasoning');
  assert.ok(text && text.kind === 'text' && text.truncated === true && text.text.length === 256);
  assert.ok(reasoning && reasoning.kind === 'reasoning' && reasoning.truncated === true);
  const full = load(r, { maxField: 65536 });
  assert.equal(full.events.find((e) => e.kind === 'text')?.truncated, undefined);
  assert.equal(full.events.find((e) => e.kind === 'reasoning')?.truncated, undefined);
});

test('the redact hook runs BEFORE a field is cut, so a key straddling maxField cannot survive as a fragment', () => {
  const KEY = 'gw-live-0123456789abcdefghij0123456789';
  const redact = (x: string) => x.split(KEY).join('[REDACTED]');
  const r = qwenRun({ chat: false, capture: false });
  const pad = 'o'.repeat(240);
  writeFrames(r.capturePath as string, [
    qAsst('k1', [{ type: 'tool_use', id: 'e1', name: 'run_shell_command', input: { command: `echo ${pad}${KEY}` } }]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: `${pad}OPENAI_API_KEY=${KEY}` }] } },
  ]);
  for (const maxField of [256, 270, 300]) {
    const page = load(r, { maxField, redact });
    const blob = JSON.stringify(page.events);
    assert.ok(!blob.includes(KEY.slice(0, 12)), `no 12-char head of the key at maxField=${maxField}`);
  }
  // Without the hook the same cut WOULD leave a fragment — the reason the hook exists.
  const unhooked = JSON.stringify(load(r, { maxField: 270 }).events);
  assert.ok(unhooked.includes(KEY.slice(0, 12)));
});

test('a write or edit that FAILED is not a touched file', () => {
  const r = opencodeRun({ db: 'no-session' });
  const tool = (callID: string, name: string, status: string, input: unknown) =>
    ({ type: 'tool_use', sessionID: OSID, part: { type: 'tool', tool: name, callID, state: { status, input, ...(status === 'error' ? { error: 'oldString not found in content' } : {}) } } });
  writeFrames(r.capturePath as string, [
    { type: 'step_start', sessionID: OSID, part: {} },
    tool('f1', 'edit', 'error', { filePath: '/w/rejected.ts', oldString: 'x', newString: 'y' }),
    tool('f2', 'write', 'completed', { filePath: '/w/written.txt', content: 'x' }),
    { type: 'step_finish', sessionID: OSID, part: { reason: 'stop', tokens: { input: 1, output: 1 } } },
  ]);
  assert.deepEqual(summarizeRun(r).filesTouched, ['/w/written.txt']);
  assert.deepEqual(load(r).filesTouched, ['/w/written.txt']);
});

test('a page stops at the ~1 MB soft budget and says where to resume', () => {
  const r = manyTools(40, 'q'.repeat(60_000));
  const page = load(r, { limit: 1000, maxField: 65536 });
  assert.ok(page.events.length < page.total);
  assert.equal(page.nextOffset, page.events.length);
  assert.ok(JSON.stringify(page.events).length < 1.1 * 1024 * 1024);
});

test('version is stable while nothing changes, and moves when the capture grows', () => {
  const r = manyTools(2);
  const v1 = transcriptVersion(r, 'captured');
  assert.match(v1, /^c:\d+:[\d.]+$/);
  assert.equal(transcriptVersion(r, 'captured'), v1);
  const page = load(r);
  assert.equal(page.version, v1);
  const total = page.total;

  fs.appendFileSync(r.capturePath as string, `${T0 + 99}\t${JSON.stringify(qAsst('late', [{ type: 'text', text: 'more' }]))}\n`);
  const v2 = transcriptVersion(r, 'captured');
  assert.notEqual(v2, v1);
  const next = load(r);
  assert.equal(next.version, v2);
  assert.ok(next.total > total, 'the cache did not serve the old parse');

  const chat = qwenRun({ chat: true });
  assert.match(transcriptVersion(chat, 'qwen-chat'), /^q:\d+:[\d.]+$/);
  assert.equal(transcriptVersion(chat, 'none'), 'n:0');
});

test('opencode-db version is o:<time_updated>:<part count>', { skip: SKIP_DB }, () => {
  const ok = opencodeRun({ db: 'ok' });
  assert.equal(transcriptVersion(ok, 'opencode-db'), `o:${T0 + 10}:1`);
  assert.equal(load(ok).version, `o:${T0 + 10}:1`);
});

// ─── enrichment ──────────────────────────────────────────────────────────────

test('summarizeRun counts tools by native name, errors, files and reasoning tokens', () => {
  const r = opencodeRun({ db: 'no-session' });
  const tool = (callID: string, name: string, status: string, input: unknown) =>
    ({ type: 'tool_use', sessionID: OSID, part: { type: 'tool', tool: name, callID, state: { status, input } } });
  writeFrames(r.capturePath as string, [
    { type: 'step_start', sessionID: OSID, part: {} },
    tool('c1', 'read', 'completed', { filePath: '/w/a' }),
    tool('c2', 'read', 'error', { filePath: '/w/missing' }),
    tool('c3', 'write', 'completed', { filePath: '/w/out.txt', content: 'x' }),
    { type: 'step_finish', sessionID: OSID, part: { reason: 'tool-calls', tokens: { input: 10, output: 0, reasoning: 50 } } },
    { type: 'step_start', sessionID: OSID, part: {} },
    tool('c4', 'edit', 'completed', { filePath: '/w/a', oldString: 'a', newString: 'b' }),
    { type: 'step_finish', sessionID: OSID, part: { reason: 'stop', tokens: { input: 12, output: 3, reasoning: 30 } } },
  ]);
  const s = summarizeRun(r);
  assert.equal(s.toolCalls, 4);
  assert.equal(s.toolErrors, 1);
  assert.deepEqual(s.toolsByName, { read: 2, write: 1, edit: 1 });
  assert.deepEqual(Object.keys(s.toolsByName), ['read', 'edit', 'write'], 'most-used first, then by name');
  assert.deepEqual(s.filesTouched, ['/w/out.txt', '/w/a']);
  assert.equal(s.reasoningTokens, 80);
  assert.equal(s.sessionId, OSID);

  // qwen's stream reports no reasoning figure at all: null, not 0.
  const q = summarizeRun(manyTools(3));
  assert.equal(q.reasoningTokens, null);
  assert.deepEqual(q.toolsByName, { read_file: 3 });
  assert.equal(q.cliVersion, undefined);
  assert.equal(q.sessionId, QSID);
});
