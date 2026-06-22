# Direct-MCP Memory Sync + Persistence Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync a project's curated memory directly node-to-node over the hub (no git), with a persistence tier (persistent vs temporary) and auto-managed bidirectional sync — a cloud worker auto-pulls a project's persistent memory at bootstrap and pushes its new memory back to the persistent home node.

**Architecture:** Extend the EXISTING `MemoryAutoSyncDaemon` (`core/src/memory/autosync.ts`), which already does detect → filter → transport → notify. We (a) add a `persistence` field to `MemoryRecord`, (b) add a node-mode + home-node config, (c) add `/memory/export` + `/memory/ingest` Core endpoints, (d) add a hub-relayed transport client (key-in-body, like the data service), (e) swap the daemon's git `mirrorAndPush`/`onRemoteUpdate` for that transport, and (f) add the cloud bootstrap pull. Spec: `docs/superpowers/specs/2026-06-22-direct-mcp-memory-sync-design.md`.

**Tech Stack:** TypeScript (CommonJS, `core/tsconfig.json`), Node `http` server + modular routes (`RouteHandler`), the hub WebSocket client (`core/src/hub-client/`), `node --test` (build with `npm run build:test` → `dist-test/`, run from `core/`).

**Conventions (read once):**
- Build core: `cd core && npm run build` (tsc). Build+run tests: `cd core && npm run build:test && node --test --test-timeout=90000 dist-test/__tests__/<file>.test.js`. Use node ≥20: `export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`.
- Routes return `{ success, data }` or `{ success:false, error:{code,message} }` (success:false → HTTP 400). Pattern: a `create*Routes(ctx)` fn returning `RouteHandler[]`, registered in `core/src/routes/core/index.ts`.
- Memory dirs: `~/.claude/projects/<projectSlug>/memory/*.md` (live) + `memory/<hostId>/*.md` (per-host mirrors). `getProjectsDir()` (from `core/src/utils/path-utils`) → the projects root; `decodePath(slug)` → real cwd.
- This node's id: `getHubClient().status.gatewayId` (string | null). Hub notify: `getHubClient().sendMemoryUpdated({project,host,recordIds,ts})` (already exists).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/src/memory/record-extract.ts` (modify) | Add `persistence` to `MemoryRecord` + parse `persistence:` frontmatter (default `persistent`). |
| `core/src/memory/node-mode.ts` (create) | Read node mode (`persistent`/`ephemeral`) + home-node id from `~/.lm-assist/memory-sync.json`. |
| `core/src/api/memory-api.ts` (modify) | `exportRecords(project, sinceMs)` (persistent, project-domain only) + `ingestRecords(sourceHost, records)` (write `memory/<sourceHost>/`). |
| `core/src/routes/core/memory-sync.routes.ts` (create) | `GET /memory/export`, `POST /memory/ingest` (key-in-body access-key when relayed). |
| `core/src/hub-client/api-relay-handler.ts` (modify) | Add `/memory` to `ALLOWED_API_PREFIXES`. |
| `core/src/memory/mcp-transport.ts` (create) | `pullFromHome(homeId, project, sinceMs)` + `pushToHome(homeId, records)` — relayed over the hub, key-in-body. |
| `core/src/memory/autosync.ts` (modify) | Gate by persistence+mode; swap `mirrorAndPush`→`pushToHome`, `onRemoteUpdate`→`pullFromHome`. |
| `core/src/terminal/ccr-cloud.ts` (modify) | `cloudStart` writes `memory-sync.json {homeNode, project, nodeMode:'ephemeral'}`; `buildBootstrapInstruction` adds the background-pull step. |
| `core/src/mcp-server/tools/expanded.ts` (modify) | `memory_sync_status` tool. |

---

## Task 1: Add `persistence` tier to the record model

**Files:**
- Modify: `core/src/memory/record-extract.ts` (interface ~line 19; the `memory`-kind extraction)
- Test: `core/src/__tests__/record-extract-persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/record-extract-persistence.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecords } from '../memory/record-extract';

const base = { node: 'n1', project: 'p1', source: 'live', mtimeMs: 1, size: 10 };

test('persistence defaults to "persistent" when frontmatter omits it', () => {
  const recs = extractRecords({ ...base, filename: 'foo.md',
    content: '---\nname: foo\ndescription: a project fact\ntype: project\n---\nbody' });
  assert.equal(recs[0].persistence, 'persistent');
});

test('persistence reads "temporary" from frontmatter', () => {
  const recs = extractRecords({ ...base, filename: 'scratch.md',
    content: '---\nname: scratch\ndescription: d\ntype: project\npersistence: temporary\n---\nbody' });
  assert.equal(recs[0].persistence, 'temporary');
});

test('unknown persistence value falls back to persistent', () => {
  const recs = extractRecords({ ...base, filename: 'x.md',
    content: '---\nname: x\ndescription: d\ntype: project\npersistence: bogus\n---\nbody' });
  assert.equal(recs[0].persistence, 'persistent');
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/record-extract-persistence.test.js`
Expected: FAIL — `persistence` is `undefined` (property not on the record).

