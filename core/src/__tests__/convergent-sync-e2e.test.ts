import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-e2e-'));
process.env.CLAUDE_CONFIG_DIR = TMP;

import { createMemorySyncRoutes } from '../routes/core/memory-sync.routes';
import { mergeIngestRecords } from '../memory/merge-ingest';
import type { ParsedRequest } from '../routes/index';

const routes = createMemorySyncRoutes({} as any);
const exportH = routes.find((r) => r.method === 'POST' && /export/.test(r.pattern.source))!;
const neverLlm = async () => { throw new Error('LLM must not be called on a non-overlapping merge'); };

const liveDir = (slug: string) => path.join(TMP, 'projects', slug, 'memory');
const read = (slug: string, f = 'foo.md') => fs.readFileSync(path.join(liveDir(slug), f), 'utf-8');

function seed(slug: string, foo: string, base: string) {
  const d = liveDir(slug);
  fs.mkdirSync(path.join(d, '.sync-base'), { recursive: true });
  fs.writeFileSync(path.join(d, 'foo.md'), foo);
  fs.writeFileSync(path.join(d, '.sync-base', 'foo.md'), base);
}
async function exportRecords(slug: string) {
  const r: any = await exportH.handler({ body: { project: slug }, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest, {} as any);
  return r.data.records as Array<{ file: string; content: string; contentHash: string }>;
}

const FM = '---\nname: foo\ntype: project\n---\n';

test('two persistent peers converge a NON-overlapping divergence (no LLM)', async () => {
  const base = FM + 'l1\nl2\nl3';
  seed('-na', FM + 'A1\nl2\nl3', base); // node A changed l1
  seed('-nb', FM + 'l1\nl2\nB3', base); // node B changed l3

  // exchange both directions (one round suffices here; a second confirms stability)
  for (let i = 0; i < 2; i++) {
    await mergeIngestRecords(liveDir('-nb'), 'na', '-nb', await exportRecords('-na'), { llm: neverLlm });
    await mergeIngestRecords(liveDir('-na'), 'nb', '-na', await exportRecords('-nb'), { llm: neverLlm });
  }

  const a = read('-na');
  const b = read('-nb');
  assert.equal(a, b, 'A and B converged to identical content');
  assert.match(a, /A1/);  // both edits present — nothing lost
  assert.match(a, /B3/);
});

test('overlapping divergence converges via the LLM merge', async () => {
  const base = FM + 'l1\nMID\nl3';
  seed('-xa', FM + 'l1\nFROM_A\nl3', base); // both edited the SAME line
  seed('-xb', FM + 'l1\nFROM_B\nl3', base);
  const resolved = FM + 'l1\nFROM_A and FROM_B\nl3';
  const llm = async () => resolved; // stand-in for the agent

  for (let i = 0; i < 2; i++) {
    await mergeIngestRecords(liveDir('-xb'), 'xa', '-xb', await exportRecords('-xa'), { llm });
    await mergeIngestRecords(liveDir('-xa'), 'xb', '-xa', await exportRecords('-xb'), { llm });
  }

  assert.equal(read('-xa'), read('-xb'), 'A and B converged');
  assert.match(read('-xa'), /FROM_A and FROM_B/);
});

test('convergence is idempotent — a further exchange writes nothing new', async () => {
  // reuse -na/-nb from the first test (already converged)
  const before = read('-na');
  const r = await mergeIngestRecords(liveDir('-nb'), 'na', '-nb', await exportRecords('-na'), { llm: neverLlm });
  assert.equal(r.merged + r.llmResolved + r.adopted, 0); // nothing changed
  assert.equal(r.unchanged, 1);
  assert.equal(read('-na'), before);
});
