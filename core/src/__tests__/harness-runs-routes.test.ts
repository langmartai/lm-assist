import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * GET /harness/runners, /harness/runs, /harness/runs/:id{,/transcript,/debug}.
 *
 * Records are seeded straight into the store (and one legacy qwen dir for the
 * backfill), so no harness CLI runs. The OpenCode DB is pointed at a path that
 * does not exist and LM_ASSIST_DATA_DIR at a temp dir: nothing here reads the
 * operator's real data. A synthetic key is planted in every field a record, a
 * capture or a debug log can carry, and must never come back out of a handler.
 */

import {
  createHarnessRoutes,
  handleRunDebug,
  handleRunGet,
  handleRunners,
  handleRunsList,
  handleRunTranscript,
} from '../routes/core/harness.routes';
import { registerHarness } from '../harness/registry';
import { createQwenHarness } from '../harness/qwen';
import { createOpencodeHarness } from '../harness/opencode';
import { startRun } from '../harness/run-store';
import { harnessRunsRoot, legacyRunsRoot, runIndexFile } from '../harness/run-paths';
import type { AgentHarness } from '../harness/types';
import type { HarnessRunRecord } from '../harness/run-types';
import type { ParsedRequest } from '../routes/index';

const SENTINEL = 'sk-test-SENTINEL-0000000000000000';
const DEBUG_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let base: string;
let dataDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['LM_ASSIST_DATA_DIR', 'LM_ASSIST_PROD', 'LM_HARNESS_BASE_URL', 'LM_HARNESS_API_KEY', 'LM_HARNESS_MODEL', 'LM_HARNESS_OPENCODE_DB'];
let probeCalls = 0;

before(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runs-routes-'));
  process.env.LM_HARNESS_OPENCODE_DB = path.join(base, 'no-opencode', 'opencode.db');
  dataDir = fs.mkdtempSync(path.join(base, 'data-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;

  registerHarness(createQwenHarness());
  registerHarness(createOpencodeHarness());
  const spy: AgentHarness = {
    id: 'spyh',
    displayName: 'Spy Harness',
    capabilities: {
      cost: 'unavailable', sessionResume: false, mcp: false, permissionBroker: false,
      durableBackground: false, usesProviderProfile: false, abortable: false,
    },
    async execute() { throw new Error('not run here'); },
    async probe() { probeCalls += 1; throw new Error('the runners summary must never probe'); },
  };
  registerHarness(spy);

  seed();
});

after(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(base, { recursive: true, force: true });
});

function rec(over: Partial<HarnessRunRecord>): HarnessRunRecord {
  const now = Date.now();
  return {
    v: 1, id: 'x', executionId: over.id ?? 'x', runner: 'qwen', origin: 'recorded', inferred: false,
    core: 'dev', corePid: 99_999_999, status: 'succeeded', background: false,
    promptPreview: 'p', promptChars: 1, cwd: '/w', cwdDefaulted: false, model: 'vendor/model:free',
    providerProfile: 'gw', baseUrlHost: 'gw.example', timeoutMs: 900000, maxTurns: null, maxTurnsEnforced: true,
    startedAt: now - 5000, endedAt: now - 4000, durationMs: 1000, costUsd: null, runDir: null, updatedAt: now,
    ...over,
  };
}