- [ ] **Step 3: Add the field + parse it**

In `record-extract.ts`, add to the `MemoryRecord` interface (after `shareability: Shareability;`):
```ts
  persistence: 'persistent' | 'temporary';   // ephemeral-node working-copy marker; default persistent
```
Add a helper near `slug()`:
```ts
function readPersistence(fm: { persistence?: unknown }): 'persistent' | 'temporary' {
  return fm && fm.persistence === 'temporary' ? 'temporary' : 'persistent';
}
```
In the `memory`-kind record build (where the standard one-file record object is constructed), add the property using the parsed frontmatter already in scope:
```ts
    persistence: readPersistence(frontmatter),
```
(For `claude-section` and `index-entry` kinds, set `persistence: 'persistent'` literally — CLAUDE.md/MEMORY.md are never temporary.)

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/record-extract-persistence.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/record-extract.ts core/src/__tests__/record-extract-persistence.test.ts
git commit -m "feat(memory): persistence tier on MemoryRecord (default persistent, temporary opt-out)"
```

---

## Task 2: Node-mode + home-node config reader

**Files:**
- Create: `core/src/memory/node-mode.ts`
- Test: `core/src/__tests__/node-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/node-mode.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMemorySyncConfig } from '../memory/node-mode';

function withTmpHome(cfg: object | null, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  fs.mkdirSync(path.join(dir, '.lm-assist'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(dir, '.lm-assist', 'memory-sync.json'), JSON.stringify(cfg));
  fn(dir);
}

test('defaults to persistent mode + no home when file missing', () => {
  withTmpHome(null, (dir) => {
    const c = readMemorySyncConfig(dir);
    assert.equal(c.nodeMode, 'persistent');
    assert.equal(c.homeNode, null);
  });
});

test('reads ephemeral mode + homeNode from file', () => {
  withTmpHome({ nodeMode: 'ephemeral', homeNode: 'gw4-abc', project: '-home-x' }, (dir) => {
    const c = readMemorySyncConfig(dir);
    assert.equal(c.nodeMode, 'ephemeral');
    assert.equal(c.homeNode, 'gw4-abc');
    assert.equal(c.project, '-home-x');
  });
});

test('malformed json → safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  fs.mkdirSync(path.join(dir, '.lm-assist'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.lm-assist', 'memory-sync.json'), '{not json');
  assert.equal(readMemorySyncConfig(dir).nodeMode, 'persistent');
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/node-mode.test.js`
Expected: FAIL — cannot find module `../memory/node-mode`.

- [ ] **Step 3: Implement**

```ts
// core/src/memory/node-mode.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type NodeMode = 'persistent' | 'ephemeral';
export interface MemorySyncConfig {
  nodeMode: NodeMode;
  homeNode: string | null;  // hub gatewayId of the persistent home node to sync with
  project: string | null;   // project slug this ephemeral node is working on
}

const DEFAULTS: MemorySyncConfig = { nodeMode: 'persistent', homeNode: null, project: null };

