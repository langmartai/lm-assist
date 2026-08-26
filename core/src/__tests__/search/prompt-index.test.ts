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

test('a broad query reports a FLOOR, not a fabricated total, when the scan is capped', async () => {
  const { index, dir } = freshIndex('cap');
  // Many sessions, each with several prompts sharing a term: the row budget binds long
  // before the session list is complete. Measured on the real node, a fixed 200-row budget
  // reported 114 sessions for "session" where a larger one found 171.
  for (let i = 0; i < 60; i++) {
    await index.indexFile(writeSession(dir, `s-${i}`, [
      `the widget subsystem needs attention in module ${i}`,
      `more widget work on module ${i} today`,
      `still more widget notes for module ${i}`,
    ]));
  }
  const small = await index.search('widget', { limit: 20, need: 1 });
  assert.equal(small!.truncated, true, 'a capped scan must announce itself');

  const big = await index.search('widget', { limit: 5000, need: 1 });
  assert.equal(big!.truncated, false, 'an exhausted scan is exact');
  assert.ok(big!.sessions.length > small!.sessions.length, 'the larger budget must see more sessions');
  assert.equal(big!.sessions.length, 60);
});

test('the row budget escalates to satisfy a deep page', async () => {
  const { index, dir } = freshIndex('deep');
  for (let i = 0; i < 40; i++) {
    await index.indexFile(writeSession(dir, `d-${i}`, [`gadget calibration pass ${i}`, `gadget follow-up ${i}`]));
  }
  // Asking for enough sessions to cover offset 30 + limit 5 must actually reach them.
  const r = await index.search('gadget', { need: 35 });
  assert.ok(r!.sessions.length >= 35, `deep page needs >=35 sessions, got ${r!.sessions.length}`);
});

test('subagent transcripts are excluded — backfill and watcher must agree', async () => {
  const { index, dir } = freshIndex('subagent');
  // The live watcher (chokidar depth 3) used to feed these in while the backfill never did,
  // so a result depended on how the file was discovered. Their "user" turn is the
  // orchestrator's task prompt, and the filename is not a resolvable session id.
  const subDir = path.join(dir, 'sess-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const agentFile = writeSession(subDir, 'agent-a1ae092e5d9fb5672', ['Read-only exploration of the zulu subsystem']);
  assert.equal(await index.indexFile(agentFile), 0, 'a subagent transcript must not be indexed');

  await index.indexFile(writeSession(dir, 'real-session', ['work on the zulu subsystem']));
  const r = await index.search('zulu subsystem');
  assert.deepEqual(r!.sessions.map((s) => s.sessionId), ['real-session']);
});

test('the watermark does NOT advance past a row that failed to persist', async () => {
  const { index, dir } = freshIndex('failput');
  const file = writeSession(dir, 'flaky', ['a prompt about the november subsystem']);

  // Force the store write to fail for this pass.
  const backend = (index as any).backend;
  const realPut = backend.put.bind(backend);
  backend.put = async () => { throw new Error('simulated store failure'); };
  await index.indexFile(file);

  // Losing this content silently would need a full rebuild to recover, so the next pass
  // must re-read the same tail. put() is an upsert on a deterministic id, so that is safe.
  backend.put = realPut;
  const recovered = await index.indexFile(file);
  assert.equal(recovered, 1, 'the failed row must be retried, not skipped forever');
  const r = await index.search('november subsystem');
  assert.equal(r!.sessions.length, 1);
});

test('byte accounting survives invalid UTF-8 in the transcript', async () => {
  const { index, dir } = freshIndex('utf8');
  const file = writeSession(dir, 'binary', ['first prompt about the oscar subsystem']);
  await index.indexFile(file);

  // A lone 0xFF is not valid UTF-8: decoding turns it into U+FFFD, which re-encodes to a
  // DIFFERENT byte length. Measuring the consumed span on the decoded string would drift
  // the watermark and every later read would start mid-record.
  const line = Buffer.concat([
    Buffer.from(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'bad ' }] } }).slice(0, -1)),
    Buffer.from([0xff]),
    Buffer.from('}\n'),
  ]);
  fs.appendFileSync(file, line);
  await index.indexFile(file);

  fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: '/tmp/proj', message: { content: [{ type: 'text', text: 'later prompt about the papa subsystem' }] } }) + '\n');
  await index.indexFile(file);

  const r = await index.search('papa subsystem');
  assert.equal(r!.sessions.length, 1, 'a later record must still be found after an undecodable line');
});

