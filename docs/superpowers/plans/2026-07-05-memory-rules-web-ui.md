# Memory + Rules Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sidebar **Memory** page (tabs: Memory | Rules | Sync) that browses, searches, and edits project memory and user rules on any node, per spec `docs/superpowers/specs/2026-07-05-memory-rules-web-ui-design.md`.

**Architecture:** Thin web UI over the existing record map (`/memory/map`, `/rules/map`) and file-read endpoints, plus new small path-confined file-write routes (`memory-files.routes.ts`, `rule-files.routes.ts`) sharing one fs helper (`core/src/memory/file-write.ts`). All web fetches go through `useAppMode().apiClient.fetchPath(path, {machineId})` so node targeting, auth, and `_coreapi` routing come free.

**Tech Stack:** TypeScript, raw-Node HTTP route objects (`RouteHandler`), node:test, Next.js 16 + React 19 + Tailwind, react-markdown (already a web dep).

## Global Constraints

- Core is CommonJS; do not add ESM-only deps. Do not touch the chokidar pin (`^3.6.0`).
- Never hardcode ports. Web calls go through `apiClient.fetchPath` ONLY — no raw `fetch()` to core endpoints (web-core-fetch-rules).
- Web build requires Node ≥ 20.9: prefix web commands with `export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH`.
- Core tests: files in `core/src/__tests__/*.test.ts`, node:test runner, hermetic env (`CLAUDE_CONFIG_DIR`, `LM_ASSIST_DATA_DIR` tmp dirs) set BEFORE importing the module under test.
- Route responses use `wrapResponse(data, start)` / `wrapError(code, message, start)` from `core/src/api/helpers`. Error messages MUST start with their code (e.g. `HASH_MISMATCH: …`) — the web string-matches codes from thrown Error messages.
- Write-safety (spec): filenames `^[A-Za-z0-9._-]+\.md$`, bare basename, no leading dot; memory-protected: `_cross-project.md`, `_hosts.md`; rules-protected: `synced.*`; `MEMORY.md` editable; mirrors never writable.
- Commit after every task (conventional commits).
- Do NOT deploy to prod/fleet; dev only (`./core.sh` on :3200/:3948). Fleet rollout is a separate user-gated step.

---

### Task 1: Shared fs helper `file-write.ts`

**Files:**
- Create: `core/src/memory/file-write.ts`
- Test: `core/src/__tests__/memory-file-write.test.ts`

**Interfaces:**
- Consumes: nothing (pure fs + crypto).
- Produces (used by Tasks 2 and 3):

```ts
export type FileWriteErrorCode = 'BAD_FILENAME' | 'PROTECTED' | 'EXISTS' | 'NOT_FOUND' | 'HASH_MISMATCH';
export interface FileOpResult { ok: boolean; code?: FileWriteErrorCode; hash?: string }
export function sha256(s: string): string;
export function filenameProblem(filename: string, protectedPatterns?: RegExp[]): FileWriteErrorCode | null;
export function writeMdFile(dir: string, filename: string, content: string,
  opts?: { expectedHash?: string; mustNotExist?: boolean; protectedPatterns?: RegExp[] }): FileOpResult;
export function deleteMdFile(dir: string, filename: string,
  opts?: { expectedHash?: string; protectedPatterns?: RegExp[] }): FileOpResult;
export function appendIndexLine(memoryDir: string, line: string): void;
export function removeIndexLines(memoryDir: string, filename: string): number;
```

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/memory-file-write.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  sha256, filenameProblem, writeMdFile, deleteMdFile,
  appendIndexLine, removeIndexLines,
} from '../memory/file-write';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mfw-')); }
const PROTECTED = [/^_cross-project\.md$/i, /^_hosts\.md$/i];

