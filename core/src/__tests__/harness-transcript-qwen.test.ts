import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * qwen transcript readers: the chat JSONL under a run's QWEN_HOME, the
 * captured stream-json, legacy-run inference and the debug-log tail.
 *
 * Every fixture is SYNTHETIC but shape-identical to what qwen 0.15.10 was
 * measured writing (record envelope, part kinds, telemetry names, the order
 * api_response → assistant → tool_call → tool_result). The two properties most
 * worth pinning are the ones that fail silently: usage summed from BOTH
 * usageMetadata and api_response telemetry double-counts a run, and a reader
 * that follows `debug/latest` reads wherever that symlink points.
 */

import {
  loadTranscript,
  summarizeRun,
  inferLegacyQwenRun,
  readQwenDebugTail,
  type TranscriptSourceRef,
  type HarnessEvent,
  type ToolEvent,
  type TurnEvent,
} from '../harness/transcript';
import { readCapture } from '../harness/transcript/capture';

let tmp: string;
let savedDataDir: string | undefined;
let savedOcDb: string | undefined;

before(() => {
  savedDataDir = process.env.LM_ASSIST_DATA_DIR;
  savedOcDb = process.env.LM_HARNESS_OPENCODE_DB;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-transcript-qwen-'));
  process.env.LM_ASSIST_DATA_DIR = path.join(tmp, 'data');
  process.env.LM_HARNESS_OPENCODE_DB = path.join(tmp, 'no-opencode', 'opencode.db');
});

after(() => {
  if (savedDataDir === undefined) delete process.env.LM_ASSIST_DATA_DIR;
  else process.env.LM_ASSIST_DATA_DIR = savedDataDir;
  if (savedOcDb === undefined) delete process.env.LM_HARNESS_OPENCODE_DB;
  else process.env.LM_HARNESS_OPENCODE_DB = savedOcDb;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SID = '0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e';
const CWD = '/work/demo';
const MODEL = 'vendor-x/test-model:free';
const T0 = Date.parse('2026-01-02T03:04:05.000Z');

let dirSeq = 0;
function runDir(): string {
  const d = path.join(tmp, `run-${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Records with the common envelope; parentUuid chains linearly, as qwen writes it. */
function writeChat(dir: string, records: Array<Record<string, unknown>>, sid = SID): string {
  const chats = path.join(dir, 'qwen-home', 'projects', '-work-demo', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  let prev: string | null = null;
  const lines = records.map((r, i) => {
    const uuid = (r.uuid as string) ?? `rec-${i}`;
    const line = {
      uuid, parentUuid: prev, sessionId: sid, timestamp: new Date(T0 + i * 1000).toISOString(),
      cwd: CWD, version: '0.0.0-test', ...r,
    };
    prev = uuid;
    return JSON.stringify(line);
  });
  const file = path.join(chats, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function writeDebug(dir: string, lines: string[], sid = SID): string {
  const dbg = path.join(dir, 'qwen-home', 'debug');
  fs.mkdirSync(dbg, { recursive: true });
  const file = path.join(dbg, `${sid}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.symlinkSync(`${sid}.txt`, path.join(dbg, 'latest'));
  return file;
}

const user = (text: string) => ({ type: 'user', message: { role: 'user', parts: [{ text }] } });
const snapshot = (files: string[]) => ({
  type: 'system', subtype: 'attribution_snapshot',
  systemPayload: { snapshot: { type: 'attribution-snapshot', version: 1, surface: 'cli',
    fileStates: Object.fromEntries(files.map((f) => [f, { aiContribution: 4, aiCreated: true, contentHash: 'h' }])),
    promptCount: 1, promptCountAtLastCommit: 0 } },
});
const apiResponse = (durationMs: number, input: number, output: number, thoughts: number) => ({
  type: 'system', subtype: 'ui_telemetry',
  systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', model: MODEL, status_code: 200,
    duration_ms: durationMs, input_token_count: input, output_token_count: output,
    cached_content_token_count: 0, thoughts_token_count: thoughts, total_token_count: input + output } },
});
const toolCall = (uuid: string, name: string, durationMs: number) => ({
  uuid, type: 'system', subtype: 'ui_telemetry',
  systemPayload: { uiEvent: { 'event.name': 'qwen-code.tool_call', function_name: name, duration_ms: durationMs,
    status: 'success', success: true, decision: 'auto_accept', tool_type: 'native' } },
});
const apiError = (errorType: string, message: string, statusCode?: number) => ({
  type: 'system', subtype: 'ui_telemetry',
  systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_error', model: MODEL, duration_ms: 3000,
    error_type: errorType, error_message: message, ...(statusCode ? { status_code: statusCode } : {}) } },
});
const usage = (prompt: number, cand: number, thoughts: number) => ({
  promptTokenCount: prompt, candidatesTokenCount: cand, thoughtsTokenCount: thoughts,
  totalTokenCount: prompt + cand, cachedContentTokenCount: 0,
});
const assistant = (parts: unknown[], u?: ReturnType<typeof usage>) => ({
  type: 'assistant', model: MODEL, message: { role: 'model', parts }, ...(u ? { usageMetadata: u } : {}),
});
const toolResult = (id: string, name: string, output: string, resultDisplay: unknown = '', status = 'success') => ({
  type: 'tool_result',
  message: { role: 'user', parts: [{ functionResponse: { id, name, response: { output } } }] },
  toolCallResult: { callId: id, status, resultDisplay },
});

