# Cross-Project Memory Signpost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Auto-write a managed `_cross-project.md` signpost (+ a MEMORY.md pointer) into every project's memory dir so an LLM recalling memory knows to pull other projects' memory via the langmart MCP tools.

**Architecture:** A new `cross-project-signpost.ts` module (pure `renderSignpost` + idempotent `ensureSignpostFor` + `sweepAllProjects`), gated by a `crossProjectSignpostEnabled` setting (default true), swept on Core start + on project-set change. The managed file is excluded from knowledge records (parseDir/extractRecords) and from cross-node sync (autosync guard). Spec: `docs/superpowers/specs/2026-06-23-cross-project-memory-signpost-design.md`.

**Conventions:** node ≥20 (`export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`); build+test `cd core && npm run build:test && node --test dist-test/__tests__/<f>.test.js`. Tests that touch memory-api must `resetMemoryCache()` + `stopSessionCache()` in teardown (LMDB/chokidar handles).

---

## Task 1: `renderSignpost` (pure markdown)

**Files:** Create `core/src/memory/cross-project-signpost.ts`; Test `core/src/__tests__/cross-project-signpost-render.test.ts`

- [ ] **Step 1: failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSignpost, SIGNPOST_FILE } from '../memory/cross-project-signpost';

test('renders the static tool list + each other project, excludes self', () => {
  const md = renderSignpost({ slug: '-a', name: 'alpha' }, [
    { slug: '-b', name: 'beta', hook: 'trading engine' },
    { slug: '-c', name: 'gamma' },
  ]);
  for (const tool of ['memory_projects', 'getByProject', 'search_memory', 'memory_cross_host']) assert.match(md, new RegExp(tool));
  assert.match(md, /\*\*beta\*\* \(`-b`\) — trading engine/);
  assert.match(md, /\*\*gamma\*\* \(`-c`\)/);
  assert.doesNotMatch(md, /`-a`/);            // self not listed
  assert.match(md, /managed by lm-assist/);   // managed header
  assert.match(md, /cross-project v\d+/);     // version marker
});

test('renders an empty-others placeholder', () => {
  assert.match(renderSignpost({ slug: '-a', name: 'alpha' }, []), /no other projects/i);
});
```
Run: `cd core && npm run build:test && node --test dist-test/__tests__/cross-project-signpost-render.test.js` → FAIL (module missing).

- [ ] **Step 2: implement** (the module — render only for now)
```ts
// core/src/memory/cross-project-signpost.ts
export const SIGNPOST_VERSION = 1;
export const SIGNPOST_FILE = '_cross-project.md';
const MANAGED_HEADER = '<!-- managed by lm-assist — do not edit; regenerated automatically -->';

export interface ProjectRef { slug: string; name: string; hook?: string; }

export function renderSignpost(_self: ProjectRef, others: ProjectRef[]): string {
  const lines: string[] = [
    MANAGED_HEADER,
    `<!-- lm-assist:cross-project v${SIGNPOST_VERSION} -->`,
    '', '# Cross-Project Memory', '',
    "This lm-assist node curates memory for MULTIPLE projects. When THIS project's own memory is thin,",
    'or a question spans projects / references shared infra or conventions, pull another project\'s',
    'curated memory on demand via the **langmart MCP** tools:', '',
    '- `memory_projects` — list every project with curated memory (+ its slug).',
    '- `detail` / by-project read (`getByProject`) — read another project\'s memory by slug.',
    '- `search_memory` — search memory across projects.',
    '- `memory_cross_host` — portable knowledge mirrored from other hosts.', '',
    "Prefer THIS project's memory first; reach cross-project when it adds value.", '',
    '## Other projects on this node', '',
  ];
  if (others.length === 0) lines.push('_(no other projects with curated memory yet)_');
  else for (const o of others) {
    const hook = o.hook && o.hook.trim() ? ` — ${o.hook.trim()}` : '';
    lines.push(`- **${o.name}** (\`${o.slug}\`)${hook}`);
  }
  lines.push('');
  return lines.join('\n');
}
```
Run tests → PASS.

- [ ] **Step 3: commit** `feat(memory): renderSignpost — cross-project memory signpost markdown`

---

## Task 2: `ensureSignpostFor` (write file + MEMORY.md pointer, idempotent)

**Files:** Modify `core/src/memory/cross-project-signpost.ts`; Test `core/src/__tests__/cross-project-signpost-ensure.test.ts`

- [ ] **Step 1: failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { ensureSignpostFor, SIGNPOST_FILE, POINTER_LINE } from '../memory/cross-project-signpost';

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-')); fs.mkdirSync(path.join(d,'memory'),{recursive:true}); return path.join(d,'memory'); }

test('writes the file + a single MEMORY.md pointer, idempotently', () => {
  const dir = tmp();
  const r1 = ensureSignpostFor(dir, 'CONTENT-V1');
  assert.equal(r1.wroteFile, true); assert.equal(r1.wrotePointer, true);
  assert.equal(fs.readFileSync(path.join(dir, SIGNPOST_FILE), 'utf-8'), 'CONTENT-V1');
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8'), new RegExp(`\\(${SIGNPOST_FILE}\\)`));
  // re-run, same content → no writes
  const r2 = ensureSignpostFor(dir, 'CONTENT-V1');
  assert.equal(r2.wroteFile, false); assert.equal(r2.wrotePointer, false);
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.equal(idx.split(SIGNPOST_FILE).length - 1, 1); // pointer appears once
});

test('changed content rewrites the file but keeps one pointer', () => {
  const dir = tmp();
  ensureSignpostFor(dir, 'V1');
  const r = ensureSignpostFor(dir, 'V2');
  assert.equal(r.wroteFile, true); assert.equal(r.wrotePointer, false);
  assert.equal(fs.readFileSync(path.join(dir, SIGNPOST_FILE), 'utf-8'), 'V2');
});

test('preserves an existing user MEMORY.md, appending the pointer once', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# My Index\n\n- [Note](note.md) — a thing\n');
  ensureSignpostFor(dir, 'V1');
  const idx = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  assert.match(idx, /My Index/); assert.match(idx, /note\.md/);
  assert.match(idx, new RegExp(POINTER_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
```

