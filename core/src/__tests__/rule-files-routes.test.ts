import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rfr-data-'));
process.env.CLAUDE_CONFIG_DIR = CFG;
process.env.LM_ASSIST_DATA_DIR = DATA;

import { createRuleFilesRoutes } from '../routes/core/rule-files.routes';
import { sha256 } from '../memory/file-write';
import type { ParsedRequest } from '../routes/index';

const RULES = path.join(CFG, 'rules');
const MIRROR = path.join(DATA, 'rules-mirror', 'other-host');

function seed() {
  fs.mkdirSync(RULES, { recursive: true });
  fs.mkdirSync(MIRROR, { recursive: true });
  fs.writeFileSync(path.join(RULES, 'own.md'), '# Own rule\n\nbody');
  fs.writeFileSync(path.join(RULES, 'synced.gw1.remote.md'), '# Synced\n\nfrom gw1');
  fs.writeFileSync(path.join(MIRROR, 'win-only.md'), '---\nos: [windows]\n---\n# Win rule');
}

function req(method: string, params: Record<string, string> = {}, body?: any, query: Record<string, string> = {}): ParsedRequest {
  return { method, path: '/rules', params, query, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}
const routes = () => createRuleFilesRoutes({} as any);
const route = (method: string, re: RegExp) =>
  routes().find(r => r.method === method && re.test(r.pattern.source))!;

test('GET /rules/list returns live + mirror entries with provenance', async () => {
  seed();
  const r: any = await route('GET', /list/).handler(req('GET'), {} as any);
  assert.equal(r.success, true);
  const byName = new Map(r.data.rules.map((x: any) => [`${x.source}:${x.filename}`, x]));
  const own: any = byName.get('live:own.md');
  assert.equal(own.editable, true);
  assert.equal(own.syncedFrom, null);
  assert.equal(own.title, 'Own rule');
  const synced: any = byName.get('live:synced.gw1.remote.md');
  assert.equal(synced.editable, false);
  assert.equal(synced.syncedFrom, 'gw1');
  const mirrored: any = byName.get('mirror:other-host:win-only.md');
  assert.equal(mirrored.editable, false);
  assert.equal(mirrored.active, false);
});

test('GET /rules/file reads live and mirror sources', async () => {
  seed();
  const live: any = await route('GET', /file/).handler(req('GET', { filename: 'own.md' }), {} as any);
  assert.equal(live.data.content.includes('Own rule'), true);
  assert.equal(live.data.hash, sha256(live.data.content));
  const mir: any = await route('GET', /file/).handler(
    req('GET', { filename: 'win-only.md' }, undefined, { source: 'mirror:other-host' }), {} as any);
  assert.equal(mir.data.content.includes('Win rule'), true);
  const bad: any = await route('GET', /file/).handler(
    req('GET', { filename: 'own.md' }, undefined, { source: 'mirror:..' }), {} as any);
  assert.equal(bad.success, false);
});

test('PUT edits own rule; synced.* rejected', async () => {
  seed();
  const r: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'own.md' }, { content: '# Own rule v2' }), {} as any);
  assert.equal(r.success, true);
  const s: any = await route('PUT', /file/).handler(
    req('PUT', { filename: 'synced.gw1.remote.md' }, { content: 'x' }), {} as any);
  assert.equal(s.error.code, 'PROTECTED');
});

test('POST create + DELETE with hash guard', async () => {
  seed();
  const c: any = await route('POST', /file\$/).handler(
    req('POST', {}, { filename: 'brand-new.md', content: '# New' }), {} as any);
  assert.equal(c.success, true);
  const dup: any = await route('POST', /file\$/).handler(
    req('POST', {}, { filename: 'brand-new.md', content: 'again' }), {} as any);
  assert.equal(dup.error.code, 'EXISTS');
  const wrong: any = await route('DELETE', /file/).handler(
    req('DELETE', { filename: 'brand-new.md' }, undefined, { expectedHash: sha256('nope') }), {} as any);
  assert.equal(wrong.error.code, 'HASH_MISMATCH');
  const del: any = await route('DELETE', /file/).handler(
    req('DELETE', { filename: 'brand-new.md' }, undefined, { expectedHash: sha256('# New') }), {} as any);
  assert.equal(del.success, true);
});

test('GET /rules/list computes active for live os-scoped rules (normalized)', async () => {
  seed();
  // A live rule scoped to THIS platform (via the frontmatter alias) must be active;
  // one scoped to a different platform must be inert.
  const here = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'mac' : 'linux';
  const other = os.platform() === 'linux' ? 'windows' : 'linux';
  fs.writeFileSync(path.join(RULES, 'here-only.md'), `---\nos: [${here}]\n---\n# Here rule`);
  fs.writeFileSync(path.join(RULES, 'other-only.md'), `---\nos: [${other}]\n---\n# Other rule`);
  const r: any = await route('GET', /list/).handler(req('GET'), {} as any);
  const byName = new Map(r.data.rules.map((x: any) => [`${x.source}:${x.filename}`, x]));
  const hereRule: any = byName.get('live:here-only.md');
  const otherRule: any = byName.get('live:other-only.md');
  assert.equal(hereRule.active, true, 'alias for current platform must normalize to active');
  assert.deepEqual(hereRule.os, [os.platform()], 'os list must be normalized platform ids');
  assert.equal(otherRule.active, false, 'other-platform rule must be inert');
  // Cross-platform vacuity guard: the OTHER platform's alias always differs from
  // its normalized id in at least one direction (windows→win32), so this line
  // fails if normalizeOsList is dropped — regardless of the host platform.
  const otherId = other === 'windows' ? 'win32' : 'linux';
  assert.deepEqual(otherRule.os, [otherId], 'other-platform alias must be normalized too');
  assert.equal(hereRule.editable, true); // os-scoped but own rule stays editable
});