function ref(dir: string, over: Partial<TranscriptSourceRef> = {}): TranscriptSourceRef {
  return {
    runner: 'qwen', runDir: dir, capturePath: null, promptPath: null, sessionId: null,
    opencodeDbPath: null, live: false, startedAt: T0, ...over,
  };
}

const load = (r: TranscriptSourceRef, source: 'auto' | 'captured' | 'native' = 'auto') =>
  loadTranscript(r, { source, offset: 0, limit: 1000, maxField: 65536 });

/** The successful two-turn run the chat tests share: write a file, then answer. */
function successfulChat(dir: string): void {
  writeChat(dir, [
    user('Create hello.txt containing PONG, then reply DONE.\n\n'),
    snapshot([]),
    apiResponse(2000, 100, 20, 7),
    assistant([
      { text: 'I should write the file.', thought: true },
      { functionCall: { id: 'write_file_abc123', name: 'write_file', args: { file_path: `${CWD}/hello.txt`, content: 'PONG' } } },
    ], usage(100, 20, 7)),
    toolCall('tc-1', 'write_file', 9),
    toolResult('write_file_abc123', 'write_file', 'Successfully created and wrote to new file.', {
      fileDiff: 'Index: hello.txt\n+PONG\n', fileName: 'hello.txt', originalContent: '', newContent: 'PONG',
      diffStat: { model_added_lines: 1, model_removed_lines: 0 },
    }),
    snapshot([`${CWD}/hello.txt`]),
    apiResponse(1000, 150, 3, 5),
    assistant([{ text: 'Done now.', thought: true }, { text: 'DONE' }], usage(150, 3, 5)),
  ]);
}

// ─── chat JSONL ──────────────────────────────────────────────────────────────

test('chat: thoughts become reasoning, a call and its response are ONE tool event with its diff', () => {
  const dir = runDir();
  successfulChat(dir);
  const res = load(ref(dir));
  assert.equal(res.source, 'qwen-chat');
  assert.deepEqual(res.events.map((e) => e.kind), ['user', 'reasoning', 'tool', 'turn', 'reasoning', 'text', 'turn']);
  assert.deepEqual(res.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6]);

  const tool = res.events[2] as ToolEvent;
  assert.equal(tool.name, 'write_file');
  assert.equal(tool.callId, 'write_file_abc123');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.nativeStatus, 'success');
  assert.equal(tool.output, 'Successfully created and wrote to new file.');
  assert.deepEqual(tool.input, { file_path: `${CWD}/hello.txt`, content: 'PONG' });
  assert.deepEqual(tool.diff, { patch: 'Index: hello.txt\n+PONG\n', file: 'hello.txt', added: 1, removed: 0 });
  assert.equal(tool.turn, 1);

  const text = res.events[5];
  assert.ok(text.kind === 'text' && text.final === true && text.text === 'DONE');
  assert.equal(res.cliVersion, '0.0.0-test');
  assert.equal(res.model, MODEL);
});

