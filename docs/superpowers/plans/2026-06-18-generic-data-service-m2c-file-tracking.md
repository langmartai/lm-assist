# Generic Data Service — M2c: Read-Only File/JSON Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose script-owned JSON stores and generated log artifacts through the generic data service as **read-only, allow-listed, redacted** datasets — so an LLM can read/inspect them via API/MCP, while the owning script remains the only writer and secrets in the content never leak.

**Architecture:** A new `FileBackend` (`StorageBackend`, kind `'file'`) reads a registered file's content into `DataRecord`s on demand — `'json'` format (auto-detecting object→keyed records / array→indexed records) or `'log'` format (tail of lines). Tracking is **allow-list only**: a curated `ensureTrackedFiles` auto-registers known lm-assist artifacts that exist and are not credential paths; the backend never walks the filesystem. Datasets are `readOnly: true` (a hard cap to read/query/search, already enforced by `DataService`) and every record is run through a **content scrub** (field-name redaction PLUS inline secret-value redaction) on read, because logs/JSON can carry tokens in arbitrary positions that field-name redaction alone misses. Hard-excluded credential paths can never be registered.

**Tech Stack:** TypeScript (CommonJS), Node `fs`, the existing `core/src/data/redaction.ts`, `node:test`.

## Global Constraints

- **Read-only + allow-list only.** Tracked datasets are `readOnly: true` (DataService's `enforce` already hard-caps `readOnly` to read/query/search for EVERY principal incl. local root — verify this still holds). `put`/`delete`/`admin`/`search` on the `FileBackend` throw `NOT_SUPPORTED`. The backend NEVER auto-walks a directory; only explicitly registered file paths are exposed.
- **Hard exclusion is absolute.** A file dataset whose `config.path` matches `isHardExcludedPath` (credentials: `.credentials.json`, `hub.json`/`hub-dev.json`, `claudeai-session.json`, `.env`, `keys.lmdb`, api-token, LIVE trading creds) is REFUSED at registration — `createDataset` throws and `ensureTrackedFiles` skips it.
- **Content scrub on read (defense beyond field-name redaction).** Every record the `FileBackend` returns is run through `scrubRecordContent`: secret-NAMED fields → `«redacted»` (existing behavior) AND inline secret-shaped VALUES in any string (record text, string field values) → `«redacted»` via `redactText`. This is in addition to `DataService`'s `redactRecord` (which only does field-name redaction) — the backend owns value-level scrubbing because that is where the file content enters the system.
- **`redactText` patterns** redact: standalone secret-shaped tokens (`sk-…`, `ghp_…`/`gho_…` etc., JWTs `eyJ….….…`, 40+ hex) AND `key=value`/`key: value` where `key` is secret-named. Imperfect-but-useful; documented as best-effort.
- **`BackendKind` extension:** add `'file'`. `BackendConfig` gains `FileConfig = { kind:'file'; path:string; format:'json'|'log'; maxLines?:number }`.
- **The backend resolves its source from the descriptor.** `FileBackend` is constructed with an injected `getDescriptor: (id) => DatasetDescriptor | undefined` (default `getDatasetRegistry().get`) so `get`/`query` read `config.path`/`config.format` per call — no path caching, no coupling to the route.
- **Tracked datasets are `system: true`, `syncMode: 'none'`, `visibility: 'cross-node-readable'`** (read-open to all authed callers via the gating ACL `[{principal:'*',actions:['read','query','search']}]`), NOT cloud-mutable (no write/delete/manage in the ACL since they're read-only anyway). `exportSince`/`importBatch` throw `SYNC_NOT_SUPPORTED`.
- **Additive only.** No edits to existing stores/routes/tools beyond registering the new backend + auto-registering the allow-list in `getDataService`. The existing `data_get`/`data_query` MCP tools + `/data/:dataset/records|query` routes already serve file datasets unchanged (read path is backend-agnostic) — no new route or tool is needed for M2c.
- Tests: `node:test` + `node:assert/strict`, compiled via `tsc -p core/tsconfig.test.json`. Hermetic: write temp files, construct `FileBackend` with an injected `getDescriptor` returning a descriptor that points at the temp file.

## File Structure

- **Modify** `core/src/data/types.ts` — add `'file'` to `BackendKind`; add `FileConfig` to `BackendConfig`.
- **Modify** `core/src/data/redaction.ts` — add `redactText(s)` + `scrubRecordContent(rec)` (+ internal `scrubValue`).
- **Create** `core/src/data/backends/file-backend.ts` — `FileBackend implements StorageBackend`.
- **Modify** `core/src/data/system-datasets.ts` — add `TRACKED_FILES` + `ensureTrackedFiles(registry)`.
- **Modify** `core/src/data/data-service.ts` — register `FileBackend`; call `ensureTrackedFiles`.
- **Create** tests: `core/src/__tests__/data/redact-text.test.ts`, `core/src/__tests__/data/file-backend.test.ts`, `core/src/__tests__/data/tracked-files.test.ts`.

**Base commit before Task 1:** the current branch HEAD (M2b tip `5e45d45`). Record it in the ledger.

---

### Task 1: `redactText` + `scrubRecordContent` + `FileConfig`/`BackendKind 'file'`

**Files:**
- Modify: `core/src/data/types.ts`
- Modify: `core/src/data/redaction.ts`
- Test: `core/src/__tests__/data/redact-text.test.ts`

**Interfaces:**
- Produces: `redactText(s: string): string`; `scrubRecordContent(rec: DataRecord): DataRecord`; `BackendKind` includes `'file'`; `FileConfig = { kind:'file'; path:string; format:'json'|'log'; maxLines?:number }`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/redact-text.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, scrubRecordContent, REDACTED } from '../../data/redaction';
import type { DataRecord } from '../../data/types';

test('redactText: redacts standalone secret-shaped tokens', () => {
  assert.match(redactText('key is sk-abcdefABCDEF0123456789 ok'), /«redacted»/);
  assert.match(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), /«redacted»/);
  assert.ok(!redactText('the quick brown fox jumps').includes(REDACTED)); // ordinary prose untouched
});

