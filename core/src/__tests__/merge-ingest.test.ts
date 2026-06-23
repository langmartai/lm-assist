import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeIngestRecords } from '../memory/merge-ingest';

function tmpLive(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const fm = (body: string) => `---\nname: f\ntype: project\n---\n${body}`;
const read = (p: string) => fs.readFileSync(p, 'utf-8');
const neverLlm = async () => { throw new Error('LLM must not be called'); };

test('adopts a file absent locally (+ sets base)', async () => {
  const live = tmpLive();
  const r = await mergeIngestRecords(live, 'gw-peer', '-proj', [{ file: 'a.md', content: fm('peer') }], { llm: neverLlm });
  assert.equal(r.adopted, 1);
  assert.equal(read(path.join(live, 'a.md')), fm('peer'));
  assert.equal(read(path.join(live, '.sync-base', 'a.md')), fm('peer'));
});

test('peer identical to local → unchanged (no LLM)', async () => {
  const live = tmpLive();
  fs.writeFileSync(path.join(live, 'a.md'), fm('same'));
  const r = await mergeIngestRecords(live, 'gw-peer', '-proj', [{ file: 'a.md', content: fm('same') }], { llm: neverLlm });
  assert.equal(r.unchanged, 1);
});

test('non-overlapping edits auto-merge cleanly into live (no LLM)', async () => {
  const live = tmpLive();
  fs.writeFileSync(path.join(live, 'a.md'), 'A\nb\nc\n');                    // local
  fs.mkdirSync(path.join(live, '.sync-base'), { recursive: true });
  fs.writeFileSync(path.join(live, '.sync-base', 'a.md'), 'a\nb\nc\n');      // base
  const r = await mergeIngestRecords(live, 'gw-peer', '-proj', [{ file: 'a.md', content: 'a\nb\nC\n' }], { llm: neverLlm });
  assert.equal(r.merged, 1);
  assert.equal(read(path.join(live, 'a.md')), 'A\nb\nC\n');
  assert.equal(read(path.join(live, '.sync-base', 'a.md')), 'A\nb\nC\n');    // base advanced
});

test('overlapping conflict → LLM resolves → written', async () => {
  const live = tmpLive();
  fs.writeFileSync(path.join(live, 'a.md'), 'a\nX\nc\n');
  fs.mkdirSync(path.join(live, '.sync-base'), { recursive: true });
  fs.writeFileSync(path.join(live, '.sync-base', 'a.md'), 'a\nb\nc\n');
  const r = await mergeIngestRecords(live, 'gw-peer', '-proj', [{ file: 'a.md', content: 'a\nY\nc\n' }],
    { llm: async () => 'a\nMERGED\nc\n' });
  assert.equal(r.llmResolved, 1);
  // extractMerged trims surrounding whitespace from the model output (idempotent → convergence holds)
  assert.equal(read(path.join(live, 'a.md')), 'a\nMERGED\nc');
});

test('overlapping conflict + LLM fails → local kept, deferred + reconcile-plan item', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-cfg-'));
  process.env.HOME = cfgDir; // recordReconcile writes ~/.lm-assist/memory-reconcile-plan.jsonl
  const live = tmpLive();
  fs.writeFileSync(path.join(live, 'a.md'), 'a\nX\nc\n');
  fs.mkdirSync(path.join(live, '.sync-base'), { recursive: true });
  fs.writeFileSync(path.join(live, '.sync-base', 'a.md'), 'a\nb\nc\n');
  const r = await mergeIngestRecords(live, 'gw-peer', '-proj', [{ file: 'a.md', content: 'a\nY\nc\n' }],
    { llm: async () => null as any });
  assert.equal(r.conflictsDeferred, 1);
  assert.equal(read(path.join(live, 'a.md')), 'a\nX\nc\n'); // local untouched (no data loss)
});

test('skips managed/credential/non-md/path names', async () => {
  const live = tmpLive();
  const r = await mergeIngestRecords(live, 'gw', '-p', [
    { file: 'MEMORY.md', content: 'x' },
    { file: '_cross-project.md', content: 'x' },
    { file: 'api_token.md', content: 'x' },
    { file: '../evil.md', content: 'x' },
    { file: 'note.txt', content: 'x' },
  ], { llm: neverLlm });
  assert.equal(r.skipped, 5);
  assert.ok(!fs.existsSync(path.join(live, 'MEMORY.md')));
});