test('filenameProblem rejects traversal, separators, dotfiles, non-md', () => {
  assert.equal(filenameProblem('ok-file.md'), null);
  assert.equal(filenameProblem('MEMORY.md'), null);
  assert.equal(filenameProblem('../evil.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('a/b.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('a\\b.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('.hashes.json'), 'BAD_FILENAME');
  assert.equal(filenameProblem('.dot.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('note.txt'), 'BAD_FILENAME');
  assert.equal(filenameProblem('spaced name.md'), 'BAD_FILENAME');
  assert.equal(filenameProblem('_hosts.md', PROTECTED), 'PROTECTED');
  assert.equal(filenameProblem('_cross-project.md', PROTECTED), 'PROTECTED');
  assert.equal(filenameProblem('synced.gw1.foo.md', [/^synced\./]), 'PROTECTED');
});

test('writeMdFile writes and returns the new hash', () => {
  const dir = tmpDir();
  const r = writeMdFile(dir, 'a.md', 'hello');
  assert.equal(r.ok, true);
  assert.equal(r.hash, sha256('hello'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'hello');
});

test('writeMdFile mustNotExist → EXISTS on second write', () => {
  const dir = tmpDir();
  assert.equal(writeMdFile(dir, 'a.md', 'x', { mustNotExist: true }).ok, true);
  const r = writeMdFile(dir, 'a.md', 'y', { mustNotExist: true });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'EXISTS' });
});

test('writeMdFile expectedHash mismatch → HASH_MISMATCH, file untouched', () => {
  const dir = tmpDir();
  writeMdFile(dir, 'a.md', 'v1');
  const r = writeMdFile(dir, 'a.md', 'v2', { expectedHash: sha256('OTHER') });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'HASH_MISMATCH' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf-8'), 'v1');
  // correct hash succeeds
  assert.equal(writeMdFile(dir, 'a.md', 'v2', { expectedHash: sha256('v1') }).ok, true);
  // expectedHash against a missing file also mismatches
  const r2 = writeMdFile(dir, 'gone.md', 'x', { expectedHash: sha256('v1') });
  assert.deepEqual({ ok: r2.ok, code: r2.code }, { ok: false, code: 'HASH_MISMATCH' });
});

test('deleteMdFile honors NOT_FOUND, hash guard, protection', () => {
  const dir = tmpDir();
  assert.equal(deleteMdFile(dir, 'a.md').code, 'NOT_FOUND');
  writeMdFile(dir, 'a.md', 'v1');
  assert.equal(deleteMdFile(dir, 'a.md', { expectedHash: sha256('nope') }).code, 'HASH_MISMATCH');
  assert.equal(deleteMdFile(dir, '_hosts.md', { protectedPatterns: PROTECTED }).code, 'PROTECTED');
  assert.equal(deleteMdFile(dir, 'a.md', { expectedHash: sha256('v1') }).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'a.md')), false);
});

test('appendIndexLine creates MEMORY.md and appends with clean newlines', () => {
  const dir = tmpDir();
  appendIndexLine(dir, '- [A](a.md) — hook');
  appendIndexLine(dir, '- [B](b.md) — hook2');
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.match(idx, /\- \[A\]\(a\.md\) — hook\n/);
  assert.match(idx, /\- \[B\]\(b\.md\) — hook2\n$/);
});

test('removeIndexLines removes only lines linking the filename', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'),
    '# Index\n- [A](a.md) — keep?\n- [B](b.md) — other\n- [A2](./a.md) — dotted\n');
  const n = removeIndexLines(dir, 'a.md');
  assert.equal(n, 2);
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.equal(idx.includes('a.md'), false);
  assert.equal(idx.includes('(b.md)'), true);
  assert.equal(removeIndexLines(dir, 'zzz.md'), 0);     // no-op
  assert.equal(removeIndexLines(tmpDir(), 'a.md'), 0);  // no MEMORY.md → 0, no throw
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test
```
Expected: tsc FAILS with "Cannot find module '../memory/file-write'".

- [ ] **Step 3: Write the implementation**

`core/src/memory/file-write.ts`:

```ts
/**
 * Confined markdown file writes for the Memory/Rules web editor.
 * Mirrors the defense-in-depth idioms of memory/ingest.ts: bare `*.md`
 * basenames only, resolved path must stay inside the target dir, and
 * caller-supplied protected patterns (managed files, synced.* rules)
 * are rejected before any fs touch. `expectedHash` gives the editor
 * optimistic concurrency against the sync daemons that also write here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type FileWriteErrorCode = 'BAD_FILENAME' | 'PROTECTED' | 'EXISTS' | 'NOT_FOUND' | 'HASH_MISMATCH';
export interface FileOpResult { ok: boolean; code?: FileWriteErrorCode; hash?: string }

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function filenameProblem(filename: string, protectedPatterns: RegExp[] = []): FileWriteErrorCode | null {
  if (!filename || filename !== path.basename(filename)) return 'BAD_FILENAME';
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return 'BAD_FILENAME';
  if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) return 'BAD_FILENAME';
  if (filename.startsWith('.')) return 'BAD_FILENAME';
  if (protectedPatterns.some((re) => re.test(filename))) return 'PROTECTED';
  return null;
}

function confinedPath(dir: string, filename: string): string | null {
  const dest = path.join(dir, filename);
  if (path.dirname(path.resolve(dest)) !== path.resolve(dir)) return null; // defense-in-depth
  return dest;
}

export function writeMdFile(
  dir: string, filename: string, content: string,
  opts: { expectedHash?: string; mustNotExist?: boolean; protectedPatterns?: RegExp[] } = {},
): FileOpResult {
  const bad = filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = confinedPath(dir, filename);
  if (!dest) return { ok: false, code: 'BAD_FILENAME' };
  const exists = fs.existsSync(dest);
  if (opts.mustNotExist && exists) return { ok: false, code: 'EXISTS' };
  if (opts.expectedHash) {
    if (!exists) return { ok: false, code: 'HASH_MISMATCH' };
    const current = sha256(fs.readFileSync(dest, 'utf-8'));
    if (current !== opts.expectedHash) return { ok: false, code: 'HASH_MISMATCH' };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, content);
  return { ok: true, hash: sha256(content) };
}

export function deleteMdFile(
  dir: string, filename: string,
  opts: { expectedHash?: string; protectedPatterns?: RegExp[] } = {},
): FileOpResult {
  const bad = filenameProblem(filename, opts.protectedPatterns || []);
  if (bad) return { ok: false, code: bad };
  const dest = confinedPath(dir, filename);
  if (!dest) return { ok: false, code: 'BAD_FILENAME' };
  if (!fs.existsSync(dest)) return { ok: false, code: 'NOT_FOUND' };
  if (opts.expectedHash) {
    const current = sha256(fs.readFileSync(dest, 'utf-8'));
    if (current !== opts.expectedHash) return { ok: false, code: 'HASH_MISMATCH' };
  }
  fs.unlinkSync(dest);
  return { ok: true };
}

/** Append one line to <memoryDir>/MEMORY.md (created if missing), keeping a trailing newline. */
export function appendIndexLine(memoryDir: string, line: string): void {
  const idx = path.join(memoryDir, 'MEMORY.md');
  let cur = '';
  try { cur = fs.readFileSync(idx, 'utf-8'); } catch { /* create below */ }
  if (cur && !cur.endsWith('\n')) cur += '\n';
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(idx, cur + line.trimEnd() + '\n');
}

/** Remove MEMORY.md lines whose markdown link targets the filename: `](<file>)` or `](./<file>)`. */
export function removeIndexLines(memoryDir: string, filename: string): number {
  const idx = path.join(memoryDir, 'MEMORY.md');
  let cur: string;
  try { cur = fs.readFileSync(idx, 'utf-8'); } catch { return 0; }
  const lines = cur.split('\n');
  const kept = lines.filter((l) => !l.includes(`](${filename})`) && !l.includes(`](./${filename})`));
  const removed = lines.length - kept.length;
  if (removed > 0) fs.writeFileSync(idx, kept.join('\n'));
  return removed;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test && \
  node --test --test-reporter=spec dist-test/__tests__/memory-file-write.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/memory/file-write.ts core/src/__tests__/memory-file-write.test.ts && \
  git commit -m "feat(memory): confined md file-write helper (hash-guarded, protected patterns)"
```

---

### Task 2: Memory file write routes (+ file-read hash/fallback)

**Files:**
- Create: `core/src/routes/core/memory-files.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import + spread, next to `createMemorySyncRoutes`)
- Modify: `core/src/api/memory-api.ts` (`getFile`: add `hash` field + live-dir disk fallback so `MEMORY.md`/managed files are viewable — the cache excludes them from `files`, verified live: `GET …/file/MEMORY.md` → `FILE_NOT_FOUND` today)
- Test: `core/src/__tests__/memory-files-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 helper; `wrapResponse`/`wrapError` from `../../api/helpers`; `getProjectsDir` from `../../utils/path-utils`; `parseFrontmatter`, `isValidMemoryFrontmatter` from `../../utils/frontmatter`; `createMemoryApiImpl` from `../../api/memory-api` (its `clear(projectId)` invalidates the shared `getMemoryCache()` singleton).
- Produces (consumed by web Tasks 5/6):
  - `PUT /memory/by-project/:projectId/file/:filename` body `{content, expectedHash?}` → `{projectId, filename, hash, warnings: string[]}`
  - `POST /memory/by-project/:projectId/file` body `{filename, content, indexLine?}` → `{projectId, filename, hash, warnings, indexUpdated: boolean}`
  - `DELETE /memory/by-project/:projectId/file/:filename` (query or body: `expectedHash?`, `removeIndexLine?`) → `{projectId, filename, deleted: true, indexUpdated: boolean}`
  - Error codes (message starts with code): `INVALID_INPUT`, `PROJECT_NOT_FOUND`, `BAD_FILENAME`, `PROTECTED`, `EXISTS`, `NOT_FOUND`, `HASH_MISMATCH`.
  - `GET /memory/by-project/:id/file/:name` (existing route, patched here) → `{projectId, source, filename, filePath, frontmatter, body, mtimeMs, sizeBytes, hash}` — web binds **`body`** and **`hash`**; `MEMORY.md` and managed files are now served for source=live via the disk fallback (read-only viewing; writes still guarded by Task 1 protection).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/memory-files-routes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test
```
Expected: tsc FAILS with "Cannot find module '../routes/core/memory-files.routes'".

- [ ] **Step 3a: Patch `getFile` in `core/src/api/memory-api.ts` (hash + live disk fallback)**

Replace the body of `getFile` (currently at ~line 548, `getFile: async (projectId, source, filename) => {…}`) with:

```ts
    getFile: async (projectId, source, filename) => {
      const start = Date.now();
      try {
        const cwd = resolveProjectIdToCwd(projectId);
        if (!cwd) return wrapError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, start);
        const { snapshot, dirs } = cache.getForProject(cwd, {
          sources: source === 'live' ? 'live' : 'repo',
          hostFilter: source.startsWith('repo:') ? [source.slice(5)] : undefined,
        });
        const target = dirs.find(d => d.source === source);
        const file = target?.files.find(f => f.filename === filename);
        if (file) {
          const body = cache.getFileBody(file.filePath) || '';
          const resp: MemoryFileResponse = {
            projectId: legacyEncodeProjectPath(cwd),
            source, filename,
            filePath: file.filePath,
            frontmatter: file.frontmatter,
            body,
            mtimeMs: file.mtimeMs,
            sizeBytes: file.sizeBytes,
            hash: fileSha256(body),
          };
          return wrapResponse(resp, start);
        }
        // Disk fallback (live only): the cache intentionally excludes MEMORY.md and
        // managed files from `files`, but the web viewer/editor needs to read them.
        if (source === 'live' && /^[A-Za-z0-9._-]+\.md$/.test(filename) && !filename.startsWith('.')
            && filename === path.basename(filename) && fs.existsSync(path.join(snapshot.liveDir, filename))) {
          const filePath = path.join(snapshot.liveDir, filename);
          const body = fs.readFileSync(filePath, 'utf-8');
          const st = fs.statSync(filePath);
          const resp: MemoryFileResponse = {
            projectId: legacyEncodeProjectPath(cwd),
            source, filename, filePath,
            frontmatter: parseFrontmatter(body).frontmatter,
            body,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            hash: fileSha256(body),
          };
          return wrapResponse(resp, start);
        }
        if (!target) return wrapError('SOURCE_NOT_FOUND', `Source not found: ${source}`, start);
        return wrapError('FILE_NOT_FOUND', `File not found: ${filename}`, start);
      } catch (e) {
        return wrapError('MEMORY_FILE_ERROR', String(e), start);
      }
    },
```

Supporting edits in the same file: add `hash?: string` to the `MemoryFileResponse` interface; add imports `import { sha256 as fileSha256 } from '../memory/file-write';` and (if not present) `import { parseFrontmatter } from '../utils/frontmatter';` — `fs`/`path` are already imported there.

- [ ] **Step 3b: Write the routes**

`core/src/routes/core/memory-files.routes.ts`:

```ts
/**
 * Memory file WRITE routes — the web editor's mutation surface.
 *
 *   PUT    /memory/by-project/:projectId/file/:filename   { content, expectedHash? }
 *   POST   /memory/by-project/:projectId/file             { filename, content, indexLine? }
 *   DELETE /memory/by-project/:projectId/file/:filename   ?expectedHash=&removeIndexLine=true (query or body)
 *
 * Writes are confined to `<projectsDir>/<slug>/memory/` for a slug that is
 * already registered on this node (same allow-list idea as memory-sync's
 * resolveKnownProjectCwd — a relayed projectId can never decode to an
 * arbitrary path). Managed files and mirrors are not writable. Error
 * messages start with their code so the web client can match on them.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getProjectsDir } from '../../utils/path-utils';
import { parseFrontmatter, isValidMemoryFrontmatter } from '../../utils/frontmatter';
import { writeMdFile, deleteMdFile, appendIndexLine, removeIndexLines } from '../../memory/file-write';
import { createMemoryApiImpl, MemoryApi } from '../../api/memory-api';

const MEMORY_PROTECTED = [/^_cross-project\.md$/i, /^_hosts\.md$/i];

let memoryApi: MemoryApi | null = null;
function getApi(): MemoryApi {
  if (!memoryApi) memoryApi = createMemoryApiImpl();
  return memoryApi; // clear() hits the shared getMemoryCache() singleton
}

/** Allow-list resolution: slug must be a safe single segment AND a registered project dir. */
function resolveLiveMemoryDir(slug: string | undefined): string | null {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null;
  const projectDir = path.join(getProjectsDir(), slug);
  if (!fs.existsSync(projectDir)) return null;
  return path.join(projectDir, 'memory');
}

function frontmatterWarnings(content: string): string[] {
  const warnings: string[] = [];
  const pf = parseFrontmatter(content);
  if (!pf.hasFrontmatter) warnings.push('no frontmatter block (--- … ---) — record extraction will use defaults');
  else {
    if (!pf.frontmatter.name) warnings.push('frontmatter missing `name`');
    if (!pf.frontmatter.description) warnings.push('frontmatter missing `description`');
    if (!isValidMemoryFrontmatter(pf.frontmatter)) warnings.push('frontmatter missing/unknown `type`');
  }
  return warnings;
}

function bodyOf(req: ParsedRequest): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

async function invalidate(projectId: string): Promise<void> {
  try { await getApi().clear(projectId); } catch { /* cache refreshes via watcher anyway */ }
}

export function createMemoryFilesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // PUT /memory/by-project/:projectId/file/:filename
    {
      method: 'PUT',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const filename = decodeURIComponent(req.params.filename);
        const { content, expectedHash } = bodyOf(req) as { content?: string; expectedHash?: string };
        if (typeof content !== 'string') return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.content (string) required', start);
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = writeMdFile(dir, filename, content, {
          expectedHash: typeof expectedHash === 'string' ? expectedHash : undefined,
          protectedPatterns: MEMORY_PROTECTED,
        });
        if (!r.ok) return wrapError(r.code!, `${r.code}: write refused for ${filename}`, start);
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, hash: r.hash, warnings: frontmatterWarnings(content) }, start);
      },
    },
    // POST /memory/by-project/:projectId/file  (create)
    {
      method: 'POST',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const { filename, content, indexLine } = bodyOf(req) as { filename?: string; content?: string; indexLine?: string };
        if (typeof filename !== 'string' || typeof content !== 'string') {
          return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.filename and body.content required', start);
        }
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = writeMdFile(dir, filename, content, { mustNotExist: true, protectedPatterns: MEMORY_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: create refused for ${filename}`, start);
        let indexUpdated = false;
        if (typeof indexLine === 'string' && indexLine.trim()) {
          appendIndexLine(dir, indexLine);
          indexUpdated = true;
        }
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, hash: r.hash, warnings: frontmatterWarnings(content), indexUpdated }, start);
      },
    },
    // DELETE /memory/by-project/:projectId/file/:filename
    {
      method: 'DELETE',
      pattern: /^\/memory\/by-project\/(?<projectId>[^/]+)\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const projectId = decodeURIComponent(req.params.projectId);
        const filename = decodeURIComponent(req.params.filename);
        const b = bodyOf(req) as { expectedHash?: string; removeIndexLine?: boolean };
        const expectedHash = (req.query.expectedHash as string) || (typeof b.expectedHash === 'string' ? b.expectedHash : undefined);
        const removeIdx = req.query.removeIndexLine === 'true' || b.removeIndexLine === true;
        const dir = resolveLiveMemoryDir(projectId);
        if (!dir) return wrapError('PROJECT_NOT_FOUND', `PROJECT_NOT_FOUND: ${projectId}`, start);
        const r = deleteMdFile(dir, filename, { expectedHash, protectedPatterns: MEMORY_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: delete refused for ${filename}`, start);
        let indexUpdated = false;
        if (removeIdx) indexUpdated = removeIndexLines(dir, filename) > 0;
        await invalidate(projectId);
        return wrapResponse({ projectId, filename, deleted: true, indexUpdated }, start);
      },
    },
  ];
}
```

- [ ] **Step 4: Register the routes**

In `core/src/routes/core/index.ts`: add next to the existing memory imports/spreads:

```ts
import { createMemoryFilesRoutes } from './memory-files.routes';
// …in createAllRoutes(ctx), next to ...createMemorySyncRoutes(ctx):
    ...createMemoryFilesRoutes(ctx),
```

- [ ] **Step 5: Run tests**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test && \
  node --test --test-reporter=spec dist-test/__tests__/memory-files-routes.test.js
```
Expected: all PASS. Then run the whole suite once (`npm run test`) — no regressions.

Also add to the test file (verifies the Step 3a fallback through the existing GET route — import `createMemoryRoutes` from `../routes/core/memory.routes` alongside the other imports):

```ts
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
```

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/api/memory-api.ts core/src/routes/core/memory-files.routes.ts core/src/routes/core/index.ts core/src/__tests__/memory-files-routes.test.ts && \
  git commit -m "feat(memory): file write/create/delete routes + file-read hash/MEMORY.md fallback"
```

---

### Task 3: Rules list/read/write routes

**Files:**
- Create: `core/src/routes/core/rule-files.routes.ts`
- Modify: `core/src/rules/rule-sync.ts` (export the two dir helpers: `function rulesRoot` → `export function rulesRoot`, `function mirrorRootDir` → `export function mirrorRootDir`)
- Modify: `core/src/routes/core/index.ts` (import + spread, next to `createRuleMapRoutes`)
- Test: `core/src/__tests__/rule-files-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 helper; `rulesRoot()`/`mirrorRootDir()` from `../../rules/rule-sync`; `parseOs` from `../../rules/rule-extract` (returns normalized platform ids, e.g. `win32|darwin|linux` — verify once in `rule-extract.ts` and adjust the `active` comparison if it returns pretty names).
- Produces (consumed by web Task 7):
  - `GET /rules/list` → `{rules: RuleListEntry[]}` where `RuleListEntry = {filename, source: 'live'|'mirror:<host>', size, mtimeMs, os: string[], active: boolean, syncedFrom: string|null, editable: boolean, title: string|null}`
  - `GET /rules/file/:filename?source=live|mirror:<host>` → `{filename, source, content, hash}`
  - `PUT /rules/file/:filename` body `{content, expectedHash?}` → `{filename, hash}`
  - `POST /rules/file` body `{filename, content}` → `{filename, hash}`
  - `DELETE /rules/file/:filename` (query/body `expectedHash?`) → `{filename, deleted: true}`
  - Same error-code convention as Task 2; rules-protected pattern: `/^synced\./` (+ mirror sources are read-only by construction — writes only ever touch `rulesRoot()`).

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/rule-files-routes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test
```
Expected: tsc FAILS with "Cannot find module '../routes/core/rule-files.routes'".

- [ ] **Step 3: Export the dir helpers and write the routes**

In `core/src/rules/rule-sync.ts` change the two private helpers to exports (no logic change):

```ts
export function rulesRoot(rulesDir?: string): string { return rulesDir || path.join(getClaudeConfigDir(), 'rules'); }
export function mirrorRootDir(mirrorRoot?: string): string { return mirrorRoot || path.join(getDataDir(), 'rules-mirror'); }
```

`core/src/routes/core/rule-files.routes.ts`:

```ts
/**
 * Rule file routes — list/read for ALL user rules (own + synced + inert
 * mirrors), write/create/delete for OWN rules only. `synced.<host>.*` and
 * mirror copies are sync artifacts: editing them locally would be clobbered
 * by the next pull, so they are rejected (edit at the origin node instead).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { rulesRoot, mirrorRootDir } from '../../rules/rule-sync';
import { parseOs } from '../../rules/rule-extract';
import { sha256, writeMdFile, deleteMdFile, filenameProblem } from '../../memory/file-write';

const RULES_PROTECTED = [/^synced\./];
const SYNCED_RE = /^synced\.([A-Za-z0-9_-]+)\./;

function titleOf(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function listDir(dir: string, source: string): Array<Record<string, unknown>> {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.')); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const filename of names) {
    try {
      const p = path.join(dir, filename);
      const st = fs.statSync(p);
      const content = fs.readFileSync(p, 'utf-8');
      const osList = parseOs(content);
      const isMirror = source.startsWith('mirror:');
      const syncedFrom = SYNCED_RE.exec(filename)?.[1] ?? null;
      out.push({
        filename, source, size: st.size, mtimeMs: st.mtimeMs,
        os: osList,
        active: !isMirror && (osList.length === 0 || osList.includes(os.platform())),
        syncedFrom: isMirror ? source.slice('mirror:'.length) : syncedFrom,
        editable: !isMirror && !syncedFrom,
        title: titleOf(content),
      });
    } catch { /* skip unreadable entry */ }
  }
  return out;
}

/** Resolve a read source to a directory. live → rulesRoot; mirror:<host> → rules-mirror/<host> (host confined). */
function sourceDir(source: string | undefined): string | null {
  if (!source || source === 'live') return rulesRoot();
  if (source.startsWith('mirror:')) {
    const host = source.slice('mirror:'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(host) || host.includes('..')) return null;
    return path.join(mirrorRootDir(), host);
  }
  return null;
}

function bodyOf(req: ParsedRequest): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
}

export function createRuleFilesRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /rules/list
    {
      method: 'GET',
      pattern: /^\/rules\/list$/,
      handler: async () => {
        const start = Date.now();
        const rules = listDir(rulesRoot(), 'live');
        try {
          for (const host of fs.readdirSync(mirrorRootDir())) {
            const hostDir = path.join(mirrorRootDir(), host);
            try { if (!fs.statSync(hostDir).isDirectory()) continue; } catch { continue; }
            rules.push(...listDir(hostDir, `mirror:${host}`));
          }
        } catch { /* no mirror root yet */ }
        return wrapResponse({ rules }, start);
      },
    },
    // GET /rules/file/:filename?source=live|mirror:<host>
    {
      method: 'GET',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        if (filenameProblem(filename)) return wrapError('BAD_FILENAME', `BAD_FILENAME: ${filename}`, start);
        const source = (req.query.source as string) || 'live';
        const dir = sourceDir(source);
        if (!dir) return wrapError('INVALID_INPUT', `INVALID_INPUT: bad source ${source}`, start);
        try {
          const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
          return wrapResponse({ filename, source, content, hash: sha256(content) }, start);
        } catch {
          return wrapError('NOT_FOUND', `NOT_FOUND: ${source}/${filename}`, start);
        }
      },
    },
    // PUT /rules/file/:filename  { content, expectedHash? }
    {
      method: 'PUT',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        const { content, expectedHash } = bodyOf(req) as { content?: string; expectedHash?: string };
        if (typeof content !== 'string') return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.content (string) required', start);
        const r = writeMdFile(rulesRoot(), filename, content, {
          expectedHash: typeof expectedHash === 'string' ? expectedHash : undefined,
          protectedPatterns: RULES_PROTECTED,
        });
        if (!r.ok) return wrapError(r.code!, `${r.code}: write refused for ${filename}`, start);
        return wrapResponse({ filename, hash: r.hash }, start);
      },
    },
    // POST /rules/file  { filename, content }
    {
      method: 'POST',
      pattern: /^\/rules\/file$/,
      handler: async (req) => {
        const start = Date.now();
        const { filename, content } = bodyOf(req) as { filename?: string; content?: string };
        if (typeof filename !== 'string' || typeof content !== 'string') {
          return wrapError('INVALID_INPUT', 'INVALID_INPUT: body.filename and body.content required', start);
        }
        const r = writeMdFile(rulesRoot(), filename, content, { mustNotExist: true, protectedPatterns: RULES_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: create refused for ${filename}`, start);
        return wrapResponse({ filename, hash: r.hash }, start);
      },
    },
    // DELETE /rules/file/:filename ?expectedHash=
    {
      method: 'DELETE',
      pattern: /^\/rules\/file\/(?<filename>.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const filename = decodeURIComponent(req.params.filename);
        const b = bodyOf(req) as { expectedHash?: string };
        const expectedHash = (req.query.expectedHash as string) || (typeof b.expectedHash === 'string' ? b.expectedHash : undefined);
        const r = deleteMdFile(rulesRoot(), filename, { expectedHash, protectedPatterns: RULES_PROTECTED });
        if (!r.ok) return wrapError(r.code!, `${r.code}: delete refused for ${filename}`, start);
        return wrapResponse({ filename, deleted: true }, start);
      },
    },
  ];
}
```

- [ ] **Step 4: Register in `core/src/routes/core/index.ts`**

```ts
import { createRuleFilesRoutes } from './rule-files.routes';
// …next to ...createRuleMapRoutes(ctx):
    ...createRuleFilesRoutes(ctx),