test('redactText: redacts secret-named key=value / key: value', () => {
  assert.match(redactText('Authorization: Bearer xyz123abc'), /Authorization.*«redacted»/i);
  assert.match(redactText('password=hunter2'), /password.*«redacted»/i);
  assert.match(redactText('api_key="AKIA1234567890"'), /api_key.*«redacted»/i);
  // the value is gone:
  assert.ok(!redactText('password=hunter2').includes('hunter2'));
});

test('scrubRecordContent: scrubs text + string field values + secret-named fields', () => {
  const rec: DataRecord = {
    id: 'r', version: 1,
    fields: { note: 'token=abc123secret', apiKey: 'sk-zzz', count: 5, nested: { password: 'p', label: 'ok' } },
    text: 'login with password=swordfish please',
    createdAt: 't', updatedAt: 't',
  };
  const out = scrubRecordContent(rec);
  assert.ok(!out.text!.includes('swordfish'));
  assert.equal(out.fields.apiKey, REDACTED);              // secret-named field
  assert.ok(!String(out.fields.note).includes('abc123secret')); // inline secret in a non-secret field
  assert.equal(out.fields.count, 5);                       // non-string untouched
  assert.equal((out.fields.nested as any).password, REDACTED); // nested secret-named
  assert.equal((out.fields.nested as any).label, 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/redact-text.test.js`
Expected: FAIL — `redactText`/`scrubRecordContent` not exported.

- [ ] **Step 3: Extend `types.ts`**

In `core/src/data/types.ts`:
1. `export type BackendKind = 'vector' | 'sql' | 'cache' | 'knowledge' | 'vectors' | 'file';`
2. Add config + extend the union:
```typescript
export interface FileConfig { kind: 'file'; path: string; format: 'json' | 'log'; maxLines?: number; }
```
```typescript
export type BackendConfig = CacheConfig | VectorConfig | SqlConfig | KnowledgeConfig | VectorsConfig | FileConfig;
```

- [ ] **Step 4: Add `redactText` + `scrubRecordContent` to `redaction.ts`**

In `core/src/data/redaction.ts` (reuse the existing `SECRET_KEY_RE` + `REDACTED`):

```typescript
// Inline secret-VALUE patterns — for scrubbing file CONTENT (logs/JSON), where secrets can appear
// in arbitrary text positions that key-name redaction (SECRET_KEY_RE) does not catch. Best-effort.
const SECRET_TOKEN_RE = /\b(sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|[A-Fa-f0-9]{40,})\b/g;
const SECRET_ASSIGN_RE = /\b(token|secret|password|passwd|api[-_]?key|apikey|authorization|bearer|credential|private[-_]?key|access[-_]?key|cookie)\b(["']?\s*[:=]\s*(?:bearer\s+)?["']?)([^\s"',}&]+)/gi;

/** Best-effort scrub of inline secrets in arbitrary text (log lines, string values). */
export function redactText(s: string): string {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(SECRET_ASSIGN_RE, (_m, k, sep) => `${k}${sep}${REDACTED}`)
    .replace(SECRET_TOKEN_RE, REDACTED);
}

/** Deep value scrub: secret-NAMED keys → REDACTED; every remaining string → redactText. */
function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : scrubValue(val);
    }
    return out;
  }
  return v;
}

