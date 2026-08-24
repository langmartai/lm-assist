// core/src/__tests__/search/prompt-index.test.ts
// The regression suite for bl_cc0f711b: `search` had degraded to match-all. A
// project-scoped query returned all 126 of that project's sessions; a completely
// different query returned the same 126 in the same order.
//
// Requires better-sqlite3 (like the other sql suites) — absent bindings fail loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-pidx-'));

import { PromptIndex } from '../../search/prompt-index';

/** Build a session transcript with the given user-message texts. */
function writeSession(dir: string, sessionId: string, prompts: string[], project = '/tmp/proj'): string {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, cwd: project })];
  for (const p of prompts) {
    lines.push(JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-08-01T00:00:00.000Z', message: { content: [{ type: 'text', text: p }] } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function freshIndex(tag: string): { index: PromptIndex; dir: string } {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), `pidx-s-${tag}-`));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pidx-w-${tag}-`));
  return { index: new PromptIndex(store, path.join(work, 'state.json')), dir: work };
}

test('a distinctive query returns FEWER sessions than the corpus (the core regression)', async () => {
  const { index, dir } = freshIndex('regress');
  // 30 sessions of unrelated work + one that actually did the thing.
  for (let i = 0; i < 30; i++) {
    await index.indexFile(writeSession(dir, `filler-${i}`, [
      `refactor the ${i} handler and expand the command parser for random input`,
      'understand the retry semantics of the upload path',
    ]));
  }
  await index.indexFile(writeSession(dir, 'target', ['add auto model discovery and publish new models to the registry']));

  const r = await index.search('auto model discovery and publish');
  assert.ok(r, 'expected a result');
  assert.ok(r!.sessions.length < 31, `matched ${r!.sessions.length} of 31 sessions — that is match-all again`);
  assert.equal(r!.sessions[0].sessionId, 'target', 'the session that did the work must rank first');
});

test('the stopword that broke it cannot pull in unrelated sessions', async () => {
  const { index, dir } = freshIndex('stopword');
  // Every one of these contains `and` as a SUBSTRING (command/understand/expands/random),
  // which is exactly how one token matched 126 of 126 sessions.
  await index.indexFile(writeSession(dir, 'a', ['the command parser expands random tokens']));
  await index.indexFile(writeSession(dir, 'b', ['understand the handler and the expander']));
  await index.indexFile(writeSession(dir, 'c', ['auto model discovery and publish']));

  const r = await index.search('auto model discovery and publish');
  assert.deepEqual(r!.sessions.map((s) => s.sessionId), ['c']);
});

test('two different queries return different result sets', async () => {
  const { index, dir } = freshIndex('differ');
  await index.indexFile(writeSession(dir, 'models', ['add auto model discovery and publish to the registry']));
  await index.indexFile(writeSession(dir, 'sockets', ['fix the websocket gateway reconnect backoff timer']));

  const a = await index.search('model discovery publish registry');
  const b = await index.search('websocket gateway reconnect backoff');
  assert.deepEqual(a!.sessions.map((s) => s.sessionId), ['models']);
  assert.deepEqual(b!.sessions.map((s) => s.sessionId), ['sockets']);
});

test('a long transcript does not outrank a short relevant one', async () => {
  const { index, dir } = freshIndex('bm25');
  // The old scorer summed a point per token occurrence, so the biggest transcript won.
  await index.indexFile(writeSession(dir, 'huge', Array.from({ length: 200 }, (_, i) => `deploy the model registry service iteration ${i} with assorted notes`)));
  await index.indexFile(writeSession(dir, 'small', ['add auto model discovery and publish new models']));

  const r = await index.search('auto model discovery publish');
  assert.equal(r!.sessions[0].sessionId, 'small', 'bm25 length normalization must beat sheer volume');
});

test('injected boilerplate is indexed but never ranked by default', async () => {
  const { index, dir } = freshIndex('synth');
  await index.indexFile(writeSession(dir, 'noise', [
    'Review this change for security vulnerabilities. Changed files: model-registry.ts discovery.ts',
    '⟦INVARIANTS — these override anything below⟧ model discovery publish registry',
  ]));
  const hidden = await index.search('model discovery registry');
  assert.equal(hidden!.sessions.length, 0, 'boilerplate must not compete with real prompts');

  const shown = await index.search('model discovery registry', { includeSynthetic: true });
  assert.equal(shown!.sessions.length, 1, 'it stays queryable on request');
});

test('AND is preferred; OR is only a labelled widening', async () => {
  const { index, dir } = freshIndex('mode');
  await index.indexFile(writeSession(dir, 'both', ['auto model discovery and publish']));
  await index.indexFile(writeSession(dir, 'one', ['the deployment publish step']));

  const tight = await index.search('auto model discovery publish');
  assert.equal(tight!.mode, 'and');
  assert.deepEqual(tight!.sessions.map((s) => s.sessionId), ['both']);

  const widened = await index.search('publish kubernetes helm rollout');
  assert.equal(widened!.mode, 'or', 'no session has all terms, so it must widen AND SAY SO');
});

test('a query with no indexable terms returns null, not everything', async () => {
  const { index, dir } = freshIndex('null');
  await index.indexFile(writeSession(dir, 's', ['a real prompt about the registry']));
  assert.equal(await index.search('the and of to'), null);
});

test('appending to a session re-indexes ONLY the tail', async () => {
  const { index, dir } = freshIndex('tail');
  const file = writeSession(dir, 'growing', ['first prompt about the alpha subsystem']);
  const first = await index.indexFile(file);
  assert.equal(first, 1);

  // No growth → no work at all.
  assert.equal(await index.indexFile(file), 0, 'an unchanged file must cost nothing');

  fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: '/tmp/proj', timestamp: '2026-08-02T00:00:00.000Z', message: { content: [{ type: 'text', text: 'second prompt about the bravo subsystem' }] } }) + '\n');
  const second = await index.indexFile(file);
  assert.equal(second, 1, 'only the appended prompt should be parsed, not the whole file');

  const r = await index.search('bravo subsystem');
  assert.equal(r!.sessions.length, 1, 'the appended prompt is searchable');
});

