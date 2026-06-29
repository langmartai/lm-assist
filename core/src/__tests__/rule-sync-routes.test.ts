import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic claude rules dir + lm-assist data dir BEFORE importing the routes (read at call time).
const CLAUDE = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-claude-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-data-'));

import { createRuleSyncRoutes } from '../routes/core/rule-sync.routes';
import type { ParsedRequest } from '../routes/index';

function rulesDir() { return path.join(CLAUDE, 'rules'); }
function seed() {
  fs.mkdirSync(rulesDir(), { recursive: true });
  fs.writeFileSync(path.join(rulesDir(), 'always.md'), '---\nname: a\n---\nbody');
  fs.writeFileSync(path.join(rulesDir(), 'winonly.md'), '---\nos: windows\n---\nW');
  fs.writeFileSync(path.join(rulesDir(), 'synced.peer.x.md'), '---\nname: x\n---\nx'); // must NOT export
  fs.writeFileSync(path.join(rulesDir(), 'api_key.md'), 'secret');                      // must NOT export
}
function routes() { return createRuleSyncRoutes({} as any); }
function route(method: string, re: RegExp) { return routes().find(r => r.method === method && re.test(r.pattern.source))!; }
function localReq(p: string, body: any): ParsedRequest {
  return { method: 'POST', path: p, params: {}, query: {}, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}

test('exposes the 4 rule-sync routes', () => {
  const paths = routes().map(r => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some(p => p.startsWith('POST') && /rules.{1,3}export/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('POST') && /rules.{1,3}ingest/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('GET') && /rules.{1,3}sync.{1,3}status/.test(p)), paths.join(','));
  assert.ok(paths.some(p => p.startsWith('GET') && /rules.{1,3}autosync.{1,3}status/.test(p)), paths.join(','));
});

test('export returns own rules only (excludes synced.* + credential names) with os fields', async () => {
  seed();
  const r: any = await route('POST', /export/).handler(localReq('/rules/export', {}), {} as any);
  assert.equal(r.success, true);
  const files = r.data.rules.map((x: any) => x.file).sort();
  assert.deepEqual(files, ['always.md', 'winonly.md']);
  assert.equal(typeof r.data.host, 'string');
  assert.equal(typeof r.data.platform, 'string');
  const win = r.data.rules.find((x: any) => x.file === 'winonly.md');
  assert.deepEqual(win.os, ['win32']);
  assert.equal(win.osDependent, true);
});

test('unauthorized (not loopback, not relayed) export is rejected', async () => {
  const req = { method: 'POST', path: '/rules/export', params: {}, query: {}, body: {}, headers: {}, clientIp: '10.0.0.9' } as ParsedRequest;
  const r: any = await route('POST', /export/).handler(req, {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'FORBIDDEN');
});

test('relayed export (loopback + x-relay-source:hub) requires a body key', async () => {
  const noKey = { method: 'POST', path: '/rules/export', params: {}, query: {}, body: {}, headers: { 'x-relay-source': 'hub' }, clientIp: '127.0.0.1' } as ParsedRequest;
  assert.equal((await route('POST', /export/).handler(noKey, {} as any) as any).error.code, 'FORBIDDEN');
  const withKey = { ...noKey, body: { key: 'sk-x' } } as ParsedRequest;
  assert.equal((await route('POST', /export/).handler(withKey, {} as any) as any).success, true);
});

test('ingest places rules via the OS router (active vs mirror) and is confined', async () => {
  const sha = (s: string) => require('crypto').createHash('sha256').update(s).digest('hex');
  const body = { sourceHost: '117', sourcePlatform: 'linux', rules: [
    { file: 'shared.md', content: 'S', contentHash: sha('S') },                                   // os:[] → active
    { file: 'lin.md', content: '---\nos: linux\n---\nL', contentHash: sha('---\nos: linux\n---\nL'), os: ['linux'] },
    { file: '../evil.md', content: 'E', contentHash: sha('E') },                                  // rejected
  ] };
  const r: any = await route('POST', /ingest/).handler(localReq('/rules/ingest', body), {} as any);
  assert.equal(r.success, true);
  assert.equal(r.data.applied, 2);
  assert.ok(!fs.existsSync(path.join(CLAUDE, 'rules', 'synced.117.-evil.md')));
});

test('ingest validates required fields', async () => {
  const r: any = await route('POST', /ingest/).handler(localReq('/rules/ingest', { sourceHost: '117' }), {} as any);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});
