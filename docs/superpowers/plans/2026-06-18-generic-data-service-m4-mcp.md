# Generic Data Service — M4 (MCP Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose the M1 data service over MCP (stdio **and** the hub `/mcp` surface) as 6 `data_*` tools, with the originating principal (local vs cloud) correctly propagated so a hub-relayed (cloud) caller can never be silently escalated to local root.

**Architecture:** A new `AsyncLocalStorage`-based `principal-context` carries the resolved `Principal` from each MCP entry point through the SDK dispatch (which strips HTTP context) into the tool handlers. `data_*` handlers read that principal and call the in-process `DataService` facade directly (no principal-losing loopback hop), so MCP calls get the exact same enforcement as REST `/data` calls. Tools are registered via the existing expanded-tools machinery so they appear on both MCP surfaces.

**Tech Stack:** TypeScript (CommonJS), Node built-in `async_hooks` (AsyncLocalStorage), existing MCP machinery. **No new dependencies.** Builds on the committed M1 (`core/src/data/`).

## Global Constraints

- CommonJS (`core/tsconfig.json`). Only CJS/built-in imports. No new npm deps (`async_hooks` is built-in).
- Do **not** change the existing MCP tools (search/detail/feedback/expanded) or the `McpToolResult` shape. `data_*` handlers must follow the existing expanded-handler shape `(args) => Promise<McpToolResult>` and read principal context out-of-band (ALS), NOT by changing the shared handler signature.
- Security invariant (the reason for this milestone): a `data_*` tool invoked via the hub `/mcp` path MUST resolve to a `cloud` principal; via the local stdio `/mcp-call` path MUST resolve to `local`. Never default a hub call to local. Enforcement still lives in `DataService`/`AccessManager` (M1) — do not re-implement it here.
- Principal resolution reuses `DataService.resolvePrincipal(req)` (M1) — do not duplicate the loopback/relay logic.
- Tools live behind `TOOL_SCOPES` (read/write). `data_*` handlers must check `DataService.isEnabled()` (kill-switch) exactly like the REST routes do.
- Tests: `node:test` + `node:assert/strict`, under `core/src/__tests__/data/`, hermetic via `process.env.LM_ASSIST_DATA_DIR` set to a temp dir before importing data-service.
- Build/test commands as in M1: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/<file>.test.js`.

---

## File Structure

**Create:**
- `core/src/mcp-server/principal-context.ts` — ALS carrying `{ principal: Principal }` across the dispatch.
- `core/src/mcp-server/tools/data-tools.ts` — 6 `data_*` tool defs + handlers (in-process `DataService` calls).
- `core/src/__tests__/data/data-tools.test.ts` — handler tests under both principals.
- `core/src/__tests__/data/mcp-principal-wiring.test.ts` — entry-point wiring test (stdio `/mcp-call` route).

**Modify:**
- `core/src/mcp-server/tools/expanded.ts` — spread `DATA_TOOL_DEFS` into `EXPANDED_TOOL_DEFS`, `DATA_HANDLERS` into `EXPANDED_HANDLERS`.
- `core/src/mcp-server/configure.ts` — add the 6 `data_*` entries to `TOOL_SCOPES`.
- `core/src/routes/core/mcp-api.routes.ts` — in `POST /mcp-call`, resolve principal from `req` and run the handler inside the ALS context.
- `core/src/routes/core/mcp.routes.ts` — in `handleMcpRequest`, resolve principal from the incoming `req` headers/socket and run `transport.handleRequest(...)` inside the ALS context.

---

## Task 1: Principal-context (AsyncLocalStorage)

**Files:**
- Create: `core/src/mcp-server/principal-context.ts`
- Test: `core/src/__tests__/data/mcp-principal-context.test.ts`

**Interfaces:**
- Produces: `interface McpCallContext { principal: Principal }`, `runWithMcpContext<T>(ctx: McpCallContext, fn: () => T): T`, `currentMcpContext(): McpCallContext | undefined`.

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/mcp-principal-context.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithMcpContext, currentMcpContext } from '../../mcp-server/principal-context';

test('mcp context: carries principal within run, undefined outside', () => {
  assert.equal(currentMcpContext(), undefined);
  const out = runWithMcpContext({ principal: { type: 'cloud', userId: 'u1' } }, () => {
    const c = currentMcpContext();
    return c?.principal;
  });
  assert.deepEqual(out, { type: 'cloud', userId: 'u1' });
  assert.equal(currentMcpContext(), undefined); // restored after run
});

test('mcp context: nested runs isolate', async () => {
  await runWithMcpContext({ principal: { type: 'local' } }, async () => {
    assert.equal(currentMcpContext()?.principal.type, 'local');
    await runWithMcpContext({ principal: { type: 'cloud', userId: 'x' } }, async () => {
      assert.equal(currentMcpContext()?.principal.type, 'cloud');
    });
    assert.equal(currentMcpContext()?.principal.type, 'local'); // inner did not leak
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../mcp-server/principal-context'`).