- [ ] **Step 2: implement** (append to the module)
```ts
import * as fs from 'fs';
import * as path from 'path';

export const POINTER_LINE =
  `- [Cross-Project Memory](${SIGNPOST_FILE}) — other projects' memory via langmart MCP (managed)`;

export function ensureSignpostFor(liveMemDir: string, content: string): { wroteFile: boolean; wrotePointer: boolean } {
  fs.mkdirSync(liveMemDir, { recursive: true });
  const filePath = path.join(liveMemDir, SIGNPOST_FILE);
  let wroteFile = false, prev = '';
  try { prev = fs.readFileSync(filePath, 'utf-8'); } catch { /* none */ }
  if (prev !== content) { fs.writeFileSync(filePath, content); wroteFile = true; }

  const indexPath = path.join(liveMemDir, 'MEMORY.md');
  let index = '';
  try { index = fs.readFileSync(indexPath, 'utf-8'); } catch { /* none */ }
  let wrotePointer = false;
  if (!index.includes(`(${SIGNPOST_FILE})`)) {
    const head = index ? '' : '# Memory Index\n\n';
    const sep = index && !index.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(indexPath, `${head}${index}${sep}${POINTER_LINE}\n`);
    wrotePointer = true;
  }
  return { wroteFile, wrotePointer };
}
```
Run tests → PASS. Commit `feat(memory): ensureSignpostFor — idempotent file + MEMORY.md pointer`.

---

## Task 3: exclude the managed file from records + cross-node sync

**Files:** Modify `core/src/memory/record-extract.ts`, `core/src/memory-cache.ts`, `core/src/memory/autosync.ts`; Test `core/src/__tests__/cross-project-signpost-exclude.test.ts`

- [ ] **Step 1: failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords } from '../memory/record-extract';

test('extractRecords skips the managed _cross-project.md file', () => {
  const recs = extractRecords({ node:'n', project:'p', source:'live', filename:'_cross-project.md',
    content:'# Cross-Project Memory\n\nbody', mtimeMs:1, size:1 });
  assert.equal(recs.length, 0);
});
```

- [ ] **Step 2: implement**
- `record-extract.ts` `extractRecords` (top of the fn): `const base = inp.filename.split('/').pop() || inp.filename; if (base === '_cross-project.md') return [];` (place BEFORE the CLAUDE.md/MEMORY.md dispatch; reuse the existing `base`).
- `memory-cache.ts` `parseDir` (next to the `HOSTS_REGISTRY` skip): `if (entry.name === '_cross-project.md') continue;`
- `autosync.ts` `guard()` (next to the MEMORY.md/_hosts.md line): `if (file === '_cross-project.md') return 'managed-signpost';`

Run the test → PASS; then `cd core && npm run build` (must compile). Commit `feat(memory): exclude _cross-project.md from records + cross-node sync`.