```

**Ordering note:** register `createRuleFilesRoutes` BEFORE `createRuleMapRoutes` OR verify patterns don't collide — `/rules/rule/:id` (map) vs `/rules/file/:filename` (files) are distinct literals, so order does not matter; the test in Step 5 plus one `curl :3200/rules/list` after `./core.sh restart` confirms.

- [ ] **Step 5: Run tests**

```bash
cd /home/ubuntu/lm-assist/core && npm run build:test && \
  node --test --test-reporter=spec dist-test/__tests__/rule-files-routes.test.js && npm run test
```
Expected: new file PASSES; full suite green (rule-sync exports are additive).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/routes/core/rule-files.routes.ts core/src/rules/rule-sync.ts core/src/routes/core/index.ts core/src/__tests__/rule-files-routes.test.ts && \
  git commit -m "feat(rules): list/read/write file routes (own rules editable, synced/mirrors read-only)"
```

---

### Task 4: Web scaffold — page, tabs, node selector, sidebar

**Files:**
- Create: `web/src/app/(dashboard)/memory/page.tsx`
- Create: `web/src/components/memory/types.ts`
- Create: `web/src/components/memory/MemoryPage.tsx`
- Create: `web/src/components/memory/NodeSelector.tsx`
- Modify: `web/src/components/layout/Sidebar.tsx` (nav item)