- [ ] **Step 3: Write `core/src/mcp-server/principal-context.ts`**

```typescript
// core/src/mcp-server/principal-context.ts
// Carries the MCP caller's resolved principal across the MCP SDK dispatch, which
// otherwise strips all HTTP request context. Set at each MCP entry point; read by
// principal-gated tool handlers (data_*).
import { AsyncLocalStorage } from 'async_hooks';
import type { Principal } from '../data/types';

export interface McpCallContext {
  principal: Principal;
}

const storage = new AsyncLocalStorage<McpCallContext>();

export function runWithMcpContext<T>(ctx: McpCallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentMcpContext(): McpCallContext | undefined {
  return storage.getStore();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/mcp-principal-context.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/principal-context.ts core/src/__tests__/data/mcp-principal-context.test.ts
git commit -m "feat(data): MCP principal-context (AsyncLocalStorage) for tool dispatch"
```

---

## Task 2: The 6 `data_*` tools (defs + in-process handlers) + registration

**Files:**
- Create: `core/src/mcp-server/tools/data-tools.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts`
- Modify: `core/src/mcp-server/configure.ts`
- Test: `core/src/__tests__/data/data-tools.test.ts`

**Interfaces:**
- Consumes: `getDataService`, `CallCtx` from `../../data/data-service`; `currentMcpContext` from `../principal-context`; `ok`, `err` from `./_passthrough`; types from `../../data/types`.
- Produces: `DATA_TOOL_DEFS` (array of 6 tool defs) and `DATA_HANDLERS` (`Record<string, (args) => Promise<McpToolResult>>`).

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/data-tools.test.ts`

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-datatools-'));
import { DATA_HANDLERS, DATA_TOOL_DEFS } from '../../mcp-server/tools/data-tools';
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';
import { getDatasetRegistry } from '../../data/dataset-registry';

function enable() { (getDataService() as any).enabledOverride = true; }
function textOf(r: any): string { return r.content.map((c: any) => c.text).join('\n'); }

test('data tools: the 6 expected tools are defined and mapped', () => {
  const names = DATA_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['data_catalog', 'data_delete', 'data_get', 'data_put', 'data_query', 'data_request_access']);
  for (const n of names) assert.equal(typeof DATA_HANDLERS[n], 'function');
});

test('data tools: local principal can put + get (redacted), cloud without key denied', async () => {
  enable();
  const id = `dt_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });

  // local put
  const put = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_put({ dataset: id, record: { id: 'a', fields: { title: 't', apiKey: 'sk-x' } } }));
  assert.equal(put.isError ?? false, false);

  // local get -> redacted
  const got = await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a' }));
  assert.match(textOf(got), /"title": "t"/);
  assert.match(textOf(got), /«redacted»/);

  // cloud without key -> denied
  const denied = await runWithMcpContext({ principal: { type: 'cloud', userId: 'u' } }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a' }));
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /KEY_REQUIRED/);
});