---

## Task 4: `crossProjectSignpostEnabled` setting (default true)

**Files:** Modify `core/src/project-settings.ts`; Test `core/src/__tests__/cross-project-signpost-setting.test.ts`

- [ ] **Step 1: failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

test('crossProjectSignpostEnabled defaults true; reads false from file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-set-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  delete require.cache[require.resolve('../project-settings')];
  const { getProjectSettings } = require('../project-settings');
  assert.equal(getProjectSettings().crossProjectSignpostEnabled, true);
  fs.writeFileSync(path.join(dir, 'project-settings.json'), JSON.stringify({ crossProjectSignpostEnabled: false }));
  // mtime cache: force a fresh read by bumping the file
  assert.equal(getProjectSettings().crossProjectSignpostEnabled, false);
});
```
(Note: `getDataDir()` reads `LM_ASSIST_DATA_DIR`. If the mtime cache returns stale, write the file BEFORE the first read in the test, or assert default in a separate tmp dir. Adjust to the real `getDataDir` behavior when implementing.)

- [ ] **Step 2: implement** — add `crossProjectSignpostEnabled: boolean` to `ProjectSettings`, `DEFAULTS` (`true`), the load mapping, and the save mapping, mirroring `dataServiceEnabled` but defaulting **true**:
```ts
// interface: crossProjectSignpostEnabled: boolean;
// DEFAULTS:  crossProjectSignpostEnabled: true,
// load:      crossProjectSignpostEnabled: typeof data.crossProjectSignpostEnabled === 'boolean' ? data.crossProjectSignpostEnabled : DEFAULTS.crossProjectSignpostEnabled,
// save:      crossProjectSignpostEnabled: typeof partial.crossProjectSignpostEnabled === 'boolean' ? partial.crossProjectSignpostEnabled : current.crossProjectSignpostEnabled,
```
Run test → PASS. Commit `feat(settings): crossProjectSignpostEnabled (default true)`.

---

## Task 5: `sweepAllProjects` (generate per-project, gated, excluded/self filtered)

**Files:** Modify `core/src/memory/cross-project-signpost.ts`; Test `core/src/__tests__/cross-project-signpost-sweep.test.ts`

- [ ] **Step 1: failing test** (hermetic via `CLAUDE_CONFIG_DIR`; close caches in `after`)
```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sweep-'));
process.env.CLAUDE_CONFIG_DIR = TMP;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sweep-cfg-'));

import { sweepAllProjects, SIGNPOST_FILE } from '../memory/cross-project-signpost';

after(async () => { (await import('../memory-cache')).resetMemoryCache(); (await import('../session-cache')).stopSessionCache(); });

function slugFor(cwd: string) { return cwd.replace(/[:\\/]/g, '-'); }
function seedProject(name: string) {
  const cwd = path.join(os.tmpdir(), `cpssweep${name}${process.pid}`); fs.mkdirSync(cwd, { recursive: true });
  const slug = slugFor(cwd);
  const mem = path.join(TMP, 'projects', slug, 'memory'); fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'note.md'), `---\nname: ${name}\ndescription: ${name} stuff\ntype: project\n---\nbody`);
  return { slug, cwd, mem };
}

test('sweep writes each project a signpost listing the OTHER projects', async () => {
  const a = seedProject('a'); const b = seedProject('b');
  const res = await sweepAllProjects();
  assert.ok(res.swept >= 2);
  const aSign = fs.readFileSync(path.join(a.mem, SIGNPOST_FILE), 'utf-8');
  assert.match(aSign, new RegExp(b.slug));      // A lists B
  assert.doesNotMatch(aSign, new RegExp(`\\(\`${a.slug}\`\\)`)); // A doesn't list itself
  assert.match(fs.readFileSync(path.join(a.mem, 'MEMORY.md'), 'utf-8'), new RegExp(`\\(${SIGNPOST_FILE}\\)`));
});

test('sweep is idempotent (second run rewrites nothing)', async () => {
  const r1 = await sweepAllProjects();
  const r2 = await sweepAllProjects();
  assert.equal(r2.filesWritten, 0); // nothing changed
  assert.ok(r1.swept >= 0);
});
```

- [ ] **Step 2: implement** (append to the module)
```ts
import { createMemoryApiImpl } from '../api/memory-api';
import { getProjectsDir } from '../utils/path-utils';
import { getProjectSettings } from '../project-settings';

function nameFromPath(p: string): string { return path.basename(p) || p; }