test('OR mode ranks by TERM COVERAGE, not just the best single prompt', async () => {
  const { index, dir } = freshIndex('coverage');
  // AND requires every term inside ONE prompt, which real work rarely satisfies — so a
  // multi-word query widens to OR, where "any one term" alone is nearly useless. A
  // session covering more of the query must outrank one that merely mentions a common word.
  await index.indexFile(writeSession(dir, 'broad', ['the quebec deployment notes']));
  await index.indexFile(writeSession(dir, 'partial', ['quebec romeo pipeline work']));
  await index.indexFile(writeSession(dir, 'covering', [
    'quebec subsystem overview',
    'romeo integration details',
    'sierra rollout plan',
  ]));

  const r = await index.search('quebec romeo sierra');
  assert.equal(r!.mode, 'or', 'no single prompt holds all three terms');
  assert.equal(r!.sessions[0].sessionId, 'covering', 'the session covering 3/3 terms must rank first');
  assert.equal(r!.sessions[0].terms, 3);
  assert.equal(r!.queryTerms, 3);
  // And the one-term session must rank last of the three.
  assert.equal(r!.sessions[r!.sessions.length - 1].sessionId, 'broad');
});

test('AND mode does not pay for coverage probes', async () => {
  const { index, dir } = freshIndex('andcov');
  await index.indexFile(writeSession(dir, 's', ['tango uniform victor all in one prompt']));
  const r = await index.search('tango uniform victor');
  assert.equal(r!.mode, 'and');
  assert.equal(r!.sessions.length, 1);
});

test('a CJK prompt is findable by a sub-word query', async () => {
  const { index, dir } = freshIndex('cjk');
  await index.indexFile(writeSession(dir, 'zh', ['修复微信客户端的消息轮询问题']));
  await index.indexFile(writeSession(dir, 'other', ['unrelated english session about widgets']));

  // Without bigram expansion this returns nothing: unicode61 holds the whole run as one token.
  const r = await index.search('消息轮询');
  assert.equal(r!.sessions.length, 1);
  assert.equal(r!.sessions[0].sessionId, 'zh');
  // The rendered snippet must be the real text, not the appended bigram expansion.
  assert.ok(r!.sessions[0].best.text.startsWith('修复微信'), 'snippet leaked the expansion');
  assert.ok(!r!.sessions[0].best.text.includes(' '), 'expansion is space-separated; the body is not');
});

test('deleting a transcript prunes its rows', async () => {
  const { index, dir } = freshIndex('prune');
  const keep = writeSession(dir, 'keeper', ['xray subsystem work that stays']);
  const gone = writeSession(dir, 'goner', ['xray subsystem work that disappears']);
  await index.indexFile(keep);
  await index.indexFile(gone);
  assert.equal((await index.search('xray subsystem'))!.sessions.length, 2);

  fs.rmSync(gone);
  assert.equal(await index.pruneMissing(), 1);
  const r = await index.search('xray subsystem');
  assert.deepEqual(r!.sessions.map((s) => s.sessionId), ['keeper']);
  assert.equal(index.isIndexed(gone), false, 'the watermark must go too, or it is never re-scanned');
});

test('pruning leaves a session whose file still exists', async () => {
  const { index, dir } = freshIndex('noprune');
  const f = writeSession(dir, 'alive', ['yankee subsystem still here']);
  await index.indexFile(f);
  assert.equal(await index.pruneMissing(), 0);
  assert.equal((await index.search('yankee subsystem'))!.sessions.length, 1);
});