test('data tools: cloud request_access then get with key', async () => {
  enable();
  const id = `dt2_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  await runWithMcpContext({ principal: { type: 'local' } }, () =>
    DATA_HANDLERS.data_put({ dataset: id, record: { id: 'a', fields: { n: 1 } } }));

  const cloud = { type: 'cloud' as const, userId: 'u1' };
  const acc = await runWithMcpContext({ principal: cloud }, () =>
    DATA_HANDLERS.data_request_access({ intent: 'read', grants: [{ dataset: id, actions: ['read'] }] }));
  const key = JSON.parse(textOf(acc)).key as string;
  assert.equal(typeof key, 'string');

  const got = await runWithMcpContext({ principal: cloud }, () =>
    DATA_HANDLERS.data_get({ dataset: id, id: 'a', key }));
  assert.equal(got.isError ?? false, false);
  assert.match(textOf(got), /"n": 1/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test`
Expected: build FAILS (`Cannot find module '../../mcp-server/tools/data-tools'`).

- [ ] **Step 3: Write `core/src/mcp-server/tools/data-tools.ts`**

```typescript
// core/src/mcp-server/tools/data-tools.ts
// MCP tools for the generic data service. Handlers resolve the caller's principal from the
// MCP call context (set at the entry point) and call the in-process DataService directly, so
// a hub-relayed (cloud) call is enforced as cloud — never silently escalated to local root.
import type { McpToolResult } from '../configure';
import { ok, err } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { getDataService, type CallCtx } from '../../data/data-service';
import type { DataRecord, QuerySpec, AccessRequest } from '../../data/types';

function ctxFromArgs(args: Record<string, unknown>): CallCtx | { error: string } {
  const c = currentMcpContext();
  if (!c) return { error: 'no MCP principal context (tool invoked outside an MCP entry point)' };
  const keyHeader = typeof args.key === 'string' ? (args.key as string) : undefined;
  return { principal: c.principal, keyHeader };
}

function pretty(v: unknown): string { return JSON.stringify(v, null, 2); }

async function handleDataCatalog(_args: Record<string, unknown>): Promise<McpToolResult> {
  const c = currentMcpContext();
  if (!c) return err('no MCP principal context');
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  return ok(pretty({ datasets: svc.catalog(c.principal) }));
}

async function handleDataRequestAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const c = currentMcpContext();
  if (!c) return err('no MCP principal context');
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const req: AccessRequest = {
    intent: typeof args.intent === 'string' ? args.intent : undefined,
    grants: Array.isArray(args.grants) ? (args.grants as AccessRequest['grants']) : [],
    ttlSeconds: typeof args.ttlSeconds === 'number' ? args.ttlSeconds : undefined,
  };
  const res = await svc.requestAccess(c.principal, req);
  if (!res.ok) return err(res.reason);
  return ok(pretty({ key: res.key, keyId: res.keyId, grants: res.grants, expiresAt: res.expiresAt }));
}

async function handleDataGet(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  const id = String(args.id || '');
  if (!dataset || !id) return err('dataset and id are required');
  const r = await svc.get(ctx, dataset, id);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  if (!dataset) return err('dataset is required');
  const q = (args.query && typeof args.query === 'object' ? args.query : {}) as QuerySpec;
  const r = await svc.query(ctx, dataset, q);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataPut(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  const rec = (args.record && typeof args.record === 'object' ? args.record : {}) as Partial<DataRecord>;
  if (!dataset || !rec.id) return err('dataset and record.id are required');
  const now = new Date().toISOString();
  const record: DataRecord = {
    id: String(rec.id),
    fields: (rec.fields && typeof rec.fields === 'object' ? rec.fields : {}) as Record<string, unknown>,
    text: typeof rec.text === 'string' ? rec.text : undefined,
    metadata: (rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : undefined) as Record<string, unknown> | undefined,
    createdAt: now, updatedAt: now,
  };
  const r = await svc.put(ctx, dataset, record);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataDelete(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  const id = String(args.id || '');
  if (!dataset || !id) return err('dataset and id are required');
  const r = await svc.del(ctx, dataset, id);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty({ deleted: r.value }));
}

const STR = (description: string) => ({ type: 'string' as const, description });

export const DATA_TOOL_DEFS = [
  {
    name: 'data_catalog',
    description: 'List the generic data-service datasets the caller may use, with each dataset\'s backend, visibility, and the actions the caller is allowed. Use before data_request_access to discover what exists.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'data_request_access',
    description: 'Request a scoped, expiring access key for one or more datasets/actions. Returns a key string to pass as `key` to data_get/data_query/data_put/data_delete. Local callers have implicit root access and do not need a key; cloud callers must request one.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        intent: STR('What you want to do (free text, audited).'),
        grants: { type: 'array' as const, description: 'Array of { dataset, actions[] } you are requesting.', items: { type: 'object' as const } },
        ttlSeconds: { type: 'number' as const, description: 'Requested key lifetime in seconds (clamped 60..86400, default 3600).' },
      },
      required: ['grants'],
    },
  },
  {
    name: 'data_get',
    description: 'Read one record by id from a data-service dataset. Returns the record (secret-named fields are redacted). Pass `key` if you obtained one from data_request_access.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), id: STR('Record id.'), key: STR('Access key from data_request_access (omit if local).') }, required: ['dataset', 'id'] },
  },
  {
    name: 'data_query',
    description: 'Query records in a data-service dataset with filter/sort/limit. Returns matching records (redacted). Pass `key` if you have one.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), query: { type: 'object' as const, description: 'QuerySpec: { filter?, fts?, sort?, limit?, offset? }.' }, key: STR('Access key (omit if local).') }, required: ['dataset'] },
  },
  {
    name: 'data_put',
    description: 'Write (upsert) a record into a data-service dataset. `record` is { id, fields, text?, metadata? }. Requires the write action (a key granting write, or local). ',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), record: { type: 'object' as const, description: 'Record: { id, fields, text?, metadata? }.' }, key: STR('Access key granting write (omit if local).') }, required: ['dataset', 'record'] },
  },
  {
    name: 'data_delete',
    description: 'Delete a record by id from a data-service dataset. Requires the delete action (a key granting delete, or local).',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), id: STR('Record id.'), key: STR('Access key granting delete (omit if local).') }, required: ['dataset', 'id'] },
  },
] as const;

export const DATA_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  data_catalog: handleDataCatalog,
  data_request_access: handleDataRequestAccess,
  data_get: handleDataGet,
  data_query: handleDataQuery,
  data_put: handleDataPut,
  data_delete: handleDataDelete,
};
```

- [ ] **Step 4: Register in `core/src/mcp-server/tools/expanded.ts`**

Add the import near the top:
```typescript
import { DATA_TOOL_DEFS, DATA_HANDLERS } from './data-tools';
```
Spread `DATA_TOOL_DEFS` into the `EXPANDED_TOOL_DEFS` array (alongside the other defs):
```typescript
export const EXPANDED_TOOL_DEFS = [
  // ...existing defs...
  ...DATA_TOOL_DEFS,
] as const;
```
Spread `DATA_HANDLERS` into the `EXPANDED_HANDLERS` map (add at the end of the object literal):
```typescript
export const EXPANDED_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  // ...existing handlers...
  ...DATA_HANDLERS,
};
```
(Read the file first; match the exact existing array/object literal forms. If `EXPANDED_TOOL_DEFS` is declared `as const` with explicit members, append `...DATA_TOOL_DEFS` before the closing `]`.)

- [ ] **Step 5: Add scopes in `core/src/mcp-server/configure.ts`**

In the `TOOL_SCOPES` object, add:
```typescript
  data_catalog: 'read',
  data_request_access: 'read',
  data_get: 'read',
  data_query: 'read',
  data_put: 'write',
  data_delete: 'write',
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/data-tools.test.js`
Expected: PASS (3 tests). Also `cd core && npm run build` clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/mcp-server/tools/data-tools.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/data/data-tools.test.ts
git commit -m "feat(data): 6 data_* MCP tools (in-process DataService, principal from context)"
```

---

## Task 3: Wire principal resolution at both MCP entry points

**Files:**
- Modify: `core/src/routes/core/mcp-api.routes.ts` (`POST /mcp-call`)
- Modify: `core/src/routes/core/mcp.routes.ts` (`handleMcpRequest`)
- Test: `core/src/__tests__/data/mcp-principal-wiring.test.ts`

**Interfaces:**
- Consumes: `getDataService().resolvePrincipal(req)` (M1), `runWithMcpContext` (Task 1), `EXPANDED_HANDLERS` (Task 2).

- [ ] **Step 1: Write the failing test** `core/src/__tests__/data/mcp-principal-wiring.test.ts`

This drives the real `POST /mcp-call` route handler (the stdio path) with and without the relay header, and asserts the `data_*` handler saw the correct principal (cloud-without-key is denied; local succeeds).

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-mcpwire-'));
import { createMcpApiRoutes } from '../../routes/core/mcp-api.routes';
import { getDataService } from '../../data/data-service';
import { getDatasetRegistry } from '../../data/dataset-registry';
import type { ParsedRequest } from '../../routes/index';

function enable() { (getDataService() as any).enabledOverride = true; }
function mcpCallRoute() {
  const routes = createMcpApiRoutes({} as any);
  const r = routes.find((x) => x.method === 'POST' && '/mcp-call'.match(x.pattern));
  if (!r) throw new Error('no /mcp-call route');
  return r.handler;
}
function call(tool: string, args: any, headers: Record<string, string>, clientIp = '127.0.0.1') {
  const req: ParsedRequest = { method: 'POST', path: '/mcp-call', params: {}, query: {}, body: { tool, args }, headers, clientIp };
  return mcpCallRoute()(req, {} as any);
}
function textOf(env: any): string {
  const r = env.data; return r.content.map((c: any) => c.text).join('\n');
}

test('mcp-call: local (loopback, no relay header) -> data_put succeeds', async () => {
  enable();
  const id = `wire_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'local-only', config: { kind: 'cache' }, acl: [] });
  const env = await call('data_put', { dataset: id, record: { id: 'a', fields: { n: 1 } } }, {});
  assert.equal(env.success, true);
  assert.equal(env.data.isError ?? false, false);
});