**Interfaces:**
- Consumes: `useAppMode()` (`apiClient.fetchPath<T>(path, {method, body, machineId})` — unwraps `{data}` and throws Error with the server's `error.message` on failure), `useMachines()` (`{machines: Machine[]}`, `Machine = {id, hostname, status: 'online'|'offline', isLocal?, …}` from `web/src/lib/types`).
- Produces (used by Tasks 5–8): `CallFn` prop passed to each tab:

```ts
export type CallFn = <T = unknown>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
```

- [ ] **Step 1: Create shared types**

`web/src/components/memory/types.ts`:

```ts
export type CallFn = <T = unknown>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** GET /memory/projects item */
export interface MemoryProjectSummary {
  projectId: string; projectPath: string;
  hasLive: boolean; hasRepo: boolean;
  hostCount: number; fileCount: number; maxMtimeMs: number;
}

/** GET /memory/map (level=brief) item; complete adds source/complete/contentHash */
export interface MapRecord {
  recordId: string; node: string; project: string; file: string;
  title: string; brief: string; type: string; category: string; validity: string;
  referencedProjects: string[]; recordedAtMs: number;
  source?: string; complete?: string; contentHash?: string;
}

/** GET /rules/list item */
export interface RuleListEntry {
  filename: string; source: string; size: number; mtimeMs: number;
  os: string[]; active: boolean; syncedFrom: string | null;
  editable: boolean; title: string | null;
}

/** GET /memory/by-project/:id/sync/import-candidates item */
export interface ImportCandidate {
  source: string; filename: string; body: string; bodyPreview?: string;
  mtimeMs: number; sizeBytes: number; shareability?: string; reason?: string;
  localMtimeMs?: number; localSizeBytes?: number; relevanceScore?: number;
}

/** Editor target passed between browse and edit states */
export interface EditTarget {
  kind: 'memory' | 'rule';
  projectId?: string;          // memory only
  filename: string;            // '' → create flow
  content: string;
  hash?: string;               // expectedHash for saves; undefined → create
}
```

- [ ] **Step 2: NodeSelector**

`web/src/components/memory/NodeSelector.tsx`:

```tsx
'use client';

import { useMachines } from '@/hooks/useMachines';
import { useAppMode } from '@/contexts/AppModeContext';

/** Pick which node's live memory/rules the page operates on. null = this node
 *  (or the proxied machine in cloud mode). Hidden when there is nothing to pick. */
export function NodeSelector({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { machines } = useMachines();
  const { proxy } = useAppMode();
  // Relay machine identifier is `gatewayId || id` — the same expression
  // MachineDropdown.tsx uses (`remoteGatewayId = m.gatewayId || m.id`).
  const relayId = (m: { id: string; gatewayId?: string }) => m.gatewayId || m.id;
  const others = machines.filter(m =>
    m.status === 'online' && !m.isLocal && relayId(m) !== proxy.machineId);
  if (others.length === 0) return null;
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
      title="Which node's live memory/rules to browse and edit"
    >
      <option value="">This node</option>
      {others.map(m => <option key={m.id} value={relayId(m)}>{m.hostname}</option>)}
    </select>
  );
}
```

- [ ] **Step 3: MemoryPage + route wrapper + sidebar**

`web/src/components/memory/MemoryPage.tsx`:

```tsx
'use client';

import { useCallback, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { NodeSelector } from './NodeSelector';
import { MemoryBrowser } from './MemoryBrowser';
import { RulesBrowser } from './RulesBrowser';
import { SyncTab } from './SyncTab';
import type { CallFn } from './types';

const TABS = ['memory', 'rules', 'sync'] as const;
type Tab = typeof TABS[number];

export function MemoryPage() {
  const { apiClient, proxy } = useAppMode();
  const [tab, setTab] = useState<Tab>('memory');
  const [nodeId, setNodeId] = useState<string | null>(null);

  const call: CallFn = useCallback(
    (path, opts) => apiClient.fetchPath(path, {
      method: opts?.method, body: opts?.body,
      machineId: nodeId ?? proxy.machineId ?? undefined,
    }),
    [apiClient, nodeId, proxy.machineId],
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Memory</h1>
          <p className="text-sm text-gray-400">Project memory and user rules across your nodes.</p>
        </div>
        <NodeSelector value={nodeId} onChange={setNodeId} />
      </div>
      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-t capitalize ${tab === t ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {t}
          </button>
        ))}
      </div>
      {/* key= remounts tabs on node switch so stale node data can't linger */}
      <div key={nodeId ?? 'local'}>
        {tab === 'memory' && <MemoryBrowser call={call} />}
        {tab === 'rules' && <RulesBrowser call={call} />}
        {tab === 'sync' && <SyncTab call={call} />}
      </div>
    </div>
  );
}
```

`web/src/app/(dashboard)/memory/page.tsx`:

```tsx
'use client';

import { MemoryPage } from '@/components/memory/MemoryPage';

export default function MemoryRoute() {
  return <MemoryPage />;
}
```

`web/src/components/layout/Sidebar.tsx` — add `Brain` to the existing `lucide-react` import list and insert after the Knowledge item in `baseNavItems`:

```ts
  { href: '/memory', icon: Brain, label: 'Memory' },
```

For this task only, so the build passes before Tasks 5–8 land, create the three tab components as placeholders that render nothing but their fetch scaffolding — they are replaced by their real implementations in Tasks 5, 7 and 8. Each placeholder is the full file listed at the top of its own task with the body `return <div className="text-sm text-gray-400">Loading…</div>;` — OR simply implement Tasks 4–8 on one branch and build at the end of Task 5. Preferred: placeholders, so each task builds green:

All three placeholders share the REAL prop signature (`onEdit` included) so the Task 6 MemoryPage change type-checks before Tasks 7/8 replace them:

```tsx
// web/src/components/memory/MemoryBrowser.tsx  (placeholder — replaced in Task 5)
'use client';
import type { CallFn, EditTarget } from './types';
export function MemoryBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Memory browser coming in Task 5.</div>;
}
```

```tsx
// web/src/components/memory/RulesBrowser.tsx  (placeholder — replaced in Task 7)
'use client';
import type { CallFn, EditTarget } from './types';
export function RulesBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Rules browser coming in Task 7.</div>;
}
```

```tsx
// web/src/components/memory/SyncTab.tsx  (placeholder — replaced in Task 8)
'use client';
import type { CallFn, EditTarget } from './types';
export function SyncTab({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Sync status coming in Task 8.</div>;
}
```

- [ ] **Step 4: Build to verify**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist/web && npx next build
```
Expected: build succeeds; route `/memory` listed in the output.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add web/src/app/\(dashboard\)/memory web/src/components/memory web/src/components/layout/Sidebar.tsx && \
  git commit -m "feat(web): Memory page scaffold — tabs, node selector, sidebar entry"
```

---

### Task 5: Memory tab — browse, search, record detail

**Files:**
- Replace: `web/src/components/memory/MemoryBrowser.tsx`
- Create: `web/src/components/memory/RecordDetail.tsx`

**Interfaces:**
- Consumes: `CallFn`, `MemoryProjectSummary`, `MapRecord`, `ImportCandidate` (Task 4); backend `GET /memory/projects`, `GET /memory/map`, `GET /memory/record/:id`, `GET /memory/by-project/:id/sources` (→ `{sources: [{source, dirPath, fileCount, maxMtimeMs}], hosts}`), `GET /memory/by-project/:id/file/:name?source=` (→ `{…, body, hash}` after Task 2's patch — bind **`body`** and **`hash`**, live-verified shape), `GET /memory/by-project/:id/sync/import-candidates` (→ `{candidates: ImportCandidate[]}`, live-verified).
- Produces: `MemoryBrowser({call})`; `RecordDetail({record, call, onEdit, onClose})` where `onEdit(target: EditTarget)` is wired to the editor in Task 6 (this task stubs it with `console.log` + a disabled-tooltip fallback is NOT needed — pass a no-op and enable in Task 6).

- [ ] **Step 1: Implement MemoryBrowser**

`web/src/components/memory/MemoryBrowser.tsx` (replaces placeholder):

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CallFn, MemoryProjectSummary, MapRecord, ImportCandidate, EditTarget } from './types';
import { RecordDetail } from './RecordDetail';

const TYPE_COLORS: Record<string, string> = {
  user: 'bg-sky-900 text-sky-200', feedback: 'bg-amber-900 text-amber-200',
  project: 'bg-emerald-900 text-emerald-200', reference: 'bg-violet-900 text-violet-200',
  claude: 'bg-gray-700 text-gray-200', index: 'bg-gray-700 text-gray-300',
};
const VALIDITY_COLORS: Record<string, string> = {
  current: 'bg-emerald-900 text-emerald-200', stale: 'bg-amber-900 text-amber-200',
  outdated: 'bg-rose-900 text-rose-200', superseded: 'bg-gray-700 text-gray-400',
};

export function Badge({ text, palette }: { text: string; palette: Record<string, string> }) {
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${palette[text] || 'bg-gray-700 text-gray-300'}`}>{text}</span>;
}

export function MemoryBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  const [projects, setProjects] = useState<MemoryProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<MapRecord[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<MapRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<MemoryProjectSummary[]>('/memory/projects')
      .then(setProjects).catch((e) => setError(String(e)));
  }, [call]);

  const loadRecords = useCallback(() => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ level: 'brief', limit: '200' });
    if (projectId) params.set('projects', projectId);
    if (q.trim()) params.set('q', q.trim());
    call<MapRecord[]>(`/memory/map?${params}`)
      .then((r) => setRecords(Array.isArray(r) ? r : []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [call, projectId, q]);

  useEffect(() => { const t = setTimeout(loadRecords, 300); return () => clearTimeout(t); }, [loadRecords]);

  useEffect(() => {
    if (!projectId) { setCandidates([]); return; }
    call<{ candidates: ImportCandidate[] }>(`/memory/by-project/${encodeURIComponent(projectId)}/sync/import-candidates`)
      .then((r) => setCandidates(r.candidates || [])).catch(() => setCandidates([]));
  }, [call, projectId]);

  const importToLive = async (c: ImportCandidate) => {
    try {
      await call(`/memory/by-project/${encodeURIComponent(projectId!)}/file/${encodeURIComponent(c.filename)}`,
        { method: 'PUT', body: { content: c.body } });
      loadRecords();
      setCandidates((cs) => cs.filter((x) => x !== c));
    } catch (e) { setError(String(e)); }
  };

  return (
    <div className="flex gap-4 text-sm">
      {/* Project rail */}
      <div className="w-56 shrink-0 space-y-1">
        <button onClick={() => setProjectId(null)}
          className={`w-full text-left px-2 py-1 rounded ${projectId === null ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
          All projects
        </button>
        {projects.map((p) => (
          <button key={p.projectId} onClick={() => setProjectId(p.projectId)}
            title={p.projectPath}
            className={`w-full text-left px-2 py-1 rounded truncate ${projectId === p.projectId ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {p.projectPath.split('/').pop() || p.projectId}
            <span className="text-gray-500 ml-1 text-xs">{p.fileCount}</span>
          </button>
        ))}
      </div>

      {/* Records */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={projectId ? 'Search this project…' : 'Search all projects…'}
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200" />
          {onEdit && projectId && (
            <button onClick={() => onEdit({ kind: 'memory', projectId, filename: '', content: '' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
              + New memory
            </button>
          )}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {loading && <div className="text-gray-500 text-xs">Loading…</div>}
        <div className="divide-y divide-gray-800 border border-gray-800 rounded">
          {records.map((r) => (
            <button key={r.recordId} onClick={() => setSelected(r)}
              className="w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2">
              <span className="text-gray-200 truncate flex-1">{r.title || r.file}</span>
              <Badge text={r.type} palette={TYPE_COLORS} />
              <Badge text={r.validity} palette={VALIDITY_COLORS} />
              <span className="text-gray-500 text-xs">{r.node}</span>
              {!projectId && <span className="text-gray-600 text-xs truncate max-w-40">{r.project}</span>}
            </button>
          ))}
          {!loading && records.length === 0 && <div className="px-3 py-4 text-gray-500">No records.</div>}
        </div>

        {/* Import candidates (per-project) */}
        {projectId && candidates.length > 0 && (
          <div className="border border-gray-800 rounded p-3 space-y-2">
            <div className="text-gray-300 font-medium">Import candidates (newer on other hosts)</div>
            {candidates.map((c, i) => (
              <div key={`${c.source}:${c.filename}:${i}`} className="flex items-center gap-2">
                <span className="text-gray-200 truncate flex-1">{c.filename}</span>
                <span className="text-gray-500 text-xs">{c.source}{c.reason ? ` · ${c.reason}` : ''}</span>
                <button onClick={() => void importToLive(c)}
                  className="px-2 py-0.5 rounded bg-sky-900 text-sky-100 hover:bg-sky-800 text-xs">Import to live</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <RecordDetail record={selected} call={call} onEdit={onEdit} onClose={() => { setSelected(null); loadRecords(); }} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement RecordDetail**

`web/src/components/memory/RecordDetail.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import type { CallFn, MapRecord, EditTarget } from './types';

const PROTECTED_MEMORY = new Set(['_cross-project.md', '_hosts.md']);

interface SourceInfo { source: string; dirPath: string; fileCount: number; maxMtimeMs: number }

export function RecordDetail({ record, call, onEdit, onClose }:
  { record: MapRecord; call: CallFn; onEdit?: (t: EditTarget) => void; onClose: () => void }) {
  const [full, setFull] = useState<MapRecord | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('live');
  const [file, setFile] = useState<{ body: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // CLAUDE.md-section records use pseudo-projects like '(user-global)' — no
  // by-project file access for those; record render only.
  const hasFileAccess = !record.project.startsWith('(');
  const pid = encodeURIComponent(record.project);
  const fname = encodeURIComponent(record.file);

  useEffect(() => {
    call<MapRecord>(`/memory/record/${encodeURIComponent(record.recordId)}`)
      .then(setFull).catch((e) => setError(String(e)));
    if (!hasFileAccess) return;
    call<{ sources: SourceInfo[] }>(`/memory/by-project/${pid}/sources`)
      .then((r) => setSources(r.sources || [])).catch(() => setSources([]));
  }, [call, record.recordId, pid, hasFileAccess]);

  useEffect(() => {
    setFile(null);
    if (!hasFileAccess) return;
    call<{ body: string; hash?: string }>(`/memory/by-project/${pid}/file/${fname}?source=${encodeURIComponent(source)}`)
      .then(setFile).catch((e) => setError(String(e)));
  }, [call, pid, fname, source, hasFileAccess]);

  const editable = hasFileAccess && source === 'live' && !PROTECTED_MEMORY.has(record.file);

  return (
    <div className="w-[36rem] shrink-0 border border-gray-800 rounded p-3 space-y-3 bg-gray-950 max-h-[80vh] overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-gray-100 font-medium">{record.title || record.file}</div>
          <div className="text-gray-500 text-xs">{record.project} · {record.file} · {record.node}</div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={16} /></button>
      </div>
      {error && <div className="text-rose-400 text-xs">{error}</div>}

      {full?.complete && (
        <div className="prose prose-invert prose-sm max-w-none border-b border-gray-800 pb-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{full.complete}</ReactMarkdown>
        </div>
      )}

      {hasFileAccess && (
        <div className="flex items-center gap-2">
          <span className="text-gray-400 text-xs">Raw file:</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200">
            {(sources.length ? sources.map((s) => s.source) : ['live']).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {onEdit && editable && file && (
            <button
              onClick={() => onEdit({ kind: 'memory', projectId: record.project, filename: record.file, content: file.body, hash: file.hash })}
              className="ml-auto px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
              Edit
            </button>
          )}
          {!editable && <span className="ml-auto text-gray-500 text-[10px]">read-only ({source === 'live' ? 'managed file' : 'mirror'})</span>}
        </div>
      )}
      {file && (
        <pre className="text-xs text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">{file.body}</pre>
      )}
    </div>
  );
}
```

`GET /memory/record/:id` returns the complete record object; the full markdown is in `complete`. The raw-file panel binds `body` + `hash` (Task 2's patched response).

- [ ] **Step 3: Build**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist/web && npx next build
```
Expected: success. (`onEdit` is optional and unwired until Task 6 — MemoryPage still passes only `call`.)

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/lm-assist && git add web/src/components/memory && \
  git commit -m "feat(web): memory browse/search + record detail with mirror sources and import-to-live"
```

---

### Task 6: FileEditor + create/edit/delete wiring

**Files:**
- Create: `web/src/components/memory/FileEditor.tsx`
- Modify: `web/src/components/memory/MemoryPage.tsx` (own the editor state, pass `onEdit` down)
- Modify: `web/src/components/memory/MemoryBrowser.tsx` (already accepts `onEdit`; add delete button in RecordDetail — see step 2)
- Modify: `web/src/components/memory/RecordDetail.tsx` (Delete button next to Edit)

**Interfaces:**
- Consumes: `EditTarget` (Task 4), `MarkdownSplitEditor` from `@/components/missions/MarkdownSplitEditor` (`{value, onChange, mono}`), backend routes from Tasks 2–3.
- Produces: `FileEditor({target, call, onDone})` — modal-style panel; `onDone(saved: boolean)` closes it. Save PUTs (existing) or POSTs (create, `filename` from input, optional `indexLine`); on error message containing `HASH_MISMATCH` shows Reload / Overwrite choices; rules targets use `/rules/file` routes.

- [ ] **Step 1: Implement FileEditor**

`web/src/components/memory/FileEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { MarkdownSplitEditor } from '@/components/missions/MarkdownSplitEditor';
import type { CallFn, EditTarget } from './types';

const MEMORY_TEMPLATE = `---
name: short-kebab-slug
description: one-line summary used for recall
type: project
---

The fact. Keep it one topic per file.
`;

function pathsFor(t: EditTarget, filename: string) {
  if (t.kind === 'rule') {
    return {
      put: `/rules/file/${encodeURIComponent(filename)}`,
      post: `/rules/file`,
      del: `/rules/file/${encodeURIComponent(filename)}`,
    };
  }
  const pid = encodeURIComponent(t.projectId!);
  return {
    put: `/memory/by-project/${pid}/file/${encodeURIComponent(filename)}`,
    post: `/memory/by-project/${pid}/file`,
    del: `/memory/by-project/${pid}/file/${encodeURIComponent(filename)}`,
  };
}

export function FileEditor({ target, call, onDone }:
  { target: EditTarget; call: CallFn; onDone: (saved: boolean) => void }) {
  const [created, setCreated] = useState(false);
  const isCreate = !target.filename && !created; // a warned create flips to edit mode
  const [filename, setFilename] = useState(target.filename);
  const initialContent = !target.filename && !target.content ? MEMORY_TEMPLATE : target.content;
  const [content, setContent] = useState(initialContent);
  const [baseline, setBaseline] = useState(initialContent); // last saved (or loaded) content, for the dirty check
  const [indexLine, setIndexLine] = useState('');
  const [hash, setHash] = useState<string | undefined>(target.hash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const save = async (overwrite = false) => {
    setBusy(true); setError(null); setConflict(false);
    const p = pathsFor(target, filename);
    try {
      let w: string[] = [];
      if (isCreate) {
        const body: Record<string, unknown> = { filename, content };
        if (target.kind === 'memory' && indexLine.trim()) body.indexLine = indexLine.trim();
        const r = await call<{ hash?: string; warnings?: string[] }>(p.post, { method: 'POST', body });
        setCreated(true); setHash(r.hash); w = r.warnings || [];
      } else {
        const body: Record<string, unknown> = { content };
        if (hash && !overwrite) body.expectedHash = hash;
        const r = await call<{ hash?: string; warnings?: string[] }>(p.put, { method: 'PUT', body });
        setHash(r.hash); w = r.warnings || [];
      }
      if (w.length === 0) { onDone(true); return; }
      // Saved, but with frontmatter warnings — stay open so they're visible.
      setWarnings(w); setBaseline(content);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('HASH_MISMATCH')) setConflict(true);
      else setError(msg);
    } finally { setBusy(false); }
  };

  const reload = async () => {
    setBusy(true); setError(null); setConflict(false);
    try {
      // Field asymmetry: rules GET returns `content`, memory GET returns `body`.
      if (target.kind === 'rule') {
        const r = await call<{ content: string; hash?: string }>(`/rules/file/${encodeURIComponent(filename)}`);
        setContent(r.content); setBaseline(r.content); setHash(r.hash);
      } else {
        const r = await call<{ body: string; hash?: string }>(
          `/memory/by-project/${encodeURIComponent(target.projectId!)}/file/${encodeURIComponent(filename)}`);
        setContent(r.body); setBaseline(r.body); setHash(r.hash);
      }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const cancel = () => {
    if (content !== baseline && !window.confirm('Discard unsaved changes?')) return;
    onDone(created); // a warned-but-saved create still refreshes the list on close
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="bg-gray-950 border border-gray-700 rounded-lg w-full max-w-4xl h-[80vh] flex flex-col p-4 gap-3">
        <div className="flex items-center gap-2">
          <span className="text-gray-100 font-medium">{isCreate ? 'New' : 'Edit'} {target.kind === 'rule' ? 'rule' : 'memory'}</span>
          {isCreate ? (
            <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="filename.md"
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 flex-1" />
          ) : (
            <span className="text-gray-400 text-sm">{filename}{target.projectId ? ` · ${target.projectId}` : ''}</span>
          )}
        </div>
        {isCreate && target.kind === 'memory' && (
          <input value={indexLine} onChange={(e) => setIndexLine(e.target.value)}
            placeholder="MEMORY.md index line (optional): - [Title](filename.md) — hook"
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" />
        )}
        <MarkdownSplitEditor value={content} onChange={setContent} mono />
        {warnings.length > 0 && <div className="text-amber-400 text-xs">{warnings.join(' · ')}</div>}
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {conflict && (
          <div className="text-amber-300 text-xs flex items-center gap-2">
            File changed on disk since you loaded it.
            <button onClick={() => void reload()} className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700">Reload (discard my edit)</button>
            <button onClick={() => void save(true)} className="px-2 py-0.5 rounded bg-rose-900 hover:bg-rose-800">Overwrite anyway</button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={cancel} disabled={busy}
            className="px-3 py-1 rounded text-sm text-gray-300 hover:text-gray-100">Cancel</button>
          <button onClick={() => void save()} disabled={busy || !filename.endsWith('.md') || !content.trim()}
            className="px-3 py-1 rounded text-sm bg-emerald-800 text-emerald-100 hover:bg-emerald-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire editor state into MemoryPage; add Delete to RecordDetail**

In `MemoryPage.tsx`: add editor state and pass `onEdit` to both browsers:

```tsx
// additional imports
import { FileEditor } from './FileEditor';
import type { CallFn, EditTarget } from './types';
// inside MemoryPage():
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
// tab body becomes:
      <div key={`${nodeId ?? 'local'}:${refreshKey}`}>
        {tab === 'memory' && <MemoryBrowser call={call} onEdit={setEditTarget} />}
        {tab === 'rules' && <RulesBrowser call={call} onEdit={setEditTarget} />}
        {tab === 'sync' && <SyncTab call={call} onEdit={setEditTarget} />}
      </div>
      {editTarget && (
        <FileEditor target={editTarget} call={call}
          onDone={(saved) => { setEditTarget(null); if (saved) setRefreshKey((k) => k + 1); }} />
      )}
```

In `RecordDetail.tsx`, next to the Edit button add Delete (live + non-protected only):

```tsx
        {editable && file && (
          <button
            onClick={async () => {
              if (!window.confirm(`Delete ${record.file}? Its MEMORY.md index line is removed too.`)) return;
              try {
                await call(`/memory/by-project/${pid}/file/${fname}?removeIndexLine=true&expectedHash=${file.hash || ''}`, { method: 'DELETE' });
                onClose();
              } catch (e) { setError(String(e)); }
            }}
            className="px-2 py-0.5 rounded bg-rose-900 text-rose-100 hover:bg-rose-800 text-xs">
            Delete
          </button>
        )}
```

- [ ] **Step 3: Build**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist/web && npx next build
```
Expected: success.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/lm-assist && git add web/src/components/memory && \
  git commit -m "feat(web): hash-guarded file editor with create/index-line, delete, conflict reload/overwrite"
```

---

### Task 7: Rules tab

**Files:**
- Replace: `web/src/components/memory/RulesBrowser.tsx`

**Interfaces:**
- Consumes: `CallFn`, `RuleListEntry`, `EditTarget`; backend `GET /rules/list`, `GET /rules/file/:filename?source=`, write routes (Task 3). Editor comes via `onEdit` (Task 6).
- Produces: `RulesBrowser({call, onEdit})`.

- [ ] **Step 1: Implement**

`web/src/components/memory/RulesBrowser.tsx` (replaces placeholder):

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CallFn, RuleListEntry, EditTarget } from './types';

export function RulesBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  const [rules, setRules] = useState<RuleListEntry[]>([]);
  const [selected, setSelected] = useState<RuleListEntry | null>(null);
  const [content, setContent] = useState<{ content: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ rules: RuleListEntry[] }>('/rules/list')
      .then((r) => setRules(r.rules || [])).catch((e) => setError(String(e)));
  }, [call]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!selected) { setContent(null); return; }
    call<{ content: string; hash?: string }>(
      `/rules/file/${encodeURIComponent(selected.filename)}?source=${encodeURIComponent(selected.source)}`)
      .then(setContent).catch((e) => setError(String(e)));
  }, [call, selected]);

  const remove = async (r: RuleListEntry) => {
    if (!window.confirm(`Delete rule ${r.filename}?`)) return;
    try {
      await call(`/rules/file/${encodeURIComponent(r.filename)}?expectedHash=${content?.hash || ''}`, { method: 'DELETE' });
      setSelected(null); load();
    } catch (e) { setError(String(e)); }
  };

  return (
    <div className="flex gap-4 text-sm">
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex justify-between items-center">
          <div className="text-gray-400 text-xs">
            User rules (<code>~/.claude/rules</code>) — own rules are editable; <code>synced.*</code> and mirrors converge from their origin node.
          </div>
          {onEdit && (
            <button onClick={() => onEdit({ kind: 'rule', filename: '', content: '# New rule\n\n' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">+ New rule</button>
          )}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        <div className="divide-y divide-gray-800 border border-gray-800 rounded">
          {rules.map((r) => (
            <button key={`${r.source}:${r.filename}`} onClick={() => setSelected(r)}
              className={`w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2 ${selected === r ? 'bg-gray-900' : ''}`}>
              <span className="text-gray-200 truncate flex-1">{r.title || r.filename}</span>
              {r.os.length > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-300">{r.os.join(',')}</span>}
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.active ? 'bg-emerald-900 text-emerald-200' : 'bg-gray-700 text-gray-400'}`}>
                {r.active ? 'active' : 'inert'}
              </span>
              {r.syncedFrom && <span className="text-gray-500 text-xs">from {r.syncedFrom}</span>}
              {r.source.startsWith('mirror:') && <span className="text-gray-600 text-[10px]">mirror</span>}
            </button>
          ))}
          {rules.length === 0 && <div className="px-3 py-4 text-gray-500">No rules found.</div>}
        </div>
      </div>

      {selected && content && (
        <div className="w-[32rem] shrink-0 border border-gray-800 rounded p-3 space-y-2 bg-gray-950 max-h-[75vh] overflow-y-auto">
          <div className="flex items-center gap-2">
            <span className="text-gray-100 font-medium truncate flex-1">{selected.filename}</span>
            {onEdit && selected.editable && (
              <button onClick={() => onEdit({ kind: 'rule', filename: selected.filename, content: content.content, hash: content.hash })}
                className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">Edit</button>
            )}
            {selected.editable && (
              <button onClick={() => void remove(selected)}
                className="px-2 py-0.5 rounded bg-rose-900 text-rose-100 hover:bg-rose-800 text-xs">Delete</button>
            )}
            {!selected.editable && <span className="text-gray-500 text-[10px]">read-only — edit at origin ({selected.syncedFrom || 'mirror'})</span>}
          </div>
          <pre className="text-xs text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">{content.content}</pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist/web && npx next build && \
  cd /home/ubuntu/lm-assist && git add web/src/components/memory/RulesBrowser.tsx && \
  git commit -m "feat(web): rules tab — os/active/origin columns, own-rule edit/delete"
```

---

### Task 8: Sync tab

**Files:**
- Replace: `web/src/components/memory/SyncTab.tsx`

**Interfaces:**
- Consumes: `CallFn`, `EditTarget`; backend (all GET, all existing): `/memory/sync/status`, `/memory/autosync/status`, `/memory/harvest/status`, `/rules/sync/status`, `/rules/autosync/status`, `/memory/proposals?limit=50`, `/memory/reconcile/plan?limit=50`, `/memory/validate/plan?limit=50`. Proposal rows carry `_proposalStatus`, `suggestedProject`/`_originProjectSlug` plus free-form record fields — render known keys, raw-JSON expander for the rest; "Open as new memory file" prefers a string field named `content`, else `body`, else pretty-printed JSON as the editor's starting content.
- Produces: `SyncTab({call, onEdit})`.

- [ ] **Step 1: Implement**

`web/src/components/memory/SyncTab.tsx` (replaces placeholder):

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { CallFn, EditTarget } from './types';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-800 rounded p-3 space-y-2">
      <div className="text-gray-300 font-medium">{title}</div>
      {children}
    </div>
  );
}

function StatusBlock({ call, path }: { call: CallFn; path: string }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call(path).then(setData).catch((e) => setError(String(e))); }, [call, path]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (!data) return <div className="text-gray-500 text-xs">Loading…</div>;
  return <pre className="text-xs text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto">{JSON.stringify(data, null, 2)}</pre>;
}

type Row = Record<string, unknown>;

function QueueList({ call, path, listKey, onEdit }:
  { call: CallFn; path: string; listKey: string; onEdit?: (t: EditTarget) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Record<string, unknown>>(path)
      .then((r) => setRows((r[listKey] as Row[]) || (r.items as Row[]) || []))
      .catch((e) => setError(String(e)));
  }, [call, path, listKey]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (rows.length === 0) return <div className="text-gray-500 text-xs">Empty.</div>;
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div key={i} className="text-xs">
          <button onClick={() => setOpen(open === i ? null : i)} className="text-left w-full flex items-center gap-2 hover:bg-gray-900 rounded px-1 py-0.5">
            <span className="text-gray-300 truncate flex-1">
              {String(row.title ?? row.name ?? row.id ?? row.recordId ?? `item ${i + 1}`)}
            </span>
            <span className="text-gray-500">{String(row._proposalStatus ?? row.status ?? '')}</span>
            <span className="text-gray-600">{String(row.suggestedProject ?? row._originProjectSlug ?? row.project ?? '')}</span>
          </button>
          {open === i && (
            <div className="pl-2 space-y-1">
              {/* FileEditor create for memory requires a projectId — only offer when the proposal names one */}
              {onEdit && Boolean(row.suggestedProject || row._originProjectSlug) && (
                <button
                  onClick={() => {
                    const content = typeof row.content === 'string' ? row.content
                      : typeof row.body === 'string' ? row.body
                      : JSON.stringify(row, null, 2);
                    const projectId = String(row.suggestedProject ?? row._originProjectSlug);
                    onEdit({ kind: 'memory', projectId, filename: '', content });
                  }}
                  className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-[10px]">
                  Open as new memory file
                </button>
              )}
              <pre className="text-[10px] text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto">{JSON.stringify(row, null, 2)}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SyncTab({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  return (
    <div className="space-y-4">
    <div className="text-xs text-gray-500">
      Sync/signpost toggles live in <a href="settings" className="underline hover:text-gray-300">Settings → Memory</a>; this tab is status only.
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
      <Section title="Memory sync"><StatusBlock call={call} path="/memory/sync/status" /></Section>
      <Section title="Rules sync"><StatusBlock call={call} path="/rules/sync/status" /></Section>
      <Section title="Memory autosync daemon"><StatusBlock call={call} path="/memory/autosync/status" /></Section>
      <Section title="Rules autosync daemon"><StatusBlock call={call} path="/rules/autosync/status" /></Section>
      <Section title="Harvest daemon"><StatusBlock call={call} path="/memory/harvest/status" /></Section>
      <Section title="Proposals (propose-only — applying is a human/agent step)">
        <QueueList call={call} path="/memory/proposals?limit=50" listKey="proposals" onEdit={onEdit} />
      </Section>
      <Section title="Reconcile plan"><QueueList call={call} path="/memory/reconcile/plan?limit=50" listKey="items" /></Section>
      <Section title="Validate plan"><QueueList call={call} path="/memory/validate/plan?limit=50" listKey="items" /></Section>
    </div>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist/web && npx next build && \
  cd /home/ubuntu/lm-assist && git add web/src/components/memory/SyncTab.tsx && \
  git commit -m "feat(web): sync tab — memory+rules sync/daemon status and curation queues"
```

---

### Task 9: End-to-end verification on dev (+ staging cross-node)

**Files:** none created (verification only; fix-forward anything found, small fixes commit as `fix(web|memory|rules): …`).

**Interfaces:**
- Consumes: everything above, running on dev core :3200 + dev web :3948.

- [ ] **Step 1: Restart dev services with the new build**

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && cd /home/ubuntu/lm-assist && ./core.sh build && ./core.sh restart
curl -s localhost:3200/health   # → "runningFrom":"dev-repo"
curl -s -o /dev/null -w '%{http_code}\n' localhost:3948   # → 307 means up
```

- [ ] **Step 2: API smoke checks (token-authed curl)**

```bash
TOKEN=$(cat ~/.lm-assist/api-token)
curl -s -H "x-api-key: $TOKEN" localhost:3200/rules/list | head -c 400                     # rules incl synced/mirror
curl -s -H "x-api-key: $TOKEN" -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"---\nname: web-e2e\ndescription: probe\ntype: project\n---\ntest"}' \
  "localhost:3200/memory/by-project/-home-ubuntu-lm-assist/file/web-e2e-probe.md"          # → success:true + hash
curl -s -H "x-api-key: $TOKEN" -X DELETE \
  "localhost:3200/memory/by-project/-home-ubuntu-lm-assist/file/web-e2e-probe.md?removeIndexLine=true"  # → deleted:true
```
Expected: shapes as designed; the probe file is created then removed.

- [ ] **Step 3: Browser verification (Chrome MCP)**

Per the dev-web-browser-testing recipe: get LAN IP (`hostname -I | awk '{print $1}'`), inject `localStorage.setItem('assist_access_key', '<64-char lanAccessToken from ~/.lm-assist/assist-config.json>')` on the `http://<IP>:3948` origin, then walk:

1. Sidebar shows **Memory**; page loads, three tabs render.
2. Memory tab: project rail lists projects; select `lm-assist` → records appear; search narrows; "All projects" search returns cross-project hits.
3. Open a record → detail shows rendered `complete` + raw file; source selector lists `live` (+ `repo:<host>` where mirrors exist, read-only).
4. Edit a live file → change one word → Save → record list refreshes with the change. Then simulate conflict: `echo x >> <that file>` in a shell, edit again in the still-open editor, Save → conflict bar appears → Reload works.
5. + New memory with an index line → file created, MEMORY.md gains the line. Delete it → file + index line gone (confirm dialog shown).
6. Managed-file guard: `_cross-project.md` shows read-only (no Edit button); PUT via curl returns `PROTECTED`.
7. Rules tab: own rules editable; `synced.*` rows show "from <host>" + read-only; a wrong-OS mirror rule shows `inert`.
8. Sync tab: all status sections populate; queues render (or "Empty.").
9. GIF-record the walkthrough (`memory_page_walkthrough.gif`) for the user.

- [ ] **Step 4: Cross-node check (staging cluster only)**

With staging nodes (123/107) online on the dev hub: pick one in the node selector → project rail reloads with THAT node's projects; open + edit a scratch memory file there (create `web-e2e-remote.md`, then delete it). Confirm prod 117 is never targeted.

- [ ] **Step 5: Full test suite + final commit**

```bash
cd /home/ubuntu/lm-assist/core && npm run test
cd /home/ubuntu/lm-assist && git add -A && git commit -m "feat(web): memory+rules web UI verified end-to-end on dev" --allow-empty
```
Expected: suite green; final marker commit (or fold any last fixes into it).

---

## Deferred (explicitly out of scope, from spec)

- Proposal apply-writeback to JSONL; live-vs-mirror diff view (`/memory/by-project/:id/diff` exists, natural follow-up); PROJECT rules editing; npm publish / fleet deploy (user-gated).
- Dedicated cross-host search panel — folded into the map search (the map indexes mirror records with node tags; spec amended 2026-07-05). The `/cross-host` endpoint remains MCP/API-only.