test('chat: the prompt loses its trailing "\\n\\n" (stdin framing), nothing else', () => {
  const dir = runDir();
  successfulChat(dir);
  const first = load(ref(dir)).events[0];
  assert.ok(first.kind === 'user');
  assert.equal(first.text, 'Create hello.txt containing PONG, then reply DONE.');
});

test('chat: the k-th api_response latency lands on the k-th turn; tool duration joins via parentUuid', () => {
  const dir = runDir();
  successfulChat(dir);
  const res = load(ref(dir));
  const turns = res.events.filter((e): e is TurnEvent => e.kind === 'turn');
  assert.deepEqual(turns.map((t) => t.latencyMs), [2000, 1000]);
  assert.deepEqual(turns.map((t) => t.turn), [1, 2]);
  assert.equal((res.events[2] as ToolEvent).durationMs, 9);
});

test('chat: a tool_call whose result does not point back at it falls to the next same-named tool', () => {
  const dir = runDir();
  writeChat(dir, [
    user('go'),
    assistant([{ functionCall: { id: 'read_file_1', name: 'read_file', args: { absolute_path: '/work/demo/a' } } }], usage(10, 1, 0)),
    toolCall('tc-x', 'read_file', 14),
    // An unrelated record in between breaks the parentUuid link.
    snapshot([]),
    toolResult('read_file_1', 'read_file', 'contents'),
  ]);
  const tool = load(ref(dir)).events.find((e): e is ToolEvent => e.kind === 'tool');
  assert.equal(tool?.durationMs, 14);
  assert.equal(tool?.diff, undefined, 'a read has resultDisplay "" and no diff');
});

test('chat: token usage is counted ONCE, from usageMetadata, never also from telemetry', () => {
  const dir = runDir();
  successfulChat(dir);
  const res = load(ref(dir));
  const turns = res.events.filter((e): e is TurnEvent => e.kind === 'turn');
  assert.deepEqual(turns[0].usage, { input: 100, output: 20, cacheRead: 0, reasoning: 7 });
  assert.deepEqual(turns[1].usage, { input: 150, output: 3, cacheRead: 0, reasoning: 5 });

  const legacy = inferLegacyQwenRun(dir);
  assert.deepEqual(legacy.usage, { input: 250, output: 23, reasoning: 12, cacheRead: 0, total: 273, reported: true });

  const sum = summarizeRun(ref(dir));
  assert.equal(sum.reasoningTokens, 12);
  assert.deepEqual(sum.toolsByName, { write_file: 1 });
  assert.equal(sum.toolCalls, 1);
  assert.equal(sum.toolErrors, 0);
  assert.equal(sum.cliVersion, '0.0.0-test');
  assert.equal(sum.model, MODEL);
  assert.equal(sum.sessionId, SID);
});

test('chat: api_error is HTML-stripped and cut to 300 chars', () => {
  const dir = runDir();
  const html = `500 <html><head><title>500 Internal Server Error</title><style>body{color:red}</style></head>` +
    `<body><h1>Internal &amp; Server Error</h1><p>${'x'.repeat(1000)}</p></body></html>`;
  writeChat(dir, [user('go'), apiError('InternalServerError', html, 500)]);
  const ev = load(ref(dir)).events.find((e) => e.kind === 'api_error');
  assert.ok(ev && ev.kind === 'api_error');
  assert.equal(ev.errorType, 'InternalServerError');
  assert.equal(ev.statusCode, 500);
  assert.equal(ev.durationMs, 3000);
  assert.ok(ev.message.length <= 300, `message is ${ev.message.length} chars`);
  assert.doesNotMatch(ev.message, /[<>]|color:red/);
  assert.match(ev.message, /^500 500 Internal Server Error Internal & Server Error x+$/);
});

