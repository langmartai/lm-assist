import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hermetic projects root — set BEFORE importing the routes, same pattern as
// core/src/__tests__/memory-files-routes.test.ts.
const CONFIG_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfw-cfg-'));
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfw-data-'));
process.env.CLAUDE_CONFIG_DIR = CONFIG_TMP;
process.env.LM_ASSIST_DATA_DIR = DATA_TMP;

import { createMemoryFilesRoutes } from '../../routes/core/memory-files.routes';
import { resetMemoryCache } from '../../memory-cache';
import { stopSessionCache } from '../../session-cache';
import { resetProjectsService } from '../../projects-service';
import type { ParsedRequest } from '../../routes/index';

const SLUG = '-tmp-warn-proj';
const MEM_DIR = path.join(CONFIG_TMP, 'projects', SLUG, 'memory');

function seed() {
  fs.rmSync(MEM_DIR, { recursive: true, force: true });
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

function req(method: string, params: Record<string, string>, body?: unknown, query: Record<string, string> = {}): ParsedRequest {
  return { method, path: '/memory', params, query, body, headers: {}, clientIp: '127.0.0.1' } as ParsedRequest;
}
const routes = () => createMemoryFilesRoutes({} as any);
const putRoute = () => routes().find(r => r.method === 'PUT' && /file/.test(r.pattern.source))!;
const postRoute = () => routes().find(r => r.method === 'POST' && /file\$/.test(r.pattern.source))!;
const deleteRoute = () => routes().find(r => r.method === 'DELETE' && /file/.test(r.pattern.source))!;

test('PUT MEMORY.md with plain bullet content (no frontmatter) → warnings: []', async () => {
  seed();
  const content = '# lm-assist Project Memory\n\n## Current Work\n- [some feature](some-feature.md) — done.\n';
  const r: any = await putRoute().handler(
    req('PUT', { projectId: SLUG, filename: 'MEMORY.md' }, { content }), {} as any);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.data.warnings, [], 'MEMORY.md must be exempt from frontmatter warnings');
});

test('PUT MEMORY.md is exempt case-insensitively on the basename stem (Windows-safe)', async () => {
  seed();
  const content = 'plain index content, no frontmatter';
  // Extension case ('.md' vs '.MD') is a separate, pre-existing, unrelated
  // filenameProblem constraint (case-sensitive by design) — not part of this
  // exemption. The Windows-safe /i concern here is the basename STEM only.
  const variants = ['memory.md', 'Memory.md', 'MEMORY.md', 'MeMoRy.md'];
  for (const filename of variants) {
    const r: any = await putRoute().handler(
      req('PUT', { projectId: SLUG, filename }, { content }), {} as any);
    assert.equal(r.success, true, filename);
    assert.deepEqual(r.data.warnings, [], `expected no warnings for ${filename}`);
  }
});

test('PUT other.md without frontmatter → warning present (baseline: exemption is MEMORY.md-specific, not global)', async () => {
  seed();
  const r: any = await putRoute().handler(
    req('PUT', { projectId: SLUG, filename: 'other.md' }, { content: 'no frontmatter here' }), {} as any);
  assert.equal(r.success, true);
  assert.ok(r.data.warnings.length >= 1, 'a non-MEMORY.md file without frontmatter must still warn');
  assert.match(r.data.warnings[0], /frontmatter/i);
});

test('POST create: MEMORY.md (creation) is also exempt', async () => {
  seed();
  const r: any = await postRoute().handler(
    req('POST', { projectId: SLUG }, { filename: 'MEMORY.md', content: '# Index\n- bullet\n' }), {} as any);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.data.warnings, []);
});

test('POST create: non-MEMORY.md file without frontmatter still warns (regression guard)', async () => {
  seed();
  const r: any = await postRoute().handler(
    req('POST', { projectId: SLUG }, { filename: 'newthing.md', content: 'plain body' }), {} as any);
  assert.equal(r.success, true);
  assert.ok(r.data.warnings.length >= 1);
});

// ─── memory writes must stay FLAT — nested filenames are refused, not
// silently treated as relpaths. The memory read/list pipeline (MemoryApi /
// memory-map) is flat-only, so a nested write would create a file the UI can
// never see again ("invisible orphan"). rule-files.routes.ts opts into
// nested writes via `allowNested: true`; memory-files.routes.ts must NEVER
// pass that flag. These are route-level regression tests, not just
// file-write.ts unit tests, so a future accidental `allowNested: true` on
// the memory routes is caught here too. ────────────────────────────────

test('PUT with a URL-encoded nested filename (sub%2Fx.md) → BAD_FILENAME', async () => {
  seed();
  const r: any = await putRoute().handler(
    req('PUT', { projectId: SLUG, filename: 'sub/x.md' }, { content: 'body' }), {} as any);
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.error.code, 'BAD_FILENAME');
  assert.equal(fs.existsSync(path.join(MEM_DIR, 'sub', 'x.md')), false, 'must not create the nested file');
  assert.equal(fs.existsSync(path.join(MEM_DIR, 'sub')), false, 'must not even create the parent dir');
});

test('POST create with filename "sub/x.md" → BAD_FILENAME', async () => {
  seed();
  const r: any = await postRoute().handler(
    req('POST', { projectId: SLUG }, { filename: 'sub/x.md', content: 'body' }), {} as any);
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.error.code, 'BAD_FILENAME');
  assert.equal(fs.existsSync(path.join(MEM_DIR, 'sub', 'x.md')), false);
});

test('DELETE "sub/x.md" → BAD_FILENAME', async () => {
  seed();
  // Seed a file at the WOULD-BE nested path directly on disk (bypassing the
  // route) so a false "NOT_FOUND" can't masquerade as the refusal we expect.
  fs.mkdirSync(path.join(MEM_DIR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(MEM_DIR, 'sub', 'x.md'), 'body');
  const r: any = await deleteRoute().handler(
    req('DELETE', { projectId: SLUG, filename: 'sub/x.md' }), {} as any);
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.error.code, 'BAD_FILENAME');
  assert.equal(fs.existsSync(path.join(MEM_DIR, 'sub', 'x.md')), true, 'refused delete must leave the file in place');
});

after(() => {
  resetMemoryCache();
  stopSessionCache();
  resetProjectsService();
  fs.rmSync(CONFIG_TMP, { recursive: true, force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
});