/** A recorded qwen run with a capture, a prompt and a debug log — each carrying the sentinel. */
function seed(): void {
  const runDir = path.join(harnessRunsRoot(), 'qwen-run-1');
  fs.mkdirSync(path.join(runDir, 'qwen-home', 'debug'), { recursive: true });
  const frames = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: DEBUG_UUID }),
    JSON.stringify({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: `the key is ${SENTINEL}` }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE' }),
  ];
  fs.writeFileSync(path.join(runDir, 'stdout.log'), frames.map((f, i) => `${Date.now() + i}\t${f}\n`).join(''), { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), `prompt with ${SENTINEL}`, { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, 'qwen-home', 'debug', `${DEBUG_UUID}.txt`), `2026-09-23T00:00:00Z [DEBUG] key ${SENTINEL}\n`);

  startRun(rec({
    id: 'qwen-run-1',
    runDir: 'harness-runs-dev/qwen-run-1',
    sessionId: DEBUG_UUID,
    native: { kind: 'qwen-chat' },
    // An older record written before redaction existed must still leave redacted.
    promptPreview: `prompt with ${SENTINEL}`,
    resultPreview: `result ${SENTINEL}`,
    error: `error ${SENTINEL}`,
    capture: { bytes: 300, lines: 3, truncated: false },
  }));
  startRun(rec({
    id: 'oc-run-1',
    runner: 'opencode',
    sessionId: 'ses_AbCdEf123456789',
    maxTurnsEnforced: false,
    native: { kind: 'opencode-db', dbPath: process.env.LM_HARNESS_OPENCODE_DB },
  }));
}

const fullJson = (v: unknown) => JSON.stringify(v);

test('route order: the literal paths are not captured by the /:id patterns', async () => {
  const routes = createHarnessRoutes({} as any);
  const call = async (method: string, p: string) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(p));
    assert.ok(route, `no route for ${method} ${p}`);
    const m = route!.pattern.exec(p)!;
    const req: ParsedRequest = { method, path: p, params: (m.groups ?? {}) as Record<string, string>, query: {}, body: {}, clientIp: '127.0.0.1' };
    return route!.handler(req, {} as any);
  };

  assert.ok(Array.isArray((await call('GET', '/harness/runners')).data.runners));
  assert.ok(Array.isArray((await call('GET', '/harness/runs')).data.runs));
  assert.equal((await call('GET', '/harness/runs/qwen-run-1')).data.run.id, 'qwen-run-1');
  assert.ok(Array.isArray((await call('GET', '/harness/runs/qwen-run-1/transcript')).data.events));
  assert.ok(Array.isArray((await call('GET', '/harness/runs/qwen-run-1/debug')).data.lines));

  const missing = await call('GET', '/harness/runs/no-such-run');
  assert.equal(missing.success, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.equal(missing.httpStatus, 404, 'a 404 must survive the wrapper, else rest-server sends 400');

  const bad = await call('GET', '/harness/runs/..%2Fx');
  assert.equal(bad.error.code, 'INVALID_ID');
  assert.equal(bad.httpStatus, 400);
});

test('an invalid id is a 400 INVALID_ID and never touches the store', () => {
  for (const id of ['..%2Fx', '..%2F..%2Fetc', 'a.b', '', '%E0%A4%A', 'x%00y']) {
    for (const res of [handleRunGet(id), handleRunTranscript(id), handleRunDebug(id)]) {
      assert.equal(res.success, false, id);
      assert.equal(res.error!.code, 'INVALID_ID', id);
      assert.equal(res.httpStatus, 400, id);
    }
  }
});

test('an unknown run is a 404 NOT_FOUND that says where it might have gone', () => {
  const res = handleRunGet('never-recorded');
  assert.equal(res.error!.code, 'NOT_FOUND');
  assert.equal(res.httpStatus, 404);
  assert.match(res.error!.message, /retention|other/);
});

test('an unknown filter value is refused LOUDLY and the value is echoed', () => {
  const st = handleRunsList({ status: 'succeeded,bogus-status' });
  assert.equal(st.error!.code, 'INVALID_QUERY');
  assert.equal(st.httpStatus, 400);
  assert.match(st.error!.message, /bogus-status/);

  const rn = handleRunsList({ runner: 'no-such-runner' });
  assert.equal(rn.error!.code, 'INVALID_QUERY');
  assert.match(rn.error!.message, /no-such-runner/);

  assert.match(handleRunsList({ since: 'yesterday' }).error!.message, /yesterday/);
  assert.match(handleRunTranscript('qwen-run-1', { source: 'raw' }).error!.message, /raw/);
});