/** Scrub a record's content (text + fields + metadata) for inline AND named secrets.
 *  Used by the file backend on read — tracked file content must never leak secrets. */
export function scrubRecordContent(rec: DataRecord): DataRecord {
  return {
    ...rec,
    fields: scrubValue(rec.fields) as Record<string, unknown>,
    text: rec.text ? redactText(rec.text) : rec.text,
    metadata: rec.metadata ? (scrubValue(rec.metadata) as Record<string, unknown>) : rec.metadata,
  };
}
```

> If `redaction.ts` lacks a top `import type { DataRecord }`, add it. `scrubRecordContent` returns the same shape it received.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/redact-text.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/src/data/types.ts core/src/data/redaction.ts core/src/__tests__/data/redact-text.test.ts
git commit -m "feat(data): redactText + scrubRecordContent (inline secret scrub) + FileConfig/BackendKind 'file'"
```

---

### Task 2: `FileBackend` — `'json'` format (get/query) + content scrub + NOT_SUPPORTED guards

**Files:**
- Create: `core/src/data/backends/file-backend.ts`
- Test: `core/src/__tests__/data/file-backend.test.ts`

**Interfaces:**
- Consumes: `scrubRecordContent` from `../redaction`, `isHardExcludedPath` from `../redaction`, `applyQuery` from `./query-filter`, `getDatasetRegistry` from `../dataset-registry`.
- Produces: `class FileBackend implements StorageBackend` (`kind='file'`), `constructor(getDescriptor?: (id: string) => DatasetDescriptor | undefined)`. Task 3 adds the `'log'` format branch.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/file-backend.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FileBackend } from '../../data/backends/file-backend';
import type { DatasetDescriptor } from '../../data/types';

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-file-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
function desc(id: string, p: string, format: 'json' | 'log', maxLines?: number): DatasetDescriptor {
  return { id, backend: 'file', ownerNode: 'n', visibility: 'cross-node-readable', readOnly: true, system: true,
    config: { kind: 'file', path: p, format, ...(maxLines ? { maxLines } : {}) }, acl: [], createdAt: 't', updatedAt: 't' };
}
function backend(d: DatasetDescriptor): FileBackend {
  return new FileBackend((id) => (id === d.id ? d : undefined));
}

test('file backend: json OBJECT store → one record per key, scrubbed', async () => {
  const p = tmpFile('store.json', JSON.stringify({ a: { name: 'alice', apiKey: 'sk-secret123456789012' }, b: { name: 'bob' } }));
  const d = desc('fs1', p, 'json');
  const be = backend(d);
  const got = await be.get('fs1', 'a');
  assert.equal(got?.fields.name, 'alice');
  assert.equal(got?.fields.apiKey, '«redacted»'); // secret-named field scrubbed on read
  const all = await be.query('fs1', {});
  assert.deepEqual(all.records.map((r) => r.id).sort(), ['a', 'b']);
});

