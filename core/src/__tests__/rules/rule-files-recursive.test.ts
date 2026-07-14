import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic rules root — set BEFORE importing the routes (rulesRoot()/mirrorRootDir()
// read CLAUDE_CONFIG_DIR / LM_ASSIST_DATA_DIR at call time, same pattern as
// core/src/__tests__/memory-files-routes.test.ts).
const CONFIG_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-cfg-'));
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-data-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG_TMP;
process.env.LM_ASSIST_DATA_DIR = DATA_TMP;

import { createRuleFilesRoutes } from '../../routes/core/rule-files.routes';
import { sha256 } from '../../memory/file-write';
import type { ParsedRequest } from '../../routes/index';

const RULES_DIR = path.join(CONFIG_TMP, 'rules');

function seed() {
  fs.rmSync(RULES_DIR, { recursive: true, force: true });
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RULES_DIR, 'top.md'), '# Top\n\ntop-level rule');
  fs.mkdirSync(path.join(RULES_DIR, 'nested', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(RULES_DIR, 'nested', 'dir', 'deep.md'), '# Deep\n\nnested rule');
  fs.mkdirSync(path.join(RULES_DIR, '.git'), { recursive: true });
  fs.writeFileSync(path.join(RULES_DIR, '.git', 'skip.md'), 'must never be listed');
}

function req(method: string, params: Record<string, string>, body?: unknown, query: Record<string, string> = {}): ParsedRequest {
  return { method, path: '/rules', params, query, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}
const routes = () => createRuleFilesRoutes({} as any);
const route = (method: string, re: RegExp) =>
  routes().find(r => r.method === method && re.test(r.pattern.source))!;

test('GET /rules/list recurses into subdirs and returns POSIX relpaths, skipping dot-dirs', async () => {
  seed();
  const r: any = await route('GET', /list/).handler(req('GET', {}), {} as any);
  assert.equal(r.success, true);
  const filenames = r.data.rules.map((x: any) => x.filename).sort();
  assert.deepEqual(filenames, ['nested/dir/deep.md', 'top.md']);
  // no trace of the skipped dot-dir entry anywhere
  assert.ok(!filenames.some((f: string) => f.includes('.git')));
});

test('GET /rules/list: nested entries carry the same computed fields as top-level ones', async () => {
  seed();
  const r: any = await route('GET', /list/).handler(req('GET', {}), {} as any);
  const nested = r.data.rules.find((x: any) => x.filename === 'nested/dir/deep.md');
  assert.ok(nested);
  assert.equal(nested.source, 'live');
  assert.equal(nested.editable, true);
  assert.equal(nested.title, 'Deep');
  assert.equal(nested.syncedFrom, null);
  assert.equal(typeof nested.size, 'number');
  assert.equal(typeof nested.mtimeMs, 'number');
});

test('GET /rules/file/:relpath round-trips a nested rule by content + hash', async () => {
  seed();
  const r: any = await route('GET', /file/).handler(req('GET', { filename: 'nested/dir/deep.md' }), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.content, '# Deep\n\nnested rule');
  assert.equal(r.data.hash, sha256('# Deep\n\nnested rule'));
});

test('PUT /rules/file/:relpath writes a nested rule (creating parent dirs) and round-trips', async () => {
  seed();
  const content = '# New nested\n\nbody';
  const put: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'brand/new/rule.md' }, { content }), {} as any);
  assert.equal(put.success, true, JSON.stringify(put));
  assert.equal(put.data.hash, sha256(content));
  assert.equal(fs.readFileSync(path.join(RULES_DIR, 'brand', 'new', 'rule.md'), 'utf-8'), content);

  const get: any = await route('GET', /file/).handler(req('GET', { filename: 'brand/new/rule.md' }), {} as any);
  assert.equal(get.success, true);
  assert.equal(get.data.content, content);
});

test('DELETE /rules/file/:relpath removes a nested rule', async () => {
  seed();
  const del: any = await route('DELETE', /file/).handler(req('DELETE', { filename: 'nested/dir/deep.md' }), {} as any);
  assert.equal(del.success, true);
  assert.equal(fs.existsSync(path.join(RULES_DIR, 'nested', 'dir', 'deep.md')), false);

  const missing: any = await route('DELETE', /file/).handler(req('DELETE', { filename: 'nested/dir/deep.md' }), {} as any);
  assert.equal(missing.success, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
});

test('PUT to a synced.<host>.* basename in a subdirectory is PROTECTED', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'sub/synced.117.imported.md' }, { content: 'x' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'PROTECTED');
  assert.equal(fs.existsSync(path.join(RULES_DIR, 'sub', 'synced.117.imported.md')), false);
});

test('PUT rejects traversal in a nested relpath', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'nested/../../escape.md' }, { content: 'x' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'BAD_FILENAME');
});

test('POST /rules/file creates a nested rule with the EXISTS guard intact', async () => {
  seed();
  // rule-files.routes.ts has exactly one POST route (the create route), so
  // method filtering alone disambiguates — any matching pattern regex works.
  const create: any = await route('POST', /file/).handler(
    req('POST', {}, { filename: 'fresh/sub/rule.md', content: 'body' }), {} as any);
  assert.equal(create.success, true);
  const dup: any = await route('POST', /file/).handler(
    req('POST', {}, { filename: 'fresh/sub/rule.md', content: 'other' }), {} as any);
  assert.equal(dup.success, false);
  assert.equal(dup.error.code, 'EXISTS');
});

// ── back-compat: top-level (flat) filename behavior is byte-identical ──

test('GET /rules/list: a flat top-level rule keeps a bare-basename filename (no leading "./")', async () => {
  seed();
  const r: any = await route('GET', /list/).handler(req('GET', {}), {} as any);
  const top = r.data.rules.find((x: any) => x.filename === 'top.md');
  assert.ok(top, 'top-level filename must be the bare basename, unchanged');
  assert.equal(top.filename.includes('/'), false);
});

test('PUT/DELETE on a flat top-level filename behaves exactly as before', async () => {
  seed();
  const content = '# Top v2';
  const put: any = await route('PUT', /file/).handler(req('PUT', { filename: 'top.md' }, { content }), {} as any);
  assert.equal(put.success, true);
  assert.equal(fs.readFileSync(path.join(RULES_DIR, 'top.md'), 'utf-8'), content);

  const del: any = await route('DELETE', /file/).handler(req('DELETE', { filename: 'top.md' }), {} as any);
  assert.equal(del.success, true);
  assert.equal(fs.existsSync(path.join(RULES_DIR, 'top.md')), false);
});

test('PUT a flat synced.* basename is still PROTECTED (unchanged)', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'synced.117.x.md' }, { content: 'x' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'PROTECTED');
});

test('mirrors are separate roots — a mirror host dir is not double-listed under live', async () => {
  seed();
  const mirrorDir = path.join(DATA_TMP, 'rules-mirror', 'peer-a');
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(path.join(mirrorDir, 'inert.md'), '# Inert');
  const r: any = await route('GET', /list/).handler(req('GET', {}), {} as any);
  const live = r.data.rules.filter((x: any) => x.source === 'live');
  const mirror = r.data.rules.filter((x: any) => x.source === 'mirror:peer-a');
  assert.deepEqual(live.map((x: any) => x.filename).sort(), ['nested/dir/deep.md', 'top.md']);
  assert.equal(mirror.length, 1);
  assert.equal(mirror[0].filename, 'inert.md');
  assert.equal(mirror[0].editable, false);
});
