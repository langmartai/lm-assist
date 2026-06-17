import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-kb-'));
import { KnowledgeBackend } from '../../data/backends/knowledge-backend';
import { getKnowledgeStore } from '../../knowledge/store';

function seedDoc(title: string) {
  return getKnowledgeStore().createKnowledge({
    title, type: 'flow', project: '/proj',
    parts: [{ partId: 'p1', title: 'Part one', summary: 'sum', content: 'the body content' }],
  });
}

test('knowledge backend: get maps a stored doc to a DataRecord', async () => {
  const be = new KnowledgeBackend();
  const k = seedDoc('Alpha doc');
  const rec = await be.get('knowledge', k.id);
  assert.equal(rec?.id, k.id);
  assert.equal(rec?.fields.title, 'Alpha doc');
  assert.equal(rec?.fields.type, 'flow');
  assert.ok(Array.isArray(rec?.fields.parts));
  assert.match(String(rec?.text), /body content/);
  assert.equal(await be.get('knowledge', 'K999'), null);
});

test('knowledge backend: query lists + filters docs', async () => {
  const be = new KnowledgeBackend();
  seedDoc('Beta one'); seedDoc('Beta two');
  const all = await be.query('knowledge', {});
  assert.ok(all.records.length >= 2);
  assert.ok(all.records.every((r) => typeof r.fields.title === 'string'));
  const filtered = await be.query('knowledge', { filter: [{ field: 'type', op: 'eq', value: 'flow' }] });
  assert.ok(filtered.records.length >= 2);
});

test('knowledge backend: delete removes the doc', async () => {
  const be = new KnowledgeBackend();
  const k = seedDoc('Gamma doc');
  assert.equal(await be.delete('knowledge', k.id), true);
  assert.equal(await be.get('knowledge', k.id), null);
  assert.equal(await be.delete('knowledge', k.id), false);
});

test('knowledge backend: sync hooks throw (system datasets are not generically synced)', async () => {
  const be = new KnowledgeBackend();
  await assert.rejects(() => be.exportSince('knowledge'), /SYNC_NOT_SUPPORTED/);
  await assert.rejects(() => be.importBatch('knowledge', [], { machineId: 'm', hostname: 'h', os: 'linux' }), /SYNC_NOT_SUPPORTED/);
});

test('knowledge backend: put creates a new doc then updates it', async () => {
  const be = new KnowledgeBackend();
  // create (no id)
  const created = await be.put('knowledge', {
    id: '', version: 0,
    fields: { title: 'Created via put', type: 'invariant', project: '/p',
      parts: [{ partId: 'p1', title: 'P', summary: 's', content: 'c' }] },
    createdAt: 't', updatedAt: 't',
  });
  assert.match(created.id, /^K\d+/);
  const got = await be.get('knowledge', created.id);
  assert.equal(got?.fields.title, 'Created via put');
  assert.equal(got?.fields.type, 'invariant');

  // update (existing id)
  await be.put('knowledge', {
    id: created.id, version: 0,
    fields: { title: 'Renamed', type: 'invariant', project: '/p',
      parts: [{ partId: 'p1', title: 'P', summary: 's', content: 'c2' }], status: 'active' },
    createdAt: 't', updatedAt: 't',
  });
  const after = await be.get('knowledge', created.id);
  assert.equal(after?.fields.title, 'Renamed');
});

test('knowledge backend: admin stats reports counts', async () => {
  const be = new KnowledgeBackend();
  await be.put('knowledge', { id: '', version: 0, fields: { title: 'S1', type: 'flow', project: '/p', parts: [] }, createdAt: 't', updatedAt: 't' });
  const stats = await be.admin('knowledge', 'stats') as any;
  assert.equal(typeof stats.total, 'number');
  assert.ok(stats.total >= 1);
});

test('knowledge backend: admin add-comment delegates to the store', async () => {
  const be = new KnowledgeBackend();
  const created = await be.put('knowledge', { id: '', version: 0, fields: { title: 'Commented', type: 'flow', project: '/p', parts: [] }, createdAt: 't', updatedAt: 't' });
  const c = await be.admin('knowledge', 'add-comment', { knowledgeId: created.id, type: 'general', content: 'note from llm' }) as any;
  assert.equal(c.knowledgeId, created.id);
  assert.equal(c.content, 'note from llm');
});

test('knowledge backend: admin rejects an unknown op', async () => {
  const be = new KnowledgeBackend();
  await assert.rejects(() => be.admin('knowledge', 'no-such-op'), /unknown admin op/i);
});