test('file backend: json ARRAY → one record per index', async () => {
  const p = tmpFile('arr.json', JSON.stringify([{ id: 'x', v: 1 }, { v: 2 }]));
  const d = desc('fs2', p, 'json');
  const be = backend(d);
  const all = await be.query('fs2', {});
  assert.equal(all.records.length, 2);
  // an item with its own id uses it; otherwise the index
  assert.ok(all.records.some((r) => r.id === 'x'));
  assert.ok(all.records.some((r) => r.id === '1'));
});

test('file backend: missing file → empty (no throw on read)', async () => {
  const d = desc('fs3', '/no/such/file.json', 'json');
  const be = backend(d);
  assert.equal(await be.get('fs3', 'a'), null);
  assert.deepEqual((await be.query('fs3', {})).records, []);
});

test('file backend: mutate/admin/search are NOT_SUPPORTED; sync throws', async () => {
  const p = tmpFile('s.json', '{}');
  const be = backend(desc('fs4', p, 'json'));
  await assert.rejects(() => be.put('fs4', { id: 'a', version: 0, fields: {}, createdAt: 't', updatedAt: 't' }), /NOT_SUPPORTED/);
  await assert.rejects(() => be.delete('fs4', 'a'), /NOT_SUPPORTED/);
  await assert.rejects(() => be.exportSince('fs4'), /SYNC_NOT_SUPPORTED/);
});

test('file backend: createDataset refuses a hard-excluded credential path', async () => {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const d = desc('fsbad', credPath, 'json');
  const be = backend(d);
  await assert.rejects(() => be.createDataset(d), /excluded|forbidden/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/file-backend.test.js`
Expected: FAIL — `Cannot find module '.../file-backend'`.

- [ ] **Step 3: Create `core/src/data/backends/file-backend.ts` (json format + guards; log branch in Task 3)**

```typescript
// core/src/data/backends/file-backend.ts
// Read-only adapter exposing an allow-listed file's content as DataRecords. The owning script
// is the only writer (put/delete/admin/search are NOT_SUPPORTED); content is scrubbed for inline
// AND named secrets on read; credential paths are refused at registration. Never walks the FS —
// only the explicitly registered config.path is read.
import * as fs from 'fs';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, SearchSpec, NodeOrigin, FileConfig,
} from '../types';
import { applyQuery } from './query-filter';
import { scrubRecordContent, isHardExcludedPath } from '../redaction';
import { getDatasetRegistry } from '../dataset-registry';

export class FileBackend implements StorageBackend {
  readonly kind: BackendKind = 'file';
  private getDescriptor: (id: string) => DatasetDescriptor | undefined;

  constructor(getDescriptor?: (id: string) => DatasetDescriptor | undefined) {
    this.getDescriptor = getDescriptor || ((id) => getDatasetRegistry().get(id));
  }

  private cfg(dataset: string): FileConfig | null {
    const d = this.getDescriptor(dataset);
    if (!d || d.config.kind !== 'file') return null;
    return d.config as FileConfig;
  }

  /** Read + parse the file into scrubbed records. Returns [] if the file/config is missing. */
  private read(dataset: string): DataRecord[] {
    const c = this.cfg(dataset);
    if (!c || !fs.existsSync(c.path)) return [];
    let raw: string;
    try { raw = fs.readFileSync(c.path, 'utf8'); } catch { return []; }
    const now = '';
    let records: DataRecord[];
    if (c.format === 'log') {
      records = this.parseLog(raw, c.maxLines);
    } else {
      records = this.parseJson(raw);
    }
    return records.map(scrubRecordContent);
  }

  private parseJson(raw: string): DataRecord[] {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return []; }
    const mk = (id: string, value: unknown): DataRecord => ({
      id, version: 1,
      fields: (value && typeof value === 'object' && !Array.isArray(value)) ? (value as Record<string, unknown>) : { value },
      text: typeof value === 'string' ? value : undefined,
      createdAt: '', updatedAt: '',
    });
    if (Array.isArray(data)) {
      return data.map((item, i) => mk(String((item && typeof item === 'object' && 'id' in (item as any)) ? (item as any).id : i), item));
    }
    if (data && typeof data === 'object') {
      return Object.entries(data as Record<string, unknown>).map(([k, v]) => mk(k, v));
    }
    return [mk('0', data)];
  }

  // parseLog is implemented in Task 3.
  protected parseLog(_raw: string, _maxLines?: number): DataRecord[] { return []; }

  async createDataset(d: DatasetDescriptor): Promise<void> {
    const c = d.config as FileConfig;
    if (c.kind !== 'file') throw new Error('FileBackend.createDataset: not a file dataset');
    if (isHardExcludedPath(c.path)) throw new Error(`refused: "${c.path}" is an excluded credential path`);
    // existence is NOT required at registration (a log may not exist yet) — reads tolerate absence.
  }
  async dropDataset(_id: string): Promise<void> { /* nothing to delete — the file is owned by its script */ }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    return this.read(dataset).find((r) => r.id === id) ?? null;
  }
  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    return applyQuery(this.read(dataset), q);
  }

  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> {
    throw new Error('NOT_SUPPORTED: tracked file datasets are read-only (the owning script is the writer)');
  }
  async delete(_dataset: string, _id: string): Promise<boolean> {
    throw new Error('NOT_SUPPORTED: tracked file datasets are read-only');
  }
  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: tracked file datasets are local read-only');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: tracked file datasets are local read-only');
  }
}
```

> NOTE: `search` is intentionally NOT defined (it is optional on `StorageBackend`; a file dataset has no semantic search). `DataService.search` already returns `NOT_SUPPORTED` when `backend.search` is absent. The `parseLog` stub is replaced in Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/file-backend.test.js`
Expected: PASS — json object/array reads + scrub, missing-file empty, NOT_SUPPORTED guards, hard-exclusion refusal.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/file-backend.ts core/src/__tests__/data/file-backend.test.ts
git commit -m "feat(data): FileBackend — read-only json file tracking (get/query, content scrub, NOT_SUPPORTED guards, hard-exclusion)"
```

---

### Task 3: `FileBackend` — `'log'` format (tail + inline-secret scrub)

**Files:**
- Modify: `core/src/data/backends/file-backend.ts` (replace the `parseLog` stub)
- Test: `core/src/__tests__/data/file-backend.test.ts` (append)

**Interfaces:**
- Produces: working `parseLog(raw, maxLines)` → one record per line `{ id: lineNumber, text: <line> }`, tailing the last `maxLines` (default 500).

- [ ] **Step 1: Write the failing test** (append)

```typescript
test('file backend: log format → one record per line, tailed, with inline secrets scrubbed', async () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`line ${i}`);
  lines.push('oops authorization: Bearer leaktoken9999');
  const p = tmpFile('app.log', lines.join('\n') + '\n');
  const d = desc('lg1', p, 'log', 5); // tail last 5
  const be = backend(d);
  const all = await be.query('lg1', {});
  assert.equal(all.records.length, 5);                  // tailed to maxLines
  assert.ok(all.records.every((r) => typeof r.text === 'string'));
  const leak = all.records.find((r) => /authorization/i.test(String(r.text)));
  assert.ok(leak);
  assert.ok(!String(leak!.text).includes('leaktoken9999')); // inline secret scrubbed
});