test('the list: rows, counts and clamped paging', () => {
  const res = handleRunsList({ limit: '1' });
  assert.equal(res.success, true);
  const data = res.data as any;
  assert.equal(data.core, 'dev');
  assert.equal(data.runs.length, 1);
  assert.ok(data.counts.total >= 2);
  assert.equal(data.nextOffset, 1);
  assert.equal(data.runs[0].runnerDisplayName.length > 0, true);

  const clamped = handleRunsList({ limit: '100000', offset: '-5' }).data as any;
  assert.equal(clamped.runs.length, clamped.counts.matched);
  assert.equal((handleRunsList({ runner: 'opencode' }).data as any).runs[0].id, 'oc-run-1');
  assert.equal((handleRunsList({ since: '24h' }).data as any).counts.matched >= 2, true);
});

test('detail: derived status, abortable only when live, sources — and the DB path is never served', () => {
  const res = handleRunGet('oc-run-1');
  assert.equal(res.success, true);
  const data = res.data as any;
  assert.equal(data.status, 'succeeded');
  assert.equal(data.live, false);
  assert.equal(data.abortable, false);
  assert.deepEqual(data.run.native, { kind: 'opencode-db' });
  assert.equal(fullJson(res).includes(process.env.LM_HARNESS_OPENCODE_DB!), false, 'the absolute DB locator stays inside Core');
  assert.equal(data.sources.native.available, false);

  const interrupted = rec({ id: 'dead-owner', status: 'running', endedAt: undefined, durationMs: undefined, pid: 99_999_998 });
  startRun(interrupted);
  const d = handleRunGet('dead-owner').data as any;
  assert.equal(d.status, 'interrupted');
  assert.equal(d.run.status, 'running', 'the record keeps what was persisted; the top-level status is derived');
  assert.equal(d.childAlive, process.platform === 'linux' ? false : d.childAlive);
});

test('transcript: a matching ifVersion answers unchanged with no events', () => {
  const first = handleRunTranscript('qwen-run-1', { source: 'captured' });
  assert.equal(first.success, true);
  const page = first.data as any;
  assert.equal(page.source, 'captured');
  assert.ok(page.events.length > 0);
  assert.ok(page.version);

  const again = handleRunTranscript('qwen-run-1', { source: 'captured', ifVersion: page.version });
  const d = again.data as any;
  assert.equal(d.unchanged, true);
  assert.deepEqual(d.events, []);
  assert.equal(d.version, page.version);

  const stale = handleRunTranscript('qwen-run-1', { source: 'captured', ifVersion: 'c:0:0' }).data as any;
  assert.equal(stale.unchanged, undefined);
  assert.ok(stale.events.length > 0);
});

test('a capture that hit the byte cap is served as sources.captured.truncated — the file itself cannot say so', () => {
  const runDir = path.join(harnessRunsRoot(), 'qwen-capped');
  fs.mkdirSync(runDir, { recursive: true });
  const frame = JSON.stringify({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'partial' }] } });
  fs.writeFileSync(path.join(runDir, 'stdout.log'), `${Date.now()}\t${frame}\n`, { mode: 0o600 });
  startRun(rec({ id: 'qwen-capped', runDir: 'harness-runs-dev/qwen-capped', capture: { bytes: 8 * 1024 * 1024, lines: 1, truncated: true } }));

  assert.equal((handleRunGet('qwen-capped').data as any).sources.captured.truncated, true);
  const page = handleRunTranscript('qwen-capped', { source: 'captured' }).data as any;
  assert.equal(page.sources.captured.truncated, true);
  const unchanged = handleRunTranscript('qwen-capped', { source: 'captured', ifVersion: page.version }).data as any;
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.sources.captured.truncated, true);

  assert.equal((handleRunGet('qwen-run-1').data as any).sources.captured.truncated, undefined, 'a complete capture is not flagged');
});