test('mcp-call: cloud (x-relay-source:hub) without key -> denied', async () => {
  enable();
  const id = `wire2_${Date.now()}`;
  getDatasetRegistry().create({ id, backend: 'cache', visibility: 'cross-node-readable',
    config: { kind: 'cache' }, acl: [{ principal: 'cloud', actions: ['read'] }] });
  const env = await call('data_get', { dataset: id, id: 'a' }, { 'x-relay-source': 'hub' });
  assert.equal(env.success, true);          // the route call itself succeeds
  assert.equal(env.data.isError, true);     // but the tool result is an error (denied)
  assert.match(textOf(env), /KEY_REQUIRED/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/mcp-principal-wiring.test.js`
Expected: FAIL — the cloud case currently resolves to local (no wiring yet), so `data_get` would NOT be denied (it'd succeed/return null), failing the `isError`/`KEY_REQUIRED` assertions.

- [ ] **Step 3: Wire `POST /mcp-call`** in `core/src/routes/core/mcp-api.routes.ts`

Read the `/mcp-call` handler. Add the imports at the top of the file:
```typescript
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';
```
Change the handler body so the principal is resolved from the incoming request and the tool runs inside the ALS context:
```typescript
  handler: async (req) => {
    const start = Date.now();
    try {
      const body = (req.body || {}) as { tool?: string; args?: Record<string, unknown> };
      const tool = String(body.tool || '');
      const handler = EXPANDED_HANDLERS[tool];
      if (!handler) {
        return wrapError('MCP_UNKNOWN_TOOL', `Unknown expanded tool: ${tool}`, start);
      }
      const principal = getDataService().resolvePrincipal(req);
      const result = await runWithMcpContext({ principal }, () => handler(body.args || {}));
      return wrapResponse(result, start);
    } catch (err) {
      return wrapError('MCP_CALL_ERROR', err instanceof Error ? err.message : String(err), start);
    }
  },
```

- [ ] **Step 4: Wire `handleMcpRequest`** in `core/src/routes/core/mcp.routes.ts`

Read `handleMcpRequest`. Add imports at the top:
```typescript
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';
import type { ParsedRequest } from '../index';
```
Resolve the principal from the incoming `IncomingMessage` and wrap the transport dispatch. Replace the `await transport.handleRequest(req, res, body);` call with an ALS-wrapped version:
```typescript
    // Resolve the caller's principal from the ORIGINATING request (the SDK strips this),
    // so principal-gated tools (data_*) enforce cloud-vs-local correctly.
    const synthReq = {
      method: req.method || 'POST', path: '/mcp', params: {}, query: {}, body: undefined,
      headers: req.headers as ParsedRequest['headers'],
      clientIp: req.socket?.remoteAddress || undefined,
    } as ParsedRequest;
    const principal = getDataService().resolvePrincipal(synthReq);
    await runWithMcpContext({ principal }, () => transport.handleRequest(req, res, body));
```
(Only that one call is wrapped; everything else in `handleMcpRequest` is unchanged. If `server.connect(transport)` must precede `handleRequest`, keep that ordering — wrap only `transport.handleRequest`.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd core && npm run build && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/data/mcp-principal-wiring.test.js`
Expected: full tsc clean; PASS (2 tests). The cloud-without-key case is now denied because the `/mcp-call` handler resolves cloud from `x-relay-source: hub` and runs the tool in that context.

- [ ] **Step 6: Commit**

```bash
git add core/src/routes/core/mcp-api.routes.ts core/src/routes/core/mcp.routes.ts core/src/__tests__/data/mcp-principal-wiring.test.ts
git commit -m "feat(data): resolve MCP principal at both entry points; thread via ALS to data tools"
```

---

## Task 4: Verify on the live dev hub (`/mcp` end-to-end)

**Files:** none — manual verification that the tools appear and enforce over the real `/mcp` HTTP surface.

- [ ] **Step 1: Build + restart dev, enable the data service**

Run: `./core.sh build && ./core.sh restart`, then set `dataServiceEnabled: true` in `~/.lm-assist/project-settings.json` (merge-preserving), as in M1's smoke test.

- [ ] **Step 2: Confirm the tools are listed on `/mcp`**

Run (loopback `tools/list` — resolves to local, all tools visible):
```bash
TOKEN=$(cat ~/.lm-assist/api-token)
curl -s -H "x-api-key: $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://localhost:3200/mcp | grep -o 'data_[a-z_]*' | sort -u
```
Expected: `data_catalog data_delete data_get data_put data_query data_request_access`.

- [ ] **Step 3: Confirm a cloud-simulated `/mcp` call enforces**

Run a `tools/call` for `data_get` with the relay header set, and confirm it does NOT return local-root data (it should be denied without a key):
```bash
curl -s -H "x-api-key: $TOKEN" -H 'x-relay-source: hub' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"data_get","arguments":{"dataset":"smoke","id":"r1"}}}' \
  http://localhost:3200/mcp
```
Expected: the tool result text contains `KEY_REQUIRED` (cloud principal, no key) — proving principal propagation through the real SDK dispatch. Then revert `dataServiceEnabled` and clean up as in M1.

---

## Self-Review

**Spec coverage (M4):** 6 of the 7 spec §10 tools are implemented (`data_search` + `data_admin` correctly deferred to M2 when the vector backend + system datasets exist — noted). Tools appear on stdio (via `/mcp-call`) and hub `/mcp` (verified Task 4). Principal propagation closes the escalation (Task 3 test asserts cloud-without-key is denied).

**Placeholder scan:** none — every step has complete code + exact commands.

**Type consistency:** `DATA_HANDLERS` matches the `EXPANDED_HANDLERS` value type `(args) => Promise<McpToolResult>`. `CallCtx { principal, keyHeader? }`, `DataService` method names, and `requestAccess`→`DataResult` (`res.ok`/`res.value`/`res.reason`) match the committed M1 code. `runWithMcpContext`/`currentMcpContext`/`McpCallContext` are consistent across Tasks 1–3. `resolvePrincipal(req: ParsedRequest)` is the M1 facade method.

**Security:** the only new trust-bearing logic is principal resolution at the two entry points — both reuse the M1 `resolvePrincipal` (relay-header + loopback gate), so a hub call is cloud and a stdio loopback call is local. Handlers never bypass `DataService` enforcement or the kill-switch.

**Known M4 limitation (documented):** the auto-injected `node` param is accepted in tool schemas but NOT yet acted on — `data_*` operate on the local node. Cross-node targeting + sync is M5.