/** Read ~/.lm-assist/memory-sync.json (override home dir for tests). Never throws. */
export function readMemorySyncConfig(homeDir: string = os.homedir()): MemorySyncConfig {
  const p = process.env.LM_ASSIST_DATA_DIR
    ? path.join(process.env.LM_ASSIST_DATA_DIR, 'memory-sync.json')
    : path.join(homeDir, '.lm-assist', 'memory-sync.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return {
      nodeMode: raw.nodeMode === 'ephemeral' ? 'ephemeral' : 'persistent',
      homeNode: typeof raw.homeNode === 'string' && raw.homeNode ? raw.homeNode : null,
      project: typeof raw.project === 'string' && raw.project ? raw.project : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write the config (used by cloud bootstrap). Never throws. */
export function writeMemorySyncConfig(cfg: Partial<MemorySyncConfig>, homeDir: string = os.homedir()): void {
  const dir = process.env.LM_ASSIST_DATA_DIR || path.join(homeDir, '.lm-assist');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const merged = { ...readMemorySyncConfig(homeDir), ...cfg };
    fs.writeFileSync(path.join(dir, 'memory-sync.json'), JSON.stringify(merged, null, 2));
  } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/node-mode.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/node-mode.ts core/src/__tests__/node-mode.test.ts
git commit -m "feat(memory): node-mode + home-node config (~/.lm-assist/memory-sync.json)"
```

---

## Task 3: `exportRecords` — serve this node's syncable records

**Files:**
- Create: `core/src/memory/sync-select.ts` (pure selection logic — easy to test)
- Test: `core/src/__tests__/sync-select.test.ts`

Rationale: keep the "which records sync" rule a pure function (no fs), reused by export AND push-back.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/sync-select.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSyncable } from '../memory/sync-select';
import type { MemoryRecord } from '../memory/record-extract';

function rec(p: Partial<MemoryRecord>): MemoryRecord {
  return { recordId: 'n:pr:f#', contentHash: 'h', node: 'n', project: 'pr', source: 'live',
    file: 'f.md', kind: 'memory', anchor: '', title: 't', brief: 'b', complete: 'c',
    type: 'project', category: '', shareability: 'project-domain', persistence: 'persistent',
    recordedAtMs: 1, lastValidatedMs: 1, validity: 'current', validationTier: 'asserted',
    mtimeMs: 1, size: 1, ...p } as MemoryRecord;
}

test('keeps persistent project-domain records', () => {
  assert.equal(selectSyncable([rec({})]).length, 1);
});
test('drops temporary records', () => {
  assert.equal(selectSyncable([rec({ persistence: 'temporary' })]).length, 0);
});
test('drops host-local records', () => {
  assert.equal(selectSyncable([rec({ shareability: 'host-local' })]).length, 0);
});
test('keeps ambiguous shareability', () => {
  assert.equal(selectSyncable([rec({ shareability: 'ambiguous' })]).length, 1);
});
test('sinceMs filters by recordedAtMs', () => {
  assert.equal(selectSyncable([rec({ recordedAtMs: 5 })], 10).length, 0);
  assert.equal(selectSyncable([rec({ recordedAtMs: 20 })], 10).length, 1);
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/sync-select.test.js`
Expected: FAIL — cannot find module `../memory/sync-select`.

- [ ] **Step 3: Implement**

```ts
// core/src/memory/sync-select.ts
import type { MemoryRecord } from './record-extract';

/** The records eligible to leave this node: persistent + shareable, optionally newer than sinceMs. */
export function selectSyncable(records: MemoryRecord[], sinceMs = 0): MemoryRecord[] {
  return records.filter(r =>
    r.persistence === 'persistent' &&
    r.shareability !== 'host-local' &&
    r.recordedAtMs > sinceMs
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/sync-select.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/sync-select.ts core/src/__tests__/sync-select.test.ts
git commit -m "feat(memory): selectSyncable — persistent + shareable + sinceMs filter"
```

---

## Task 4: `ingestRecords` — write a peer's records into its mirror

**Files:**
- Create: `core/src/memory/ingest.ts`
- Test: `core/src/__tests__/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/ingest.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ingestRecords } from '../memory/ingest';

function tmpProjectDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ing-'));
  const projDir = path.join(root, '-home-x');
  fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
  return projDir;
}

test('writes a record file under memory/<sourceHost>/ and a MEMORY.md pointer', () => {
  const projDir = tmpProjectDir();
  const n = ingestRecords(projDir, 'gw4-home', [
    { file: 'fact.md', content: '---\nname: fact\ndescription: d\ntype: project\n---\nbody', contentHash: 'h1' },
  ]);
  assert.equal(n, 1);
  const f = path.join(projDir, 'memory', 'gw4-home', 'fact.md');
  assert.ok(fs.existsSync(f));
  assert.match(fs.readFileSync(f, 'utf-8'), /name: fact/);
});

test('skips an unchanged file (same contentHash sidecar)', () => {
  const projDir = tmpProjectDir();
  const rec = { file: 'fact.md', content: 'x', contentHash: 'h1' };
  assert.equal(ingestRecords(projDir, 'gw4-home', [rec]), 1);
  assert.equal(ingestRecords(projDir, 'gw4-home', [rec]), 0); // dedup by hash
});

test('rejects path traversal in file name', () => {
  const projDir = tmpProjectDir();
  assert.equal(ingestRecords(projDir, 'gw4-home', [{ file: '../evil.md', content: 'x', contentHash: 'h' }]), 0);
  assert.ok(!fs.existsSync(path.join(projDir, '..', 'evil.md')));
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/ingest.test.js`
Expected: FAIL — cannot find module `../memory/ingest`.

- [ ] **Step 3: Implement**

```ts
// core/src/memory/ingest.ts
import * as fs from 'fs';
import * as path from 'path';

export interface IngestRecord { file: string; content: string; contentHash: string; }

/** Write a peer's records into <projectDir>/memory/<sourceHost>/. Dedup via a .hashes sidecar.
 *  Returns the number actually written. Never writes outside the mirror dir. */
export function ingestRecords(projectDir: string, sourceHost: string, records: IngestRecord[]): number {
  if (!/^[A-Za-z0-9._-]+$/.test(sourceHost)) return 0;
  const mirrorDir = path.join(projectDir, 'memory', sourceHost);
  fs.mkdirSync(mirrorDir, { recursive: true });
  const hashFile = path.join(mirrorDir, '.hashes.json');
  let hashes: Record<string, string> = {};
  try { hashes = JSON.parse(fs.readFileSync(hashFile, 'utf-8')); } catch { /* none */ }
  let written = 0;
  for (const r of records) {
    const safe = path.basename(r.file);                 // strip any path components
    if (!safe.endsWith('.md') || safe.startsWith('.')) continue;
    const dest = path.join(mirrorDir, safe);
    if (path.dirname(path.resolve(dest)) !== path.resolve(mirrorDir)) continue; // traversal guard
    if (hashes[safe] === r.contentHash) continue;       // unchanged
    fs.writeFileSync(dest, r.content);
    hashes[safe] = r.contentHash;
    written++;
  }
  if (written) fs.writeFileSync(hashFile, JSON.stringify(hashes));
  return written;
}
```

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/ingest.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/ingest.ts core/src/__tests__/ingest.test.ts
git commit -m "feat(memory): ingestRecords — write peer records to memory/<host>/ with hash dedup + traversal guard"
```

---

## Task 5: `/memory/export` + `/memory/ingest` routes

**Files:**
- Create: `core/src/routes/core/memory-sync.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import + register, mirroring lines 37-43)
- Test: `core/src/__tests__/memory-sync-routes.test.ts`

Auth note: when relayed via the hub the access-key arrives **in the body** (the hub `/proxy` drops the `x-lm-access-key` header — see deployment-build-gotchas memory). Both handlers accept `accessKey` in the body as an alternative to the header; reuse the existing token check used by other gated routes (`isValidToken` from `core/src/utils/claude-oauth` is NOT it — use the worker-token check already imported in `data.routes.ts`; grep `data.routes.ts` for the exact helper and reuse it).

- [ ] **Step 1: Write the failing test** (pure handler test — call the handler fn directly)

```ts
// core/src/__tests__/memory-sync-routes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySyncRoutes } from '../routes/core/memory-sync.routes';

test('exposes GET /memory/export and POST /memory/ingest', () => {
  const routes = createMemorySyncRoutes({} as any);
  const paths = routes.map(r => `${r.method} ${r.pattern.source}`);
  assert.ok(paths.some(p => p.startsWith('GET') && /\\\/memory\\\/export/.test(p)));
  assert.ok(paths.some(p => p.startsWith('POST') && /\\\/memory\\\/ingest/.test(p)));
});

test('export returns selectable records for a project', async () => {
  const routes = createMemorySyncRoutes({} as any);
  const exp = routes.find(r => r.method === 'GET' && /export/.test(r.pattern.source))!;
  const res: any = await exp.handler({ query: { project: '__nonexistent__' }, params: {} } as any, {} as any);
  assert.equal(res.success, true);
  assert.ok(Array.isArray(res.data.records));   // empty for a bogus project, but shaped
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/memory-sync-routes.test.js`
Expected: FAIL — cannot find module `../routes/core/memory-sync.routes`.

- [ ] **Step 3: Implement the routes**

```ts
// core/src/routes/core/memory-sync.routes.ts
import type { RouteHandler, RouteContext } from '../index';
import { createMemoryApiImpl } from '../../api/memory-api';
import { selectSyncable } from '../../memory/sync-select';
import { ingestRecords, IngestRecord } from '../../memory/ingest';
import { getProjectsDir } from '../../utils/path-utils';
import * as path from 'path';

function ok<T>(data: T) { return { success: true as const, data }; }
function fail(code: string, message: string) { return { success: false as const, error: { code, message } }; }

export function createMemorySyncRoutes(_ctx: RouteContext): RouteHandler[] {
  const api = createMemoryApiImpl();
  return [
    // GET /memory/export?project=&sinceMs=  → this node's syncable (persistent+shareable) records
    {
      method: 'GET',
      pattern: /^\/memory\/export$/,
      handler: async (req) => {
        const project = typeof req.query?.project === 'string' ? req.query.project : '';
        const sinceMs = Number(req.query?.sinceMs) || 0;
        if (!project) return fail('INVALID_INPUT', 'project is required');
        // api.listRecordsForProject(project) returns MemoryRecord[] from the live dir.
        // (Reuse the record extraction the map already does; grep memory-api.ts for the
        //  method that returns records for a project and call it here.)
        const records = api.listRecordsForProject(project, { sources: 'live' });
        const out = selectSyncable(records, sinceMs).map(r => ({
          file: r.file, content: r.complete /* see note */, contentHash: r.contentHash,
          recordId: r.recordId, recordedAtMs: r.recordedAtMs,
        }));
        return ok({ project, records: out });
      },
    },
    // POST /memory/ingest  { project, sourceHost, records:[{file,content,contentHash}], accessKey? }
    {
      method: 'POST',
      pattern: /^\/memory\/ingest$/,
      handler: async (req) => {
        const b = (req.body || {}) as { project?: string; sourceHost?: string; records?: IngestRecord[] };
        if (!b.project || !b.sourceHost || !Array.isArray(b.records)) {
          return fail('INVALID_INPUT', 'project, sourceHost, records[] required');
        }
        const projectDir = path.join(getProjectsDir(), b.project);
        const n = ingestRecords(projectDir, b.sourceHost, b.records);
        return ok({ ingested: n });
      },
    },
  ];
}
```

> Note (export `content`): `r.complete` is the body only. The mirror file must be the WHOLE file (frontmatter + body) so the receiver re-extracts identically. In Step 3, replace `content: r.complete` by reading the live file bytes: add a helper that reads `path.join(getProjectsDir(), project, 'memory', r.file)` and use that string; if the read fails, skip the record. (Keep it a one-liner per record.)

- [ ] **Step 4: Register + run tests**

In `core/src/routes/core/index.ts`, add next to the other memory imports/registrations:
```ts
import { createMemorySyncRoutes } from './memory-sync.routes';
// ... in the array that aggregates routes:
...createMemorySyncRoutes(ctx),
```
Run: `cd core && npm run build:test && node --test dist-test/__tests__/memory-sync-routes.test.js`
Expected: PASS (2/2). If `listRecordsForProject` isn't the real method name, grep `memory-api.ts` for the records accessor and fix the call (Task note).

- [ ] **Step 5: Commit**

```bash
git add core/src/routes/core/memory-sync.routes.ts core/src/routes/core/index.ts core/src/__tests__/memory-sync-routes.test.ts
git commit -m "feat(memory): /memory/export + /memory/ingest routes"
```

---

## Task 6: Allow `/memory` over the hub relay

**Files:**
- Modify: `core/src/hub-client/api-relay-handler.ts` (the `ALLOWED_API_PREFIXES` array, ~line 94-122)
- Test: `core/src/__tests__/relay-memory-allow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/relay-memory-allow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiRelayHandler } from '../hub-client/api-relay-handler';

test('/memory/export and /memory/ingest are relay-allowed', () => {
  // isPathAllowed is the guard used before relaying; if it's private, test via the
  // documented public check method. Grep api-relay-handler.ts for the method that
  // returns the "Path not allowed" string (line ~211) and call it.
  assert.equal((ApiRelayHandler as any).checkPath?.('GET', '/memory/export') ?? 'OK', 'OK');
});
```

> If the guard isn't statically callable, make the test assert that `'/memory'` is present in the exported/!readonly `ALLOWED_API_PREFIXES`. Adjust the test to the real surface after reading the file (the point is: `/memory` must be allow-listed).

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/relay-memory-allow.test.js`
Expected: FAIL — `/memory` not allowed.

- [ ] **Step 3: Implement**

In `api-relay-handler.ts`, add to `ALLOWED_API_PREFIXES` (next to `'/data'`):
```ts
    '/memory',        // cross-node memory sync (export/ingest; access-key in body when relayed)
```

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/relay-memory-allow.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/hub-client/api-relay-handler.ts core/src/__tests__/relay-memory-allow.test.ts
git commit -m "feat(memory): allow /memory over the hub relay (cross-node sync transport)"
```

---

## Task 7: Relayed transport client (pull/push via the hub)

**Files:**
- Create: `core/src/memory/mcp-transport.ts`
- Test: `core/src/__tests__/mcp-transport.test.ts` (test URL/body construction; the network call is integration-only)

The transport mirrors the data-service's cross-node calls. Grep `core/src/data/` (or `data-sync*`) for the existing "relay a POST to machine `<id>` with access-key in the body" helper and REUSE it. If a generic `relayToMachine(machineId, method, path, body)` exists, call it; otherwise this module builds the hub `/machines/<id>/proxy` request.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/mcp-transport.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayRequest } from '../memory/mcp-transport';

test('pull builds a relayed GET /memory/export for the home node', () => {
  const r = buildRelayRequest('gw4-home', 'GET', '/memory/export?project=p&sinceMs=5', undefined, 'KEY');
  assert.match(r.url, /\/machines\/gw4-home\/proxy/);
  assert.equal(r.method, 'POST');                 // relay envelope is a POST
  assert.equal(r.body.method, 'GET');
  assert.match(r.body.path, /\/memory\/export\?project=p/);
  assert.equal(r.body.accessKey, 'KEY');          // key in BODY (hub drops the header)
});

test('push builds a relayed POST /memory/ingest with records in body', () => {
  const recs = [{ file: 'a.md', content: 'x', contentHash: 'h' }];
  const r = buildRelayRequest('gw4-home', 'POST', '/memory/ingest',
    { project: 'p', sourceHost: 'gw4-cloud', records: recs }, 'KEY');
  assert.equal(r.body.method, 'POST');
  assert.deepEqual(r.body.payload.records, recs);
  assert.equal(r.body.accessKey, 'KEY');
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/mcp-transport.test.js`
Expected: FAIL — cannot find module `../memory/mcp-transport`.

- [ ] **Step 3: Implement** (pure builder + thin fetch wrappers)

```ts
// core/src/memory/mcp-transport.ts
import { getHubClient } from '../hub-client';

export interface RelayRequest {
  url: string; method: 'POST';
  body: { method: string; path: string; payload?: unknown; accessKey: string };
}

/** Pure: shape a relay-envelope request to a machine's Core endpoint, access-key in BODY. */
export function buildRelayRequest(
  machineId: string, method: string, path: string, payload: unknown, accessKey: string,
): RelayRequest {
  return {
    url: `/api/machines/${machineId}/proxy`,
    method: 'POST',
    body: { method, path, payload, accessKey },
  };
}

function hubBase(): string {
  // The hub HTTP base derived from the configured wss hubUrl (wss://assist-api.X → https://assist-api.X).
  const u = getHubClient().getStatus?.().hubUrl || '';
  try { const h = new URL(u).hostname; return `https://${h}`; } catch { return ''; }
}

async function relay(machineId: string, method: string, path: string, payload: unknown, accessKey: string): Promise<any> {
  const r = buildRelayRequest(machineId, method, path, payload, accessKey);
  const res = await fetch(hubBase() + r.url, {
    method: r.method, headers: { 'Content-Type': 'application/json', 'x-api-key': accessKey },
    body: JSON.stringify(r.body),
  });
  return res.ok ? res.json() : null;
}

/** Pull a project's syncable records from the home node. */
export async function pullFromHome(homeId: string, project: string, sinceMs: number, key: string) {
  const j = await relay(homeId, 'GET', `/memory/export?project=${encodeURIComponent(project)}&sinceMs=${sinceMs}`, undefined, key);
  return (j && j.data && j.data.records) || [];
}

/** Push records to the home node's mirror for this host. */
export async function pushToHome(homeId: string, project: string, sourceHost: string, records: unknown[], key: string) {
  const j = await relay(homeId, 'POST', '/memory/ingest', { project, sourceHost, records }, key);
  return (j && j.data && typeof j.data.ingested === 'number') ? j.data.ingested : 0;
}
```

> Reconcile with reality: if `core/src/data/` already has a relay helper, replace `hubBase()`+`relay()` internals with a call to it (keep `buildRelayRequest` for the unit test + the body shape). The access-key is read from `~/.lm-assist/hub.json.apiKey` by the caller (Task 8), not hardcoded.

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/mcp-transport.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/mcp-transport.ts core/src/__tests__/mcp-transport.test.ts
git commit -m "feat(memory): relayed MCP transport (pullFromHome/pushToHome, key-in-body)"
```

---

## Task 8: Retarget the autosync daemon (git → MCP)

**Files:**
- Modify: `core/src/memory/autosync.ts` (`mirrorAndPush` ~line 352, `onRemoteUpdate` ~line 402, and the filter that picks `files`/`recordIds`)
- Test: `core/src/__tests__/autosync-transport.test.ts`

The daemon already detects changes, resolves `hostId`, and in `on` mode calls `mirrorAndPush` then `hub.sendMemoryUpdated`. We change WHAT transport it uses and add the persistence/mode gate. Keep observe-mode logging.

- [ ] **Step 1: Write the failing test** (mode gate + persistence filter — inject the transport)

```ts
// core/src/__tests__/autosync-transport.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPushBack } from '../memory/autosync';   // extract a pure planner (Step 3)
import type { MemoryRecord } from '../memory/record-extract';

function rec(p: Partial<MemoryRecord>): MemoryRecord {
  return { recordId: 'i', contentHash: 'h', node: 'n', project: 'pr', source: 'live', file: 'f.md',
    kind: 'memory', anchor: '', title: 't', brief: 'b', complete: 'c', type: 'project', category: '',
    shareability: 'project-domain', persistence: 'persistent', recordedAtMs: 9, lastValidatedMs: 9,
    validity: 'current', validationTier: 'asserted', mtimeMs: 9, size: 1, ...p } as MemoryRecord;
}

test('ephemeral node pushes persistent+shareable records to the home node', () => {
  const plan = planPushBack({ nodeMode: 'ephemeral', homeNode: 'gw4-home', project: 'pr' },
    [rec({}), rec({ persistence: 'temporary' }), rec({ shareability: 'host-local' })]);
  assert.equal(plan.action, 'push');
  assert.equal(plan.homeNode, 'gw4-home');
  assert.equal(plan.records.length, 1);          // only the persistent project-domain one
});

test('persistent node does not push back (it IS the home)', () => {
  const plan = planPushBack({ nodeMode: 'persistent', homeNode: null, project: 'pr' }, [rec({})]);
  assert.equal(plan.action, 'none');
});

test('ephemeral node with no homeNode → none', () => {
  const plan = planPushBack({ nodeMode: 'ephemeral', homeNode: null, project: 'pr' }, [rec({})]);
  assert.equal(plan.action, 'none');
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/autosync-transport.test.js`
Expected: FAIL — `planPushBack` not exported.

- [ ] **Step 3: Implement the pure planner + wire the transport**

Add to `autosync.ts`:
```ts
import { selectSyncable } from './sync-select';
import type { MemorySyncConfig } from './node-mode';
import type { MemoryRecord } from './record-extract';

export interface PushPlan {
  action: 'push' | 'none';
  homeNode: string | null;
  records: MemoryRecord[];
}

/** Pure: given this node's config + changed records, decide what to push back to home. */
export function planPushBack(cfg: MemorySyncConfig, changed: MemoryRecord[]): PushPlan {
  if (cfg.nodeMode !== 'ephemeral' || !cfg.homeNode) return { action: 'none', homeNode: null, records: [] };
  const records = selectSyncable(changed);
  return records.length
    ? { action: 'push', homeNode: cfg.homeNode, records }
    : { action: 'none', homeNode: cfg.homeNode, records: [] };
}
```
Then in the daemon's on-mode path, REPLACE the body of `mirrorAndPush` (the git copy/commit/push block) with: build the push records (read each file's bytes), call `pushToHome(plan.homeNode, slug, thisHostId, records, key)` from `mcp-transport`, where `key` = `readHubConfig().apiKey`. Keep the subsequent `hub.sendMemoryUpdated(...)` notify (unchanged). REPLACE `onRemoteUpdate`'s git-fetch with `pullFromHome(m.host, m.project, watermark, key)` → `ingestRecords(projectPath, m.host, records)` → refresh cache. Gate the whole on-mode path with `planPushBack(readMemorySyncConfig(), changedRecords)` so temporary/host-local never leave and persistent nodes never push.

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/autosync-transport.test.js`
Expected: PASS (3/3). Then full daemon smoke: `cd core && npm run build` (must compile clean).

- [ ] **Step 5: Commit**

```bash
git add core/src/memory/autosync.ts core/src/__tests__/autosync-transport.test.ts
git commit -m "feat(memory): autosync uses direct-MCP transport + persistence/mode gate (replaces git)"
```

---

## Task 9: Cloud bootstrap — write config + background pull

**Files:**
- Modify: `core/src/terminal/ccr-cloud.ts` (`cloudStart` to pass/persist `homeNode`; `buildBootstrapInstruction` to add the pull step)
- Test: `core/src/__tests__/ccr-cloud.test.ts` (extend the existing file)

- [ ] **Step 1: Write the failing test**

```ts
// add to core/src/__tests__/ccr-cloud.test.ts
import { buildBootstrapInstruction } from '../terminal/ccr-cloud';

test('worker bootstrap includes the background persistent-memory pull step', () => {
  const p = buildBootstrapInstruction({ role: 'worker', primaryRepo: 'langmartai/lm-assist' });
  assert.match(p, /memory-sync\.json|pull .*persistent memory|memory_sync/i);
  assert.match(p, /background/i);
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/ccr-cloud.test.js`
Expected: FAIL — no memory-pull text in the instruction.

- [ ] **Step 3: Implement**

In `buildBootstrapInstruction`, in the worker section (after the enroll guidance), append:
```
- MEMORY: after enroll, lm-assist auto-manages this project's memory — it pulls the project's
  PERSISTENT memory from your home node and pushes your NEW memory back so it survives this VM.
  This runs in the BACKGROUND (driven by ~/.lm-assist/memory-sync.json). You don't manage it;
  mark a memory file `persistence: temporary` only for scratch that should die with this VM.
```
In `cloudStart`, when `opts.role === 'worker'`, include the home node in the seed so the worker can write `memory-sync.json` on boot: set it from the creating node's gatewayId (`getHubClient().getStatus().gatewayId`) and the project slug, e.g. add to the prompt or pass a small JSON the bootstrap writes. (Minimal: have the bootstrap step write `memory-sync.json {nodeMode:'ephemeral', homeNode:'<gatewayId>', project:'<slug>'}` using `writeMemorySyncConfig` from Task 2.)

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/ccr-cloud.test.js`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add core/src/terminal/ccr-cloud.ts core/src/__tests__/ccr-cloud.test.ts
git commit -m "feat(ccr-cloud): cloud bootstrap configures + auto-pulls persistent memory (background)"
```

---

## Task 10: `memory_sync_status` MCP tool

**Files:**
- Modify: `core/src/mcp-server/tools/expanded.ts` (add a tool def + handler, mirroring `memory_projects`)
- Test: `core/src/__tests__/memory-sync-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/memory-sync-status.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMemorySyncStatus } from '../mcp-server/tools/expanded';

test('reports node mode + home node + per-project sync counts', async () => {
  const r = await handleMemorySyncStatus({});
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  assert.match(text, /nodeMode|persistent|ephemeral/);
});
```

- [ ] **Step 2: Run it to verify failure**

`cd core && npm run build:test && node --test dist-test/__tests__/memory-sync-status.test.js`
Expected: FAIL — `handleMemorySyncStatus` not exported.

- [ ] **Step 3: Implement** (in `expanded.ts`, mirror `memoryProjectsToolDef`/`handleMemoryProjects`)

```ts
export const memorySyncStatusToolDef = {
  name: 'memory_sync_status',
  description: 'Show this node\'s memory-sync state: mode (persistent/ephemeral), home node, and ' +
    'per-project synced/pending counts. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export async function handleMemorySyncStatus(_args: Record<string, unknown>) {
  const { readMemorySyncConfig } = await import('../../memory/node-mode');
  const cfg = readMemorySyncConfig();
  return { content: [{ type: 'text', text: JSON.stringify({
    nodeMode: cfg.nodeMode, homeNode: cfg.homeNode, project: cfg.project,
  }, null, 2) }] };
}
```
Register it in the tool dispatch table + the TOOL_SCOPES map (grep `expanded.ts` for where `memory_projects` is added to both — add `memory_sync_status` identically, else `assertScopesCoverTools` crashes Core).

- [ ] **Step 4: Run tests to verify pass**

`cd core && npm run build:test && node --test dist-test/__tests__/memory-sync-status.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/tools/expanded.ts core/src/__tests__/memory-sync-status.test.ts
git commit -m "feat(memory): memory_sync_status MCP tool"
```

---

## Task 11: Full-suite verification

- [ ] **Step 1: Build + run the whole core suite**

`cd core && npm run build && npm run build:test && node --test --test-timeout=120000 $(find dist-test/__tests__ -name '*.test.js')`
Expected: 0 fail. Fix any regressions before finishing.

- [ ] **Step 2: Commit (if any fixups)** then proceed to finishing-a-development-branch.

---

## Self-review notes (gaps flagged for the implementer)

- **Real method names:** Tasks 5 and 8 call `api.listRecordsForProject(...)` and read live file bytes — confirm the exact records accessor in `memory-api.ts`/`memory-cache.ts` (the map already extracts records; reuse that path). The plan marks each spot.
- **Relay helper:** Task 7 reuses the data-service's relay if present; otherwise the included `hubBase()`/`relay()` stands. Confirm `getHubClient().getStatus().hubUrl` is the real accessor (grep `hub-client/index.ts` — `status.gatewayId`/`hubUrl`).
- **Worker-token check** for `/memory/export|ingest` (Task 5): reuse the exact gate `data.routes.ts` uses (key-in-body fallback), don't invent one.
- **Observe-mode** (`MEMORY_AUTOSYNC=observe`, default) must still only LOG the plan — `planPushBack` returns the plan; the daemon executes it only in `on` mode.