test('debug is qwen-only: an opencode run is a 404 NOT_APPLICABLE', () => {
  const res = handleRunDebug('oc-run-1');
  assert.equal(res.error!.code, 'NOT_APPLICABLE');
  assert.equal(res.httpStatus, 404);

  const q = handleRunDebug('qwen-run-1', { lines: '5000' });
  assert.equal(q.success, true);
  assert.equal((q.data as any).available, true);
});

test('runners: every runner is listed, builtins are not recorded, and NOTHING is probed', () => {
  probeCalls = 0;
  const res = handleRunners({ days: '9999' });
  assert.equal(res.success, true);
  const data = res.data as any;
  assert.equal(data.windowDays, 365, 'days is clamped');
  assert.equal(probeCalls, 0, 'a polled summary must never spawn the CLIs');

  const byId = Object.fromEntries(data.runners.map((r: any) => [r.id, r]));
  for (const id of ['sdk', 'tmux']) {
    assert.equal(byId[id].recorded, false);
    assert.equal(byId[id].pluggable, false);
    assert.equal(byId[id].stats, null);
    assert.match(byId[id].note, /Claude Code sessions/);
  }
  assert.equal(byId.qwen.displayName, 'Qwen Code');
  assert.equal(byId.qwen.recorded, true);
  assert.equal(byId.qwen.maxTurnsEnforced, true);
  assert.equal(byId.opencode.maxTurnsEnforced, false);
  assert.match(byId.opencode.isolation, /shares/);
  assert.ok(byId.qwen.stats.total >= 1);
  assert.equal(byId.qwen.profile, null, 'no profile configured in this data dir');
  assert.equal(byId.spyh.displayName, 'Spy Harness');
});

test('no handler response ever carries the synthetic key', () => {
  const responses = [
    handleRunsList(),
    handleRunners(),
    handleRunGet('qwen-run-1'),
    handleRunTranscript('qwen-run-1'),
    handleRunTranscript('qwen-run-1', { source: 'captured', maxField: '65536' }),
    handleRunTranscript('qwen-run-1', { source: 'native' }),
    handleRunDebug('qwen-run-1'),
  ];
  for (const r of responses) {
    assert.equal(r.success, true, fullJson(r.error));
    assert.equal(fullJson(r).includes('SENTINEL'), false, `leaked by ${fullJson(r).slice(0, 120)}`);
  }
});

test('backfill runs once, on dev only, is idempotent, and tightens legacy dirs', () => {
  // A fresh data dir with one pre-recorder qwen run dir (no chat file => not_started).
  const dev = fs.mkdtempSync(path.join(base, 'backfill-'));
  process.env.LM_ASSIST_DATA_DIR = dev;
  const startedAt = Date.now() - 60_000;
  const legacyId = `agent-${startedAt}-abcdef`;
  const legacyDir = path.join(legacyRunsRoot(), legacyId);
  fs.mkdirSync(path.join(legacyDir, 'qwen-home', 'debug'), { recursive: true, mode: 0o775 });
  fs.chmodSync(legacyDir, 0o775);
  fs.mkdirSync(path.join(legacyRunsRoot(), 'not.an.id', 'qwen-home'), { recursive: true });
  fs.mkdirSync(path.join(legacyRunsRoot(), 'no-qwen-home'), { recursive: true });

  try {
    const first = handleRunsList().data as any;
    assert.equal(first.backfill.done, true);
    assert.equal(first.backfill.qwen, 1);
    assert.equal(first.backfill.opencode, 0, 'no OpenCode DB here — and its absence is not a warning');
    assert.deepEqual(first.backfill.warnings, []);
    const row = first.runs.find((r: any) => r.id === legacyId);
    assert.equal(row.origin, 'backfill');
    assert.equal(row.inferred, true);
    assert.equal(row.startedAt, startedAt, 'the start time comes from the id');
    assert.equal(fs.statSync(legacyDir).mode & 0o777, 0o700, 'legacy dirs hold transcripts; they are tightened');

    const second = handleRunsList().data as any;
    assert.equal(second.counts.total, first.counts.total, 'a second request must not backfill again');
    assert.equal(second.backfill.at, first.backfill.at);
    assert.equal((handleRunners().data as any).runners.find((r: any) => r.id === 'qwen').stats.total, 1);
    assert.equal(fs.readFileSync(runIndexFile(), 'utf8').split('\n').filter((l) => l.includes('"op":"meta"')).length, 1);

    // The same layout under a prod Core: nothing is backfilled.
    const prod = fs.mkdtempSync(path.join(base, 'backfill-prod-'));
    process.env.LM_ASSIST_DATA_DIR = prod;
    process.env.LM_ASSIST_PROD = 'true';
    fs.mkdirSync(path.join(legacyRunsRoot(), legacyId, 'qwen-home'), { recursive: true });
    const p = handleRunsList().data as any;
    assert.equal(p.core, 'prod');
    assert.equal(p.counts.total, 0, 'prod never backfills');
    assert.equal(p.backfill.qwen, 0);
    assert.equal(fs.existsSync(runIndexFile()), false, 'and writes no index just for having been asked');
  } finally {
    delete process.env.LM_ASSIST_PROD;
    process.env.LM_ASSIST_DATA_DIR = dataDir;
  }
});