test('chat: filesTouched is the LAST attribution snapshot unioned with write/edit inputs', () => {
  const dir = runDir();
  writeChat(dir, [
    user('go'),
    snapshot(['/work/demo/early.txt']),
    assistant([{ functionCall: { id: 'edit_1', name: 'edit', args: { file_path: '/work/demo/c.ts', old_string: 'a', new_string: 'b' } } }], usage(10, 1, 0)),
    toolResult('edit_1', 'edit', 'ok'),
    snapshot(['/work/demo/b.txt']),
    assistant([{ text: 'DONE' }], usage(12, 1, 0)),
  ]);
  const res = load(ref(dir));
  assert.deepEqual(res.filesTouched, ['/work/demo/b.txt', '/work/demo/c.ts']);
});

// ─── captured stream-json ────────────────────────────────────────────────────

function writeCapture(dir: string, frames: Array<Record<string, unknown> | string>, prompt = 'List the files.'): TranscriptSourceRef {
  const capturePath = path.join(dir, 'stdout.log');
  const promptPath = path.join(dir, 'prompt.txt');
  const body = frames.map((f, i) => `${T0 + i * 100}\t${typeof f === 'string' ? f : JSON.stringify(f)}`).join('\n') + '\n';
  fs.writeFileSync(capturePath, body);
  fs.writeFileSync(promptPath, prompt);
  return ref(dir, { capturePath, promptPath, live: true });
}

const sys = { type: 'system', subtype: 'init', session_id: SID, cwd: CWD, model: MODEL, qwen_code_version: '0.0.0-test' };
const asst = (uuid: string, content: unknown[], u?: Record<string, number>) => ({
  type: 'assistant', uuid, session_id: SID, parent_tool_use_id: null,
  message: { id: uuid, type: 'message', role: 'assistant', model: MODEL, content, usage: u ?? { input_tokens: 0, output_tokens: 0 } },
});
const toolRes = (content: unknown, toolUseId?: string, isError = false) => ({
  type: 'user', session_id: SID,
  message: { role: 'user', content: [{ type: 'tool_result', ...(toolUseId ? { tool_use_id: toolUseId } : {}), is_error: isError, content }] },
});

