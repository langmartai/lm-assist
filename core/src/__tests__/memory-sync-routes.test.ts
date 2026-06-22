import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic projects root for the export/ingest handlers (read at call time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-'));
process.env.CLAUDE_CONFIG_DIR = TMP;

import { createMemorySyncRoutes } from '../routes/core/memory-sync.routes';
import type { ParsedRequest } from '../routes/index';

const SLUG = '-tmp-proj';
function seedMemory() {
  const dir = path.join(TMP, 'projects', SLUG, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project_foo.md'),
    '---\nname: foo\ndescription: a portable project fact\ntype: project\n---\nthe body');
  fs.writeFileSync(path.join(dir, 'scratch.md'),
    '---\nname: scratch\ndescription: d\ntype: project\npersistence: temporary\n---\nscratch body');
  fs.writeFileSync(path.join(dir, 'chrome_notes.md'),
    '---\nname: chrome\ndescription: d\ntype: project\n---\nhost stuff'); // host-local by filename
}

function localReq(body: any): ParsedRequest {
  return { method: 'POST', path: '/memory/export', params: {}, query: {}, body,
    headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}
function routes() { return createMemorySyncRoutes({} as any); }
function route(method: string, re: RegExp) {
  return routes().find(r => r.method === method && re.test(r.pattern.source))!;
}

test('exposes POST /memory/export and POST /memory/ingest', () => {
  const paths = routes().map(r => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some(p => p.startsWith('POST') && /memory.{1,3}export/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('POST') && /memory.{1,3}ingest/.test(p)), paths.join(','));
});

test('export returns only syncable (persistent, non-host-local) records', async () => {
  seedMemory();
  const r: any = await route('POST', /export/).handler(localReq({ project: SLUG }), {} as any);
  assert.equal(r.success, true);
  const files = r.data.records.map((x: any) => x.file).sort();
  assert.deepEqual(files, ['project_foo.md']); // scratch (temporary) + chrome (host-local) excluded
  assert.match(r.data.records[0].content, /name: foo/); // whole file, incl frontmatter
  assert.equal(typeof r.data.records[0].contentHash, 'string');
});

test('export of a bogus project is shaped + empty', async () => {
  const r: any = await route('POST', /export/).handler(localReq({ project: '__nope__' }), {} as any);
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.data.records));
  assert.equal(r.data.records.length, 0);
});

test('export requires a project', async () => {
  const r: any = await route('POST', /export/).handler(localReq({}), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('unauthorized (not loopback, not relayed) is rejected', async () => {
  const req = { method: 'POST', path: '/memory/export', params: {}, query: {},
    body: { project: SLUG }, headers: {}, clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('relayed call (x-relay-source:hub + body key) is authorized', async () => {
  const req = { method: 'POST', path: '/memory/export', params: {}, query: {},
    body: { project: SLUG, key: 'sk-xyz' }, headers: { 'x-relay-source': 'hub' },
    clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, true);
});

test('ingest writes peer records under the project mirror', async () => {
  const body = { project: SLUG, sourceHost: 'gw-peer',
    records: [{ file: 'p.md', content: 'peer content', contentHash: 'ph1' }] };
  const r: any = await route('POST', /ingest/).handler(localReq(body), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.ingested, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'projects', SLUG, 'memory', 'gw-peer', 'p.md')));
});

test('ingest validates required fields', async () => {
  const r: any = await route('POST', /ingest/).handler(localReq({ project: SLUG }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});
