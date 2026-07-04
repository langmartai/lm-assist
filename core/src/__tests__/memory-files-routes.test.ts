import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic projects root — set BEFORE importing the routes.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfr-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mfr-cfg-'));

import { createMemoryFilesRoutes } from '../routes/core/memory-files.routes';
import { sha256 } from '../memory/file-write';
import type { ParsedRequest } from '../routes/index';

const SLUG = '-tmp-proj';
const MEM_DIR = path.join(TMP, 'projects', SLUG, 'memory');

function seed() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEM_DIR, 'existing.md'), '---\nname: e\ndescription: d\ntype: project\n---\nbody');
  fs.writeFileSync(path.join(MEM_DIR, 'MEMORY.md'), '# Index\n- [E](existing.md) — hook\n');
}

function req(method: string, params: Record<string, string>, body?: any, query: Record<string, string> = {}): ParsedRequest {
  return { method, path: '/memory', params, query, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}
const routes = () => createMemoryFilesRoutes({} as any);
const route = (method: string, re: RegExp) =>
  routes().find(r => r.method === method && re.test(r.pattern.source))!;

test('PUT writes a live memory file and returns hash + warnings', async () => {
  seed();
  const content = '---\nname: n\ndescription: d\ntype: project\n---\nnew body';
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: SLUG, filename: 'newfile.md' }, { content }), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.hash, sha256(content));
  assert.deepEqual(r.data.warnings, []);
  assert.equal(fs.readFileSync(path.join(MEM_DIR, 'newfile.md'), 'utf-8'), content);
});

test('PUT without frontmatter type returns warnings but still writes', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: SLUG, filename: 'plain.md' }, { content: 'no frontmatter' }), {} as any);
  assert.equal(r.success, true);
  assert.ok(r.data.warnings.length >= 1);
});

test('PUT hash conflict → HASH_MISMATCH error, file untouched', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: SLUG, filename: 'existing.md' },
      { content: 'clobber', expectedHash: sha256('stale-view') }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'HASH_MISMATCH');
  assert.match(r.error.message, /^HASH_MISMATCH/);
  assert.match(fs.readFileSync(path.join(MEM_DIR, 'existing.md'), 'utf-8'), /^---/);
});

test('PUT rejects managed files, traversal, bad slug', async () => {
  seed();
  for (const filename of ['_cross-project.md', '_hosts.md']) {
    const r: any = await route('PUT', /file/).handler(
      req('PUT', { projectId: SLUG, filename }, { content: 'x' }), {} as any);
    assert.equal(r.error.code, 'PROTECTED', filename);
  }
  const t: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: SLUG, filename: '..%2F..%2Fetc%2Fpwn.md' }, { content: 'x' }), {} as any);
  assert.equal(t.error.code, 'BAD_FILENAME');
  const b: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: '__nope__', filename: 'a.md' }, { content: 'x' }), {} as any);
  assert.equal(b.error.code, 'PROJECT_NOT_FOUND');
});

test('MEMORY.md itself is editable via PUT', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { projectId: SLUG, filename: 'MEMORY.md' }, { content: '# Index\n' }), {} as any);
  assert.equal(r.success, true);
});

test('POST creates with EXISTS guard and appends indexLine', async () => {
  seed();
  const r: any = await route('POST', /file\$/).handler(
    req('POST', { projectId: SLUG },
      { filename: 'fresh.md', content: '---\nname: f\ndescription: d\ntype: project\n---\nb', indexLine: '- [F](fresh.md) — new' }), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.indexUpdated, true);
  assert.match(fs.readFileSync(path.join(MEM_DIR, 'MEMORY.md'), 'utf-8'), /\(fresh\.md\)/);
  const dup: any = await route('POST', /file\$/).handler(
    req('POST', { projectId: SLUG }, { filename: 'fresh.md', content: 'x' }), {} as any);
  assert.equal(dup.error.code, 'EXISTS');
});

test('DELETE removes the file and its index line', async () => {
  seed();
  const r: any = await route('DELETE', /file/).handler(
    req('DELETE', { projectId: SLUG, filename: 'existing.md' }, undefined, { removeIndexLine: 'true' }), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.indexUpdated, true);
  assert.equal(fs.existsSync(path.join(MEM_DIR, 'existing.md')), false);
  assert.equal(fs.readFileSync(path.join(MEM_DIR, 'MEMORY.md'), 'utf-8').includes('existing.md'), false);
  const missing: any = await route('DELETE', /file/).handler(
    req('DELETE', { projectId: SLUG, filename: 'existing.md' }), {} as any);
  assert.equal(missing.error.code, 'NOT_FOUND');
});

test('GET file serves MEMORY.md via live disk fallback with hash', async () => {
  seed();
  const { createMemoryRoutes } = await import('../routes/core/memory.routes');
  const get = createMemoryRoutes({} as any).find(
    r => r.method === 'GET' && /file/.test(r.pattern.source))!;
  const r: any = await get.handler(
    req('GET', { projectId: SLUG, filename: 'MEMORY.md' }), {} as any);
  assert.equal(r.success, true);
  assert.match(r.data.body, /Index/);
  assert.equal(typeof r.data.hash, 'string');
});