test('stream: thinking, text, tool_use; results pair by tool_use_id, else FIFO; is_error; turns dedupe', () => {
  const dir = runDir();
  const r = writeCapture(dir, [
    sys,
    // qwen emits a turn's thinking and its tool_use as SEPARATE frames (measured);
    // the thinking frame reports zero usage. They are one turn.
    asst('a1', [{ type: 'thinking', thinking: 'plan', signature: '' }]),
    asst('a2', [{ type: 'tool_use', id: 't1', name: 'read_file', input: { absolute_path: '/work/demo/a' } }], { input_tokens: 100, output_tokens: 10 }),
    // The same frame id again restates, it does not add.
    asst('a2', [{ type: 'tool_use', id: 't2', name: 'run_shell_command', input: { command: 'ls' } }], { input_tokens: 100, output_tokens: 10 }),
    toolRes([{ type: 'text', text: 'ok' }], 't2'),
    toolRes('file body'),
    asst('a4', [{ type: 'tool_use', id: 't3', name: 'write_file', input: { file_path: '/work/demo/b', content: 'x' } }], { input_tokens: 200, output_tokens: 20 }),
    toolRes('permission denied', 't3', true),
    asst('a5', [{ type: 'text', text: 'DONE' }], { input_tokens: 300, output_tokens: 5, cache_read_input_tokens: 7 }),
    { type: 'result', subtype: 'success', session_id: SID, is_error: false, result: 'DONE', usage: { input_tokens: 600, output_tokens: 35 } },
  ]);
  const res = load(r);
  assert.equal(res.source, 'captured');
  assert.deepEqual(res.events.map((e) => e.kind),
    ['user', 'lifecycle', 'reasoning', 'tool', 'tool', 'turn', 'tool', 'turn', 'text', 'turn']);
  const [u, life] = res.events;
  assert.ok(u.kind === 'user' && u.text === 'List the files.' && !u.truncated);
  assert.ok(life.kind === 'lifecycle' && life.phase === 'session' && life.detail === SID);

  const tools = res.events.filter((e): e is ToolEvent => e.kind === 'tool');
  const byId = Object.fromEntries(tools.map((t) => [t.callId, t]));
  assert.equal(byId.t2.output, 'ok');
  assert.equal(byId.t2.status, 'completed');
  assert.equal(byId.t1.output, 'file body', 'the id-less result pairs with the earliest pending tool');
  assert.equal(byId.t1.status, 'completed');
  assert.equal(byId.t3.status, 'error');
  assert.equal(byId.t3.error, 'permission denied');

  const turns = res.events.filter((e): e is TurnEvent => e.kind === 'turn');
  assert.deepEqual(turns.map((t) => t.turn), [1, 2, 3]);
  assert.deepEqual(turns[0].usage, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  assert.equal(turns[2].usage?.cacheRead, 7);
  const text = res.events[8];
  assert.ok(text.kind === 'text' && text.final === true);
  assert.equal(res.cliVersion, '0.0.0-test');
});

test('stream: an error result subtype and "[API Error:" text become api_error, and nothing is final', () => {
  const dir = runDir();
  const r = writeCapture(dir, [
    sys,
    asst('b1', [{ type: 'text', text: '[API Error: 500 upstream failed]' }], { input_tokens: 5, output_tokens: 1 }),
    { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SID, result: 'the run failed' },
  ]);
  const res = load(r);
  const errs = res.events.filter((e) => e.kind === 'api_error');
  assert.equal(errs.length, 2);
  assert.ok(errs[0].kind === 'api_error' && errs[0].message === '[API Error: 500 upstream failed]');
  assert.ok(errs[1].kind === 'api_error' && errs[1].errorType === 'error_during_execution' && errs[1].message === 'the run failed');
  assert.equal(res.events.some((e) => e.kind === 'text'), false);

  // A "success" result that is really a transport error is reported once, not twice.
  const dir2 = runDir();
  const r2 = writeCapture(dir2, [
    sys,
    asst('c1', [{ type: 'text', text: '[API Error: 401 bad key]' }], { input_tokens: 5, output_tokens: 1 }),
    { type: 'result', subtype: 'success', session_id: SID, result: '[API Error: 401 bad key]' },
  ]);
  assert.equal(load(r2).events.filter((e) => e.kind === 'api_error').length, 1);
});

// ─── capture reader ──────────────────────────────────────────────────────────

test('capture reader: skips torn and non-frame lines, and turns the oversize-line marker into a lifecycle event', () => {
  const dir = runDir();
  const capturePath = path.join(dir, 'stdout.log');
  fs.writeFileSync(capturePath, [
    `${T0}\t${JSON.stringify(sys)}`,
    'no tab on this line',
    `${T0 + 1}\t{"type":"assistant", broken json`,
    `${T0 + 2}\t{"_lmTruncatedLine":true,"bytes":2097152}`,
    `notanumber\t{"type":"system"}`,
    `${T0 + 3}\t${JSON.stringify(asst('d1', [{ type: 'text', text: 'hi' }], { input_tokens: 1, output_tokens: 1 }))}`,
    // The writer is mid-append: a torn last line with no newline.
    `${T0 + 4}\t{"type":"result","subty`,
  ].join('\n'));
  const cap = readCapture(capturePath);
  assert.ok(cap);
  assert.equal(cap.entries.length, 3);
  assert.equal(cap.skipped, 4);
  assert.equal(cap.entries[1].truncatedBytes, 2097152);

  const res = load(ref(dir, { capturePath, live: true }));
  const marker = res.events.find((e) => e.kind === 'lifecycle' && e.phase === 'capture_truncated');
  assert.ok(marker, 'the dropped line is visible in the timeline');
  assert.equal(marker.at, T0 + 2);
  assert.deepEqual(res.events.map((e) => e.kind), ['lifecycle', 'lifecycle', 'text', 'turn']);
});

test('capture reader: a symlinked stdout.log is not read', () => {
  const dir = runDir();
  const real = path.join(tmp, 'elsewhere.log');
  fs.writeFileSync(real, `${T0}\t${JSON.stringify(sys)}\n`);
  const link = path.join(dir, 'stdout.log');
  fs.symlinkSync(real, link);
  assert.equal(readCapture(link), null);
  const res = load(ref(dir, { capturePath: link, live: true }));
  assert.equal(res.sources.captured.available, false);
});

// ─── legacy inference ────────────────────────────────────────────────────────

const dbgLines = (extra: string[] = []) => [
  '2026-01-02T03:04:00.100Z [DEBUG] [PRECONNECT] Skipping preconnect',
  '2026-01-02T03:04:00.200Z [INFO] Config initialization started',
  `2026-01-02T03:04:00.300Z [DEBUG] [MEMORY_DISCOVERY] Loading server hierarchical memory for CWD: /work/with space (importFormat: tree)`,
  `2026-01-02T03:04:00.400Z [DEBUG] [STARTUP] Session ID: ${SID}`,
  ...extra,
  '    at someFrame (file:///cli.js:1:1)',
];

test('legacy: no chat file → not_started, with times, cwd and session id from the debug log', () => {
  const dir = runDir();
  writeDebug(dir, ['2026-01-02T03:04:00.100Z [DEBUG] first', ...dbgLines(), '2026-01-02T03:04:00.900Z [INFO] Config initialization completed']);
  const r = inferLegacyQwenRun(dir);
  assert.equal(r.status, 'not_started');
  assert.equal(r.sessionId, SID);
  assert.equal(r.cwd, '/work/with space');
  assert.equal(r.startedAt, Date.parse('2026-01-02T03:04:00.100Z'));
  assert.equal(r.endedAt, Date.parse('2026-01-02T03:04:00.900Z'));
  assert.equal(r.usage.reported, false);
});

test('legacy: final answer → succeeded, with previews and counts', () => {
  const dir = runDir();
  successfulChat(dir);
  writeDebug(dir, dbgLines(['2026-01-02T03:04:09.000Z [INFO] [MONITOR_REGISTRY] Aborted all monitors']));
  const r = inferLegacyQwenRun(dir);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.sessionId, SID);
  assert.equal(r.cwd, CWD, 'the record cwd wins over the debug line');
  assert.equal(r.model, MODEL);
  assert.equal(r.cliVersion, '0.0.0-test');
  assert.equal(r.numTurns, 2);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.resultPreview, 'DONE');
  assert.equal(r.promptPreview, 'Create hello.txt containing PONG, then reply DONE.');
  assert.deepEqual(r.filesTouched, [`${CWD}/hello.txt`]);
  assert.equal(r.startedAt, Date.parse('2026-01-02T03:04:00.100Z'));
  assert.equal(r.endedAt, Date.parse('2026-01-02T03:04:09.000Z'), 'the last TIMESTAMPED debug line, not a stack frame');
  assert.equal(r.error, undefined);
});

