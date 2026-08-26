// core/src/__tests__/search/memory-index.test.ts
// Memory search had the SAME defect as session search: scoreMemoryFile matched with
// `lower.includes(token)`, so `and` hit inside command/understand/expand and one filler
// word pulled in the corpus — measured 110 of 121 memory files. The store was just small
// enough to hide it. These cover both the bm25 index and the fixed fallback scorer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-memidx-'));

import { MemoryIndex } from '../../search/memory-index';
import { containsWord, tokenize } from '../../search/text-scorer';

function freshIndex(tag: string): { index: MemoryIndex; dir: string } {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), `memidx-s-${tag}-`));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `memidx-w-${tag}-`));
  return { index: new MemoryIndex(store, path.join(work, 'state.json')), dir: work };
}

function writeMemo(dir: string, name: string, body: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `---\nname: ${name.replace(/\.md$/, '')}\n---\n\n${body}\n`);
  return f;
}

test('a stopword cannot drag in unrelated memory files', async () => {
  const { index, dir } = freshIndex('stopword');
  // Each of these contains `and` as a SUBSTRING (command/understand/expands) — the exact
  // mechanism that matched 110 of 121 files.
  await index.indexFile(writeMemo(dir, 'a.md', 'the command parser expands random tokens'), 'p');
  await index.indexFile(writeMemo(dir, 'b.md', 'understand the retry handler'), 'p');
  await index.indexFile(writeMemo(dir, 'c.md', 'auto model discovery and publish to the registry'), 'p');

  const r = await index.search('auto model discovery and publish');
  assert.deepEqual(r!.hits.map((h) => h.filename), ['c.md']);
});

test('different queries return different memory files', async () => {
  const { index, dir } = freshIndex('differ');
  await index.indexFile(writeMemo(dir, 'models.md', 'model registry discovery and publishing'), 'p');
  await index.indexFile(writeMemo(dir, 'sockets.md', 'websocket gateway reconnect backoff timer'), 'p');

  const a = await index.search('model registry discovery');
  const b = await index.search('websocket gateway backoff');
  assert.deepEqual(a!.hits.map((h) => h.filename), ['models.md']);
  assert.deepEqual(b!.hits.map((h) => h.filename), ['sockets.md']);
});

test('project scoping keeps other projects out', async () => {
  const { index, dir } = freshIndex('proj');
  await index.indexFile(writeMemo(dir, 'one.md', 'shared topic about brokers'), 'proj-one');
  await index.indexFile(writeMemo(dir, 'two.md', 'shared topic about brokers'), 'proj-two');
  const r = await index.search('shared topic brokers', { projectId: 'proj-one' });
  assert.deepEqual(r!.hits.map((h) => h.filename), ['one.md']);
});

test('the same filename from different hosts does not collide', async () => {
  // Cross-host memory arrives as `<repo>/memory/<host-id>/<name>.md` mirrors, so one
  // filename legitimately exists once per host. Keying records on project+filename alone
  // would let one host's memory silently overwrite another's.
  const { index, dir } = freshIndex('hosts');
  await index.indexFile(writeMemo(dir, 'shared.md', 'alpha content from the first host'), 'p', 'host-a', 'repo');
  await index.indexFile(writeMemo(dir, 'shared2.md', 'bravo content from the second host'), 'p', 'host-b', 'repo');

  const a = await index.search('alpha content first');
  const b = await index.search('bravo content second');
  assert.equal(a!.hits[0].host, 'host-a');
  assert.equal(b!.hits[0].host, 'host-b');
  assert.equal(a!.hits[0].source, 'repo');
});

test('search can be scoped to one host, or to live vs mirrored memory', async () => {
  const { index, dir } = freshIndex('hostfilter');
  await index.indexFile(writeMemo(dir, 'mine.md', 'charlie subsystem notes'), 'p', 'me', 'live');
  await index.indexFile(writeMemo(dir, 'theirs.md', 'charlie subsystem notes'), 'p', 'peer', 'repo');

  const all = await index.search('charlie subsystem');
  assert.equal(all!.hits.length, 2);
  const onlyPeer = await index.search('charlie subsystem', { host: 'peer' });
  assert.deepEqual(onlyPeer!.hits.map((h) => h.filename), ['theirs.md']);
  const onlyLive = await index.search('charlie subsystem', { source: 'live' });
  assert.deepEqual(onlyLive!.hits.map((h) => h.filename), ['mine.md']);
});

test('an unchanged file is not re-indexed; a rewritten one is', async () => {
  const { index, dir } = freshIndex('watermark');
  const f = writeMemo(dir, 'notes.md', 'original content about alpha');
  assert.equal(await index.indexFile(f, 'p'), true);
  assert.equal(await index.indexFile(f, 'p'), false, 'unchanged file must cost nothing');

  // Memory files are REWRITTEN in place, not appended — the watermark is (mtime,size).
  fs.writeFileSync(f, `---\nname: notes\n---\n\nrewritten content about bravo\n`);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 1000));
  assert.equal(await index.indexFile(f, 'p'), true, 'a rewrite must be re-indexed');
  const r = await index.search('bravo rewritten');
  assert.equal(r!.hits.length, 1);
});

test('a query with no indexable terms returns null, not everything', async () => {
  const { index, dir } = freshIndex('null');
  await index.indexFile(writeMemo(dir, 'x.md', 'some real content'), 'p');
  assert.equal(await index.search('the and of to'), null);
});

test('the fallback scorer is whole-word and needs a majority of terms', () => {
  // This is the path cross-host memory still uses — it cannot be FTS-indexed locally,
  // so the substring bug had to be fixed rather than bypassed.
  const hay = 'the command parser expands random tokens and understands input';
  assert.equal(containsWord(hay, 'and'), true, 'the standalone word `and` is present');
  assert.equal(containsWord(hay, 'expand'), false, '`expand` must NOT match inside `expands`');
  assert.equal(containsWord(hay, 'command'), true);
  // The tokenizer shared with memory-api must keep hyphenated terms whole, or a bare
  // "lm" would substring-match realm/helm/film.
  assert.deepEqual(tokenize('lm-assist search'), ['lm-assist', 'search']);
});