test('backfill carries tool counts by name from the native transcript — a backfilled run is never enriched later', () => {
  const dev = fs.mkdtempSync(path.join(base, 'backfill-tools-'));
  process.env.LM_ASSIST_DATA_DIR = dev;
  const t0 = Date.now() - 60_000;
  const legacyId = `agent-${t0}-tools1`;
  const sid = '1b1b1b1b-2c2c-4d3d-8e4e-5f5f5f5f5f5f';
  const chats = path.join(legacyRunsRoot(), legacyId, 'qwen-home', 'projects', '-w', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const records = [
    { type: 'user', message: { role: 'user', parts: [{ text: 'write hello.txt' }] } },
    { type: 'assistant', model: 'vendor/model:free', message: { role: 'model', parts: [{ functionCall: { id: 'w1', name: 'write_file', args: { file_path: '/w/hello.txt', content: 'PONG' } } }] } },
    { type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'w1', name: 'write_file', response: { output: 'ok' } } }] }, toolCallResult: { callId: 'w1', status: 'success', resultDisplay: '' } },
    { type: 'assistant', model: 'vendor/model:free', message: { role: 'model', parts: [{ text: 'DONE' }] } },
  ];
  const lines = records.map((r, i) => JSON.stringify({
    uuid: `r${i}`, parentUuid: i ? `r${i - 1}` : null, sessionId: sid,
    timestamp: new Date(t0 + i * 1000).toISOString(), cwd: '/w', version: '0.0.0-test', ...r,
  }));
  fs.writeFileSync(path.join(chats, `${sid}.jsonl`), `${lines.join('\n')}\n`);

  try {
    const list = handleRunsList().data as any;
    assert.equal(list.backfill.qwen, 1);
    const qwen = (handleRunners().data as any).runners.find((r: any) => r.id === 'qwen');
    assert.deepEqual(qwen.stats.topTools, [{ name: 'write_file', count: 1 }]);
    assert.equal(qwen.stats.toolErrors, 0);
    assert.equal(list.runs.find((r: any) => r.id === legacyId).toolCalls, 1);
  } finally {
    process.env.LM_ASSIST_DATA_DIR = dataDir;
  }
});