test('legacy: the last significant record is an api_error → failed, with type and message', () => {
  const dir = runDir();
  writeChat(dir, [user('go'), apiError('InternalServerError', '500 <b>Internal Server Error</b>', 500), snapshot([])]);
  writeDebug(dir, dbgLines());
  const r = inferLegacyQwenRun(dir);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'InternalServerError: 500 Internal Server Error');
  assert.equal(r.model, MODEL, 'telemetry names the model even with no assistant record');
});

test('legacy: debug "Shutdown signal received" → aborted', () => {
  const dir = runDir();
  writeChat(dir, [
    user('count slowly'),
    assistant([{ functionCall: { id: 'sh_1', name: 'run_shell_command', args: { command: 'sleep 99' } } }], usage(10, 2, 0)),
  ]);
  writeDebug(dir, dbgLines(['2026-01-02T03:05:00.000Z [DEBUG] [NON_INTERACTIVE_CLI] [runNonInteractive] Shutdown signal received']));
  assert.equal(inferLegacyQwenRun(dir).status, 'aborted');
});

test('legacy: an APIUserAbortError → aborted, even with no shutdown line', () => {
  const dir = runDir();
  writeChat(dir, [user('go'), apiError('APIUserAbortError', 'Request was aborted.')]);
  writeDebug(dir, dbgLines());
  const r = inferLegacyQwenRun(dir);
  assert.equal(r.status, 'aborted');
  assert.equal(r.error, 'APIUserAbortError: Request was aborted.');
});