/** One-line hook: the project's MEMORY.md first heading/prose, else "<n> memory entries". */
function hookFor(memDir: string, fileCount: number): string {
  try {
    const idx = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
    for (const raw of idx.split('\n')) {
      const l = raw.replace(/^#+\s*/, '').trim();
      if (l && !l.startsWith('-') && !l.startsWith('<!--')) return l.slice(0, 80);
    }
  } catch { /* none */ }
  return `${fileCount} memory entr${fileCount === 1 ? 'y' : 'ies'}`;
}

export interface SweepResult { swept: number; skipped: number; filesWritten: number; disabled?: boolean; }

export async function sweepAllProjects(): Promise<SweepResult> {
  if (!getProjectSettings().crossProjectSignpostEnabled) return { swept: 0, skipped: 0, filesWritten: 0, disabled: true };
  const api = createMemoryApiImpl();
  const res = await api.listProjects();
  const projects = (res.success && Array.isArray(res.data)) ? res.data : [];
  const excluded = new Set(getProjectSettings().excludedPaths);
  const eligible = projects.filter((p: any) => p.hasLive && !excluded.has(p.projectPath));
  const refs: ProjectRef[] = eligible.map((p: any) => ({
    slug: p.projectId, name: nameFromPath(p.projectPath),
    hook: hookFor(path.join(getProjectsDir(), p.projectId, 'memory'), p.fileCount),
  }));
  let filesWritten = 0;
  for (const p of eligible) {
    const self: ProjectRef = { slug: p.projectId, name: nameFromPath(p.projectPath) };
    const others = refs.filter((r) => r.slug !== p.projectId);
    const memDir = path.join(getProjectsDir(), p.projectId, 'memory');
    const r = ensureSignpostFor(memDir, renderSignpost(self, others));
    if (r.wroteFile || r.wrotePointer) filesWritten++;
  }
  return { swept: eligible.length, skipped: projects.length - eligible.length, filesWritten };
}
```
Run tests → PASS. (If `listProjects` returns the freshly-written signpost as a project artifact, it won't — it lists project DIRS, and our file is excluded from records anyway.) Commit `feat(memory): sweepAllProjects — generate per-project cross-project signposts`.

---

## Task 6: wire Core start + projects-root watcher

**Files:** Modify `core/src/memory/cross-project-signpost.ts` (add `startCrossProjectSignpost`), `core/src/rest-server.ts`

- [ ] **Step 1: implement** `startCrossProjectSignpost()` — sweep once (fire-and-forget) + chokidar watch the projects root (depth 0) → debounced re-sweep on `addDir`/`unlinkDir`:
```ts
import chokidar from 'chokidar';
let watcher: any = null; let debounce: NodeJS.Timeout | null = null;
export function startCrossProjectSignpost(): void {
  if (!getProjectSettings().crossProjectSignpostEnabled) return;
  void sweepAllProjects().catch(() => {});
  if (watcher) return;
  try {
    watcher = chokidar.watch(getProjectsDir(), { depth: 0, ignoreInitial: true, persistent: true });
    const kick = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => void sweepAllProjects().catch(() => {}), 2000); };
    watcher.on('addDir', kick); watcher.on('unlinkDir', kick);
  } catch { /* watcher optional */ }
}
```
- In `rest-server.ts`, next to the autosync daemon start (~line 152), add:
```ts
try { require('./memory/cross-project-signpost').startCrossProjectSignpost(); } catch { /* optional */ }
```

- [ ] **Step 2: verify** `cd core && npm run build` compiles; Core boot smoke is covered by the full suite. Commit `feat(memory): sweep cross-project signposts on Core start + project-set change`.

---

## Task 7: full verification

- [ ] `cd core && npm run build && npm run build:test && node --test --test-timeout=120000 $(find dist-test/__tests__ -name '*.test.js')` → no NEW failures vs the known environmental baseline. Commit any fixups, then finishing-a-development-branch.

---

## Self-review notes
- `chokidar` is pinned `^3.6.0` (CommonJS) — `import chokidar from 'chokidar'` + `chokidar.watch` matches the v3 API already used in `autosync.ts`/`memory-cache.ts`. Do NOT bump.
- Confirm `getDataDir()` honors `LM_ASSIST_DATA_DIR` for the Task 4 test (it's used by `transfer-stats`/`port-forward`); if the mtime cache makes the default-then-false read flaky, split into two tmp dirs.
- `listProjects` excludes our managed file from `fileCount` only if Task 3's parseDir skip lands first — keep Task 3 before Task 5.