test('backfill stores the FULL prompt length of a legacy run, not the length of its 300-char preview', () => {
  const dev = fs.mkdtempSync(path.join(base, 'backfill-chars-'));
  process.env.LM_ASSIST_DATA_DIR = dev;
  const t0 = Date.now() - 60_000;
  const legacyId = `agent-${t0}-chars1`;
  const sid = '2c2c2c2c-3d3d-4e4e-8f5f-6a6a6a6a6a6a';
  const chats = path.join(legacyRunsRoot(), legacyId, 'qwen-home', 'projects', '-w', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const prompt = `${'long_prompt_'.repeat(100)}end`;
  const records = [
    { type: 'user', message: { role: 'user', parts: [{ text: prompt }] } },
    { type: 'assistant', model: 'vendor/model:free', message: { role: 'model', parts: [{ text: 'DONE' }] } },
  ];
  fs.writeFileSync(path.join(chats, `${sid}.jsonl`), `${records.map((r, i) => JSON.stringify({
    uuid: `r${i}`, parentUuid: i ? `r${i - 1}` : null, sessionId: sid,
    timestamp: new Date(t0 + i * 1000).toISOString(), cwd: '/w', version: '0.0.0-test', ...r,
  })).join('\n')}\n`);
  try {
    assert.equal((handleRunsList().data as any).backfill.qwen, 1);
    const run = (handleRunGet(legacyId).data as any).run;
    assert.equal(run.promptChars, prompt.length);
    assert.equal(run.promptPreview.length, 300);
  } finally {
    process.env.LM_ASSIST_DATA_DIR = dataDir;
  }
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let Sqlite: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Sqlite = require('better-sqlite3');
  new Sqlite(':memory:').close();
} catch {
  Sqlite = null;
}

/** A scratch opencode.db (measured 1.18.29 column names) holding lmharness sessions created at `times`. */
function scratchOpencodeDb(dir: string, sessions: Array<{ id: string; at: number }>): string {
  const file = path.join(dir, 'share', 'opencode.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Sqlite(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, model TEXT, agent TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  for (const s of sessions) {
    db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?, 1, 1, 0, 0, 0, ?, ?)')
      .run(s.id, '/w', 't', '0.0.0-test', JSON.stringify({ id: 'vendor/model:free', providerID: 'lmharness' }), 'build', s.at, s.at + 10);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`msg_${s.id}`, s.id, s.at, s.at, JSON.stringify({ role: 'user', time: { created: s.at } }));
  }
  db.close();
  return file;
}

test('OpenCode backfill takes only sessions older than any recorder — not prod\'s runs, not a dev run whose session id is not sniffed yet', { skip: Sqlite ? false : 'no better-sqlite3 binding' }, () => {
  const now = Date.now();
  const OLD = 'ses_OOOOOOOOOOOOOOOOlegacy1';
  const PROD = 'ses_PPPPPPPPPPPPPPPPprodrun';
  const LATE = 'ses_LLLLLLLLLLLLLLLLinflite';
  const savedDb = process.env.LM_HARNESS_OPENCODE_DB;
  try {
    // 1) A prod Core has recorded an opencode run (in ITS index); this dev index is fresh.
    const dev1 = fs.mkdtempSync(path.join(base, 'oc-owner-'));
    process.env.LM_ASSIST_DATA_DIR = dev1;
    process.env.LM_HARNESS_OPENCODE_DB = scratchOpencodeDb(dev1, [
      { id: OLD, at: now - 100_000 }, { id: PROD, at: now - 49_000 }, { id: LATE, at: now - 8_000 },
    ]);
    const prodRec = rec({ id: 'prod-oc-1', runner: 'opencode', core: 'prod', startedAt: now - 50_000, sessionId: PROD, native: { kind: 'opencode-db' } });
    fs.writeFileSync(path.join(dev1, 'harness-runs-index.jsonl'), `${JSON.stringify({ op: 'start', at: now, rec: prodRec })}\n`, { mode: 0o600 });
    const a = handleRunsList().data as any;
    assert.equal(a.backfill.opencode, 1, 'only the session older than every recorder is legacy');
    assert.ok(a.runs.some((r: any) => r.id === `oc-${OLD}`));
    assert.equal(a.runs.some((r: any) => r.id === `oc-${PROD}` || r.id === `oc-${LATE}`), false);

    // 2) No prod index; a dev run is in flight and its session exists but is not sniffed yet.
    const dev2 = fs.mkdtempSync(path.join(base, 'oc-inflight-'));
    process.env.LM_ASSIST_DATA_DIR = dev2;
    process.env.LM_HARNESS_OPENCODE_DB = scratchOpencodeDb(dev2, [{ id: OLD, at: now - 100_000 }, { id: LATE, at: now - 8_000 }]);
    startRun(rec({ id: 'dev-oc-live', runner: 'opencode', status: 'running', endedAt: undefined, startedAt: now - 10_000, native: { kind: 'opencode-db' } }));
    const b = handleRunsList().data as any;
    assert.equal(b.backfill.opencode, 1);
    assert.equal(b.runs.some((r: any) => r.id === `oc-${LATE}`), false, 'no duplicate "aborted" row for a run in flight');
  } finally {
    if (savedDb === undefined) delete process.env.LM_HARNESS_OPENCODE_DB; else process.env.LM_HARNESS_OPENCODE_DB = savedDb;
    process.env.LM_ASSIST_DATA_DIR = dataDir;
  }
});