test('legacy: a path that is not a run dir is unknown, never a throw', () => {
  assert.equal(inferLegacyQwenRun(path.join(tmp, 'does-not-exist')).status, 'unknown');
  const f = path.join(tmp, 'a-file');
  fs.writeFileSync(f, 'x');
  assert.equal(inferLegacyQwenRun(f).status, 'unknown');
});

// ─── debug tail ──────────────────────────────────────────────────────────────

test('debug tail: the last N lines of the uuid-named log', () => {
  const dir = runDir();
  const lines = Array.from({ length: 300 }, (_, i) => `2026-01-02T03:04:05.000Z [DEBUG] line ${i}`);
  writeDebug(dir, lines);
  const t = readQwenDebugTail(dir, SID, 50);
  assert.equal(t.available, true);
  assert.equal(t.lines.length, 50);
  assert.equal(t.lines[49], '2026-01-02T03:04:05.000Z [DEBUG] line 299');
  assert.equal(t.totalLines, 300);
  assert.equal(t.truncated, true);
  // Without a session id the newest uuid-named log is used.
  assert.equal(readQwenDebugTail(dir, null, 5).lines[4], lines[299]);
  // The line count is clamped to 200.
  assert.equal(readQwenDebugTail(dir, SID, 5000).lines.length, 200);
});

test('debug tail: never follows debug/latest, a symlinked log, or a non-uuid name', () => {
  const outside = path.join(tmp, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-CONTENT-CANARY\n');

  const dir = runDir();
  const dbg = path.join(dir, 'qwen-home', 'debug');
  fs.mkdirSync(dbg, { recursive: true });
  fs.symlinkSync(outside, path.join(dbg, 'latest'));
  fs.symlinkSync(outside, path.join(dbg, `${SID}.txt`));
  fs.writeFileSync(path.join(dbg, 'notes.txt'), 'not a debug log\n');

  for (const sid of [null, SID, 'latest', '../../../outside-secret', 'notes']) {
    const t = readQwenDebugTail(dir, sid, 100);
    assert.equal(t.available, false, `sid=${sid}`);
    assert.equal(t.reason, 'NO_DEBUG_LOG');
    assert.doesNotMatch(JSON.stringify(t), /OUTSIDE-CONTENT-CANARY|not a debug log/);
  }
  assert.equal(readQwenDebugTail(path.join(tmp, 'nope'), null, 10).reason, 'NO_RUN_DIR');
});

test('chat discovery: only regular files under real directories count', () => {
  const dir = runDir();
  const realChat = writeChat(runDir(), [user('elsewhere'), assistant([{ text: 'x' }], usage(1, 1, 0))]);
  const chats = path.join(dir, 'qwen-home', 'projects', '-work-demo', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.symlinkSync(realChat, path.join(chats, `${SID}.jsonl`));
  const res = load(ref(dir));
  assert.equal(res.sources.native.available, false);
  assert.equal(res.sources.native.reason, 'NO_CHAT_FILE');
  assert.equal(res.source, 'none');
  assert.deepEqual(res.events as HarnessEvent[], []);
});
