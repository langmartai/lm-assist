// Integration seams the bundle feature needs from modules outside core/src/data/bundle:
//  - KnowledgeStore.reloadIndex(): a knowledge import rewrites index.json under a store that
//    caches it; without a reload the live store keeps serving the pre-import index.
//  - project-settings `bundleRetention`: a typed key, so a settings-UI save (which writes only
//    typed keys) no longer drops it, and the bundle store reads the same value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-int-home-'));
process.env.HOME = HOME;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-int-data-'));
delete process.env.CLAUDE_CONFIG_DIR;
import { getKnowledgeStore } from '../../knowledge/store';
import { createKnowledgeProvider } from '../../data/bundle/sections/files';
import { DEFAULTS, getProjectSettings, saveProjectSettings } from '../../project-settings';
import { readBundleRetention } from '../../data/bundle/store';
import { getDataDir } from '../../utils/path-utils';
import type { BundleFile } from '../../data/bundle/format';

const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const file = (p: string, content: string): BundleFile => ({ path: p, content, sha256: sha(content), size: Buffer.byteLength(content), mtime: '2026-09-01T00:00:00.000Z' });

test('hermetic: the data dir is the sandbox', () => {
  assert.equal(getDataDir(), process.env.LM_ASSIST_DATA_DIR);
});

test('KnowledgeStore.reloadIndex drops the cached index so the next read sees the file', () => {
  const store = getKnowledgeStore();
  const indexFile = path.join(getDataDir(), 'knowledge', 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ knowledges: {}, nextId: 3, lastUpdated: 1 }));
  store.reloadIndex();
  assert.equal(store.getIndex().nextId, 3);
  fs.writeFileSync(indexFile, JSON.stringify({ knowledges: {}, nextId: 9, lastUpdated: 2 }));
  assert.equal(store.getIndex().nextId, 3, 'cached until reloaded');
  store.reloadIndex();
  assert.equal(store.getIndex().nextId, 9);
});

test('knowledge import through the default reload refreshes the live store (no restart note)', async () => {
  const store = getKnowledgeStore();
  const before = store.getIndex().nextId;
  const id = `K${String(before + 39).padStart(3, '0')}`;
  const index = JSON.stringify({ knowledges: { [id]: { title: 'imported' } }, nextId: before + 40, lastUpdated: 3 });
  const p = createKnowledgeProvider();
  const res = await p.apply([file('index.json', index), file(`${id}.md`, '# imported')], 'replace');
  assert.ok(res.applied.add + res.applied.update >= 1, JSON.stringify(res));
  assert.ok(!res.warnings.some((w) => /restart Core/.test(w)), JSON.stringify(res.warnings));
  assert.equal(store.getIndex().nextId, before + 40);
  assert.ok(store.getIndex().knowledges[id], 'the imported doc is in the live index');
});

test('project-settings: bundleRetention is typed, defaults to 20, and survives an unrelated save', () => {
  assert.equal(DEFAULTS.bundleRetention, 20);
  assert.equal(getProjectSettings().bundleRetention, 20);
  assert.equal(saveProjectSettings({ bundleRetention: 7 }).bundleRetention, 7);
  const after = saveProjectSettings({ knowledgeEnabled: true });
  assert.equal(after.bundleRetention, 7, 'a save of another key keeps it');
  assert.equal(readBundleRetention(), 7, 'the bundle store reads the same key');
  // Not a positive integer → ignored (loader and saver agree with the store).
  assert.equal(saveProjectSettings({ bundleRetention: 0 }).bundleRetention, 7);
  assert.equal(saveProjectSettings({ bundleRetention: 2.5 }).bundleRetention, 7);
  const f = path.join(getDataDir(), 'project-settings.json');
  fs.writeFileSync(f, JSON.stringify({ bundleRetention: -1 }));
  const later = new Date(Date.now() + 5000); // the loader caches by mtime; make the edit visible
  fs.utimesSync(f, later, later);
  assert.equal(getProjectSettings().bundleRetention, 20);
});