test('a configured non-sk key straddling the maxField cut of a NATIVE transcript never comes out, in whole or in part', () => {
  const KEY = 'gwlive0123456789abcdefghij0123456789ABCD';
  const savedKey = process.env.LM_HARNESS_API_KEY;
  process.env.LM_HARNESS_API_KEY = KEY;
  const sid = '3d3d3d3d-4e4e-4f5f-8a6a-7b7b7b7b7b7b';
  const runDir = path.join(harnessRunsRoot(), 'qwen-keyrun');
  const chats = path.join(runDir, 'qwen-home', 'projects', '-w', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const keyStart = 3990;
  const output = `${'o'.repeat(keyStart - 'OPENAI_API_KEY='.length)}OPENAI_API_KEY=${KEY}\nPATH=/usr/bin`;
  const t0 = Date.now() - 30_000;
  const records = [
    { type: 'user', message: { role: 'user', parts: [{ text: 'run env' }] } },
    { type: 'assistant', model: 'vendor/model:free', message: { role: 'model', parts: [{ functionCall: { id: 'e1', name: 'run_shell_command', args: { command: 'env' } } }] } },
    { type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'e1', name: 'run_shell_command', response: { output } } }] }, toolCallResult: { callId: 'e1', status: 'success' } },
  ];
  fs.writeFileSync(path.join(chats, `${sid}.jsonl`), `${records.map((r, i) => JSON.stringify({
    uuid: `k${i}`, parentUuid: i ? `k${i - 1}` : null, sessionId: sid,
    timestamp: new Date(t0 + i * 1000).toISOString(), cwd: '/w', version: '0.0.0-test', ...r,
  })).join('\n')}\n`);
  startRun(rec({ id: 'qwen-keyrun', runDir: 'harness-runs-dev/qwen-keyrun', sessionId: sid, native: { kind: 'qwen-chat' } }));
  try {
    for (const maxField of [4000, keyStart + KEY.length - 1, keyStart + 12, 65536]) {
      const r = handleRunTranscript('qwen-keyrun', { source: 'native', maxField: String(maxField) });
      assert.equal(r.success, true);
      assert.equal((r.data as any).source, 'qwen-chat');
      const blob = fullJson(r);
      for (let n = 8; n <= KEY.length; n++) {
        assert.equal(blob.includes(KEY.slice(0, n)), false, `a ${n}-char head of the key leaked at maxField=${maxField}`);
      }
    }
  } finally {
    if (savedKey === undefined) delete process.env.LM_HARNESS_API_KEY; else process.env.LM_HARNESS_API_KEY = savedKey;
  }
});