test('file backend: log get by line id', async () => {
  const p = tmpFile('b.log', 'alpha\nbeta\ngamma\n');
  const be = backend(desc('lg2', p, 'log'));
  const all = await be.query('lg2', {});
  const first = all.records[0];
  const got = await be.get('lg2', first.id);
  assert.equal(got?.text, first.text);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/file-backend.test.js`
Expected: FAIL — log records empty (`parseLog` stub returns `[]`).

- [ ] **Step 3: Implement `parseLog`**

Replace the `parseLog` stub in `file-backend.ts`:

```typescript
  protected parseLog(raw: string, maxLines?: number): DataRecord[] {
    const limit = maxLines && maxLines > 0 ? maxLines : 500;
    const allLines = raw.split('\n');
    // drop a trailing empty element from a final newline
    if (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();
    const start = Math.max(0, allLines.length - limit);
    const tail = allLines.slice(start);
    return tail.map((line, i) => ({
      id: String(start + i),         // stable line number across the file
      version: 1,
      fields: { line: start + i },
      text: line,                    // scrubRecordContent (applied in read()) runs redactText on this
      createdAt: '', updatedAt: '',
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/file-backend.test.js`
Expected: PASS — log tail + per-line records + inline-secret scrub + get-by-line-id.

- [ ] **Step 5: Commit**

```bash
git add core/src/data/backends/file-backend.ts core/src/__tests__/data/file-backend.test.ts
git commit -m "feat(data): FileBackend log format — tailed per-line records with inline-secret scrub"
```

---

### Task 4: Auto-register the tracked-file allow-list + wire `FileBackend` into `getDataService`

**Files:**
- Modify: `core/src/data/system-datasets.ts` (add `TRACKED_FILES` + `ensureTrackedFiles`)
- Modify: `core/src/data/data-service.ts` (register `FileBackend`; call `ensureTrackedFiles`)
- Test: `core/src/__tests__/data/tracked-files.test.ts`

**Interfaces:**
- Consumes: `DatasetRegistry`, `isHardExcludedPath`.
- Produces: `TRACKED_FILES: Array<{ id; resolvePath: () => string; format: 'json'|'log'; title; maxLines? }>` + `ensureTrackedFiles(registry: DatasetRegistry): void`. `getDataService()` registers `new FileBackend()` and calls `ensureTrackedFiles(datasets)`.

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/data/tracked-files.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ensureTrackedFiles, TRACKED_FILES } from '../../data/system-datasets';
import { DatasetRegistry } from '../../data/dataset-registry';

function reg() { return new DatasetRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-trk-')), 'd.json')); }

test('tracked files: only registers allow-listed paths that EXIST, as readOnly file datasets, idempotently', () => {
  const r = reg();
  ensureTrackedFiles(r);
  ensureTrackedFiles(r); // idempotent
  for (const d of r.list()) {
    assert.equal(d.backend, 'file');
    assert.equal(d.readOnly, true);
    assert.equal(d.system, true);
    assert.equal(d.syncMode, 'none');
    assert.equal((d.config as any).kind, 'file');
    assert.ok(fs.existsSync((d.config as any).path), `registered a non-existent path: ${(d.config as any).path}`);
  }
  // the allow-list itself must be non-empty and well-formed
  assert.ok(TRACKED_FILES.length >= 1);
  for (const t of TRACKED_FILES) {
    assert.equal(typeof t.resolvePath(), 'string');
    assert.ok(t.format === 'json' || t.format === 'log');
  }
});

test('tracked files: never registers a hard-excluded path even if listed + existing', () => {
  const r = reg();
  // simulate by checking the guard directly: a credentials path must be skipped
  const { isHardExcludedPath } = require('../../data/redaction');
  assert.equal(isHardExcludedPath(path.join(os.homedir(), '.claude', '.credentials.json')), true);
  // ensureTrackedFiles applies the same guard — no registered dataset may point at an excluded path
  ensureTrackedFiles(r);
  for (const d of r.list()) assert.equal(isHardExcludedPath((d.config as any).path), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/tracked-files.test.js`
Expected: FAIL — `ensureTrackedFiles`/`TRACKED_FILES` not exported.

- [ ] **Step 3: Add `TRACKED_FILES` + `ensureTrackedFiles` to `system-datasets.ts`**

Add to `core/src/data/system-datasets.ts` (keep the existing `ensureSystemDatasets`):

```typescript
import * as os from 'os';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import { isHardExcludedPath } from './redaction';

const CACHE_DIR = () => path.join(os.homedir(), '.cache', 'lm-assist');
const LOGS_DIR = () => path.join(getDataDir(), 'logs');

/** Curated allow-list of known lm-assist artifacts exposed read-only. Only those that EXIST
 *  (and are not credential paths) are registered. Resolver fns keep paths lazy/portable. */
export const TRACKED_FILES: Array<{ id: string; resolvePath: () => string; format: 'json' | 'log'; title: string; maxLines?: number }> = [
  { id: 'log-context-inject', resolvePath: () => path.join(LOGS_DIR(), 'context-inject-hook.log'), format: 'log', title: 'Context-inject hook log', maxLines: 1000 },
  { id: 'log-mcp-calls', resolvePath: () => path.join(LOGS_DIR(), 'mcp-calls.jsonl'), format: 'log', title: 'MCP call log', maxLines: 1000 },
  { id: 'log-upgrade', resolvePath: () => path.join(CACHE_DIR(), 'upgrade.log'), format: 'log', title: 'Upgrade log', maxLines: 500 },
  { id: 'json-learning-signals', resolvePath: () => path.join(CACHE_DIR(), 'learning-signals.json'), format: 'json', title: 'Learning signals (script-owned)' },
  { id: 'json-project-summaries', resolvePath: () => path.join(CACHE_DIR(), 'project-summaries.json'), format: 'json', title: 'Project summaries (script-owned)' },
  { id: 'json-prompt-queue', resolvePath: () => path.join(CACHE_DIR(), 'prompt-queue.json'), format: 'json', title: 'Prompt queue (script-owned)' },
];

const TRACKED_ACL: AclRule[] = [{ principal: '*', actions: ['read', 'query', 'search'] }];

/** Idempotently register the allow-listed tracked files that exist and are not credential paths. */
export function ensureTrackedFiles(registry: DatasetRegistry): void {
  for (const t of TRACKED_FILES) {
    if (registry.get(t.id)) continue;
    let p: string;
    try { p = t.resolvePath(); } catch { continue; }
    if (!p || isHardExcludedPath(p)) continue;     // never expose a credential path
    if (!fs.existsSync(p)) continue;               // allow-list only what actually exists
    registry.create({
      id: t.id, backend: 'file', title: t.title,
      visibility: 'cross-node-readable', system: true, readOnly: true,
      config: { kind: 'file', path: p, format: t.format, ...(t.maxLines ? { maxLines: t.maxLines } : {}) },
      acl: TRACKED_ACL.map((a) => ({ ...a, actions: [...a.actions] })),
      syncMode: 'none',
    });
  }
}
```

> Add `import * as fs from 'fs';` at the top of `system-datasets.ts` if not present. `AclRule`/`DatasetRegistry` are already imported by the existing `ensureSystemDatasets`.

- [ ] **Step 4: Wire into `getDataService()`**

In `core/src/data/data-service.ts` `getDataService()`:
1. Add the import:
```typescript
import { FileBackend } from './backends/file-backend';
import { ensureSystemDatasets, ensureTrackedFiles } from './system-datasets';
```
(merge `ensureTrackedFiles` into the existing `system-datasets` import.)
2. Register the backend after the others:
```typescript
    backends.register(new FileBackend());
```
3. After the existing `ensureSystemDatasets(datasets);` call, add:
```typescript
    ensureTrackedFiles(datasets);
```

- [ ] **Step 5: Run tests + the full data suite + production build**

Run: `cd /home/ubuntu/lm-assist/core && npx tsc -p tsconfig.test.json && node --test dist-test/__tests__/data/`
Expected: PASS — tracked-files tests + all prior data tests green (the singleton now also registers `FileBackend` + auto-registers any existing tracked files; existing tests are unaffected — they assert on their own dataset ids, not the full catalog).
Then: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: tsc clean.

- [ ] **Step 6: Commit**

```bash
git add core/src/data/system-datasets.ts core/src/data/data-service.ts core/src/__tests__/data/tracked-files.test.ts
git commit -m "feat(data): auto-register tracked-file allow-list (logs + script JSON, existence+exclusion guarded); wire FileBackend"
```

---

## Post-Plan: Controller Verification (folded into the combined M2 deploy + e2e)

After all 4 tasks pass review, the controller verifies live (dev `:3200`):
1. `./core.sh restart`; `GET /data/catalog` lists the tracked-file datasets that exist on this box (e.g. `log-mcp-calls`, `json-learning-signals`) as `readOnly` `file` datasets.
2. `POST /data/log-mcp-calls/query {limit:20}` → recent log lines; confirm any secret-shaped content is `«redacted»`.
3. `GET /data/json-learning-signals/records/:id` → a script-JSON entry (redacted).
4. Confirm a write is refused: `PUT /data/log-mcp-calls/records` → `NOT_SUPPORTED`/read-only.
5. Confirm a credential path can never be registered (the hard-exclusion guard).

This is the final piece of M2; the combined deploy to 117/123/107 + full multi-node/multi-platform e2e (vector search, system-dataset admin, file tracking, cross-node vector sync) follows once M2c review is clean.