test('a half-written trailing line is left for the next pass', async () => {
  const { index, dir } = freshIndex('partial');
  const file = writeSession(dir, 'torn', ['complete prompt about the delta subsystem']);
  await index.indexFile(file);

  // Writer mid-append: no trailing newline yet.
  const partial = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'partial prompt about echo subsystem' }] } });
  fs.appendFileSync(file, partial.slice(0, partial.length - 20));
  assert.equal(await index.indexFile(file), 0, 'a torn line must not be consumed');

  // Completed on the next write — now it must appear, i.e. it was never skipped.
  fs.appendFileSync(file, partial.slice(partial.length - 20) + '\n');
  assert.equal(await index.indexFile(file), 1);
  const r = await index.search('echo subsystem');
  assert.equal(r!.sessions.length, 1, 'the record must not be lost across the torn write');
});

test('watermarks survive a restart', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pidx-s-restart-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pidx-w-restart-'));
  const statePath = path.join(work, 'state.json');

  const a = new PromptIndex(store, statePath);
  const file = writeSession(work, 'persist', ['prompt about the foxtrot subsystem']);
  await a.indexFile(file);
  a.flushState();

  const b = new PromptIndex(store, statePath);
  await b.init();
  assert.ok(b.isIndexed(file), 'a restart must not forget what was already indexed');
  assert.equal(await b.indexFile(file), 0, 'and must not re-parse it');
});

test('project scoping filters to one repo', async () => {
  const { index, dir } = freshIndex('proj');
  await index.indexFile(writeSession(dir, 'p1', ['registry discovery work here'], '/repo/one'));
  await index.indexFile(writeSession(dir, 'p2', ['registry discovery work here'], '/repo/two'));
  const r = await index.search('registry discovery', { project: '/repo/one' });
  assert.deepEqual(r!.sessions.map((s) => s.sessionId), ['p1']);
});
