import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic projects root for the export/ingest handlers (read at call time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
// Redirect ~/.lm-assist so the enable/pull config writes can't touch the real node config.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-cfg-'));

import { createMemorySyncRoutes } from '../routes/core/memory-sync.routes';
import { readMemorySyncConfig } from '../memory/node-mode';
import { decodePath, legacyEncodeProjectPath } from '../utils/path-utils';
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

test('relayed call (loopback + x-relay-source:hub + body key) is authorized', async () => {
  const req = { method: 'POST', path: '/memory/export', params: {}, query: {},
    body: { project: SLUG, key: 'sk-xyz' }, headers: { 'x-relay-source': 'hub' },
    clientIp: '127.0.0.1' } as ParsedRequest; // the relay always reaches Core over loopback
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, true);
});

test('a REMOTE caller spoofing x-relay-source:hub is still rejected (loopback-gated)', async () => {
  const req = { method: 'POST', path: '/memory/export', params: {}, query: {},
    body: { project: SLUG, key: 'sk-anything' }, headers: { 'x-relay-source': 'hub' },
    clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('export skips credential-shaped filenames', async () => {
  // seedMemory() (called above) wrote only safe files; add a credential-named one here.
  const dir = path.join(TMP, 'projects', SLUG, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project_api_token.md'), '---\nname: tok\ndescription: d\ntype: project\n---\nsecret-ish');
  const r: any = await route('POST', /export/).handler(localReq({ project: SLUG }), {} as any);
  const files = r.data.records.map((x: any) => x.file);
  assert.ok(!files.includes('project_api_token.md'), files.join(','));
});

test('ingest writes peer records under the decoded repo mirror (<cwd>/memory/<host>/)', async () => {
  // A real repo cwd with no internal dashes → unambiguous decodePath round-trip.
  const REPO = path.join(os.tmpdir(), 'msringestrepo' + process.pid);
  fs.mkdirSync(REPO, { recursive: true });
  const SLUG = legacyEncodeProjectPath(REPO);
  fs.mkdirSync(path.join(TMP, 'projects', SLUG), { recursive: true }); // register the project (allow-list)
  try {
    const body = { project: SLUG, sourceHost: 'gw-peer',
      records: [{ file: 'p.md', content: 'peer content', contentHash: 'ph1' }] };
    const r: any = await route('POST', /ingest/).handler(localReq(body), {} as any);
    assert.equal(r.success, true);
    assert.equal(r.data.ingested, 1);
    assert.ok(fs.existsSync(path.join(REPO, 'memory', 'gw-peer', 'p.md')), `expected mirror under ${REPO}/memory/gw-peer`);
  } finally {
    fs.rmSync(REPO, { recursive: true, force: true });
  }
});

test('ingest refuses an unknown project (allow-list blocks arbitrary write roots)', async () => {
  const body = { project: '-etc', sourceHost: 'gw-peer', records: [{ file: 'p.md', content: 'x', contentHash: 'h' }] };
  const r: any = await route('POST', /ingest/).handler(localReq(body), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('ingest validates required fields', async () => {
  const r: any = await route('POST', /ingest/).handler(localReq({ project: SLUG }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('exposes POST /memory/sync/enable and POST /memory/pull', () => {
  const paths = routes().map(r => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some(p => p.startsWith('POST') && /sync.{1,3}enable/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('POST') && /memory.{1,3}pull/.test(p)), paths.join(','));
});

test('sync/enable persists ephemeral config (pull is a no-op without a hub key)', async () => {
  const r: any = await route('POST', /enable/).handler(
    localReq({ homeNode: 'gw-home', homeProject: '-home-x', project: '-cloud-x' }), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.configured, true);
  assert.equal(r.data.pulled, 0); // no hub apiKey in the test env
  const cfg = readMemorySyncConfig();
  assert.equal(cfg.nodeMode, 'ephemeral');
  assert.equal(cfg.homeNode, 'gw-home');
  assert.equal(cfg.homeProject, '-home-x');
  assert.equal(cfg.project, '-cloud-x');
});

test('sync/enable requires homeNode + homeProject', async () => {
  const r: any = await route('POST', /enable/).handler(localReq({ homeNode: 'gw-home' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

test('sync/enable and pull are local-only', async () => {
  const remote = { method: 'POST', path: '/memory/pull', params: {}, query: {},
    body: {}, headers: { 'x-relay-source': 'hub' }, clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /memory.{1,3}pull/).handler(remote, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('GET /memory/sync/status returns config + daemon shape', async () => {
  const r: any = await route('GET', /sync.{1,3}status/).handler({ params: {}, query: {} } as any, {} as any);
  assert.equal(r.success, true);
  assert.equal(typeof r.data.config.nodeMode, 'string');
  assert.ok('homeNode' in r.data.config && 'homeProject' in r.data.config);
  assert.ok(r.data.daemon && typeof r.data.daemon.mode === 'string');
});
