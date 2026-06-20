// core/src/mcp-server/tools/data-tools.ts
// MCP tools for the generic data service. Handlers resolve the caller's principal from the
// MCP call context (set at the entry point) and call the in-process DataService directly, so
// a hub-relayed (cloud) call is enforced as cloud — never silently escalated to local root.
import type { McpToolResult } from '../configure';
import { ok, err } from './_passthrough';
import { normalizeFilter, compactResult, compactRecord, summarizeRecord, resolvePath, windowValue, detectType, numArg, boolArg, grepField, selectLines } from './data-tools-format';
import { currentMcpContext } from '../principal-context';
import { getDataService, type CallCtx } from '../../data/data-service';
import type { DataRecord, QuerySpec, SearchSpec, AccessRequest } from '../../data/types';
import { getHubConfig } from '../../hub-client/hub-config';

function ctxFromArgs(args: Record<string, unknown>): CallCtx | { error: string } {
  const c = currentMcpContext();
  if (!c) return { error: 'no MCP principal context (tool invoked outside an MCP entry point)' };
  const keyHeader = typeof args.key === 'string' ? (args.key as string) : undefined;
  return { principal: c.principal, keyHeader };
}

const LOCAL_ONLY_MSG =
  'FORBIDDEN: data management is local-only. This MCP session is remote (a cloud principal), so it cannot create/drop datasets, manage access keys, or trigger sync. Run management from a Claude Code session on the data-service host (a local session). Tip: call data_catalog and check you.canManage.';

/** Front-gate management tools on a LOCAL principal, returning a clear, actionable message for remote sessions. */
function requireLocalCtx(): CallCtx | { error: string } {
  const c = currentMcpContext();
  if (!c) return { error: 'no MCP principal context (tool invoked outside an MCP entry point)' };
  if (c.principal.type !== 'local') return { error: LOCAL_ONLY_MSG };
  return { principal: c.principal };
}

function pretty(v: unknown): string { return JSON.stringify(v, null, 2); }

async function handleDataCatalog(_args: Record<string, unknown>): Promise<McpToolResult> {
  const c = currentMcpContext();
  if (!c) return err('no MCP principal context');
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const cfg = getHubConfig();
  const servedBy = { node: cfg.gatewayId || cfg.machineId, hostname: cfg.hostname, platform: cfg.platform };
  return ok(pretty({
    you: { principal: c.principal.type, canManage: c.principal.type === 'local' },
    servedBy,
    datasets: svc.catalog(c.principal),
  }));
}

async function handleDataRequestAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const c = currentMcpContext();
  if (!c) return err('no MCP principal context');
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const req: AccessRequest = {
    intent: typeof args.intent === 'string' ? args.intent : undefined,
    grants: Array.isArray(args.grants) ? (args.grants as AccessRequest['grants']) : [],
    ttlSeconds: numArg(args.ttlSeconds),
  };
  const res = await svc.requestAccess(c.principal, req);
  if (!res.ok) return err(`${res.code}: ${res.reason}`);
  return ok(pretty({ key: res.value.key, keyId: res.value.keyId, grants: res.value.grants, expiresAt: res.value.expiresAt }));
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
  if (r.value == null) return err(`NOT_FOUND: no record "${id}" in dataset "${dataset}"`);
  const rec = r.value;

  // Type-aware partial access: drill into one field/part and slice it in the unit
  // natural to its detected type (chars=text, lines=code, elements=json[], bytes=binary).
  const field = typeof args.field === 'string' ? args.field : undefined;
  const part = typeof args.part === 'string' ? args.part : undefined;
  if (field || part) {
    const sel = part ? `part:${part}` : field!;
    const resolved = resolvePath(rec, sel);
    if (!resolved.ok) return err(`${resolved.error} (in record "${id}")`);
    // grep: matching lines with line numbers; lines: explicit ranges; else: a window.
    const grep = typeof args.grep === 'string' ? args.grep : undefined;
    const linesSpec = typeof args.lines === 'string' ? args.lines : undefined;
    if (grep) {
      const res = grepField(resolved.value, grep, {
        wildcard: boolArg(args.wildcard),
        ignoreCase: boolArg(args.ignoreCase),
        context: numArg(args.context),
        maxMatches: numArg(args.limit),
      });
      return ok(pretty({ id, path: sel, ...res }));
    }
    if (linesSpec) return ok(pretty({ id, path: sel, ...selectLines(resolved.value, linesSpec) }));
    const win = windowValue(resolved.value, { offset: numArg(args.offset), limit: numArg(args.limit) });
    return ok(pretty({ id, path: sel, type: detectType(resolved.value).type, ...win }));
  }

  // Whole record: summary (default, type-aware previews) or bounded full.
  const view = typeof args.view === 'string' ? args.view : 'summary';
  if (view === 'full') return ok(pretty(compactRecord(rec, 12000)));
  return ok(pretty(summarizeRecord(rec)));
}

async function handleDataQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  if (!dataset) return err('dataset is required');
  const q = (args.query && typeof args.query === 'object' ? { ...args.query } : {}) as QuerySpec;
  try {
    q.filter = normalizeFilter(q.filter); // accept symbolic ops; loud error on a bad op
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const r = await svc.query(ctx, dataset, q);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  // Records can be large; project to a bounded form (full record via data_get).
  return ok(pretty(compactResult(r.value)));
}

async function handleDataSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  if (!dataset) return err('dataset is required');
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return err('query is required');
  let filter: SearchSpec['filter'];
  try {
    filter = normalizeFilter(args.filter);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const spec: SearchSpec = {
    query,
    limit: numArg(args.limit),
    filter,
  };
  const r = await svc.search(ctx, dataset, spec);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(compactResult(r.value)));
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
    version: 0, // placeholder — engine overwrites in DataService.put
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

async function handleDataAdmin(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  const op = String(args.op || '');
  if (!dataset) return err('dataset is required');
  if (!op) return err('op is required');
  const opArgs = (args.args && typeof args.args === 'object' ? args.args : undefined) as Record<string, unknown> | undefined;
  const r = await svc.admin(ctx, dataset, op, opArgs);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataCreateDataset(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const id = String(args.id || ''); if (!id) return err('id is required');
  const r = await svc.createDataset(ctx, {
    id,
    backend: (args.backend as any) || 'cache',
    title: typeof args.title === 'string' ? args.title : undefined,
    visibility: args.visibility as any,
    readOnly: args.readOnly === true ? true : undefined,
    sensitive: args.sensitive === true ? true : undefined,
    syncMode: args.syncMode as any,
    config: (args.config && typeof args.config === 'object' ? args.config : { kind: (args.backend as any) || 'cache' }) as any,
    acl: Array.isArray(args.acl) ? (args.acl as any) : undefined,
  });
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataDropDataset(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || ''); if (!dataset) return err('dataset is required');
  const r = await svc.dropDataset(ctx, dataset);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataKeys(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.listKeys(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataRevokeKey(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const keyId = String(args.keyId || ''); if (!keyId) return err('keyId is required');
  const revoked = await svc.revoke(ctx.principal, keyId);
  return ok(pretty({ revoked }));
}

async function handleDataSync(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.sync(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
}

async function handleDataSyncStatus(_args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = requireLocalCtx(); if ('error' in ctx) return err(ctx.error);
  const svc = getDataService(); if (!svc.isEnabled()) return err('data service is disabled');
  const r = await svc.syncStatus(ctx);
  if (!r.ok) return err(`${r.code}: ${r.reason}`);
  return ok(pretty(r.value));
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
    annotations: { readOnlyHint: false },
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
    description: 'Read a record by id, with type-aware progressive disclosure. Default (no field/part) returns a SUMMARY: each field/text is auto-classified (text|code|json|binary) with its size (+ code language, + a short snippet); binary is never inlined. To read a specific part, pass `field` (or `part`) and then EITHER (a) `grep` — return only the lines matching a pattern, each with its 1-based line number (like grep -n; add `context` for surrounding lines, `ignoreCase`, `wildcard` to treat the pattern as a *,? glob); OR (b) `lines` — an explicit line-range spec like "2-4,7,9-10"; OR (c) `offset`/`limit` to window in the field type\'s natural unit (text→chars, code→lines, json→element page or a JSON path like `parts[2].summary`, binary→base64 byte range). The response states `unit`, totals, and `hasMore`. `view:"full"` returns the whole record (bounded). NOT_FOUND if the id is absent. Pass `key` if you have one.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {
      dataset: STR('Dataset id.'),
      id: STR('Record id.'),
      view: STR('summary (default — type-classified field previews) | full (whole record, bounded).'),
      field: STR('Drill into one field/text. Accepts a JSON path: "text", a bare field name, "fields.x", "parts[2].summary".'),
      part: STR('Shorthand: resolve the fields.parts[] element whose partId matches (e.g. "K057.3").'),
      grep: STR('Return only the lines of the field matching this pattern (regex by default), each with its 1-based line number. Pairs with context/ignoreCase/wildcard; `limit` caps matches.'),
      wildcard: { type: 'boolean' as const, description: 'Treat `grep` as a *,? glob (matched within each line) instead of a regex.' },
      ignoreCase: { type: 'boolean' as const, description: 'Case-insensitive `grep`.' },
      context: { type: 'number' as const, description: 'Lines of context to include before/after each `grep` match.' },
      lines: STR('Explicit line ranges to return, e.g. "2-4,7,9-10" — each returned line is tagged with its number.'),
      offset: { type: 'number' as const, description: 'Window start, in the field type\'s natural unit (chars for text, 1-based line for code, element index for json[], byte for binary).' },
      limit: { type: 'number' as const, description: 'Window size in the natural unit (text 4000 chars / code 200 lines / json 50 elems / binary 48KB caps); also caps `grep` matches.' },
      key: STR('Access key from data_request_access (omit if local).'),
    }, required: ['dataset', 'id'] },
  },
  {
    name: 'data_query',
    description: 'Query records in a data-service dataset with filter/sort/limit. Returns matching records as type-aware SUMMARIES: each field/text is auto-classified (text|code|json|binary) with size (+ code language/snippet); large values are collapsed to a descriptor (binary never inlined). To read a specific part of a record, call data_get with field/part/offset/limit. Pass `key` if you have one. filter is an ARRAY of { field, op, value, flags? } clauses, AND-ed together; valid op values are eq, ne, gt, gte, lt, lte, in, nin, contains, regex, wildcard, exists (symbolic >=, >, <=, <, =, != also accepted). regex matches value as a regex (optional flags:"i"); wildcard is an anchored *,? glob; nin = not-in-array; exists checks field presence (value:true/false). A bad operator → BAD_FILTER_OP, an invalid regex → BAD_REGEX (never silently-empty results).',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id.'), query: { type: 'object' as const, description: 'QuerySpec: { filter?: [{field, op, value, flags?}], sort?: [{field, dir}], limit?, offset? }. op ∈ eq|ne|gt|gte|lt|lte|in|nin|contains|regex|wildcard|exists (symbolic >=,>,<=,<,=,!= accepted). dir ∈ asc|desc.' }, key: STR('Access key (omit if local).') }, required: ['dataset'] },
  },
  {
    name: 'data_search',
    description: 'Semantic + full-text hybrid search over a search-capable dataset (the system `knowledge`/`vectors` stores, or any `vector` backend). Cache/sql/file backends return NOT_SUPPORTED — use data_query for those. Returns the best-matching records ranked by a relevance `score` (high→low) as type-aware SUMMARIES (each field/text classified text|code|json|binary with size; large values collapsed, binary never inlined). To read a specific part of a hit, call data_get(dataset, id, field/part/offset/limit). Pass `key` if you have one. The optional filter is an ARRAY of { field, op, value, flags? } (op ∈ eq|ne|gt|gte|lt|lte|in|nin|contains|regex|wildcard|exists, symbolic forms accepted).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset: STR('Dataset id (search-capable: knowledge, vectors, or a vector backend).'),
        query: STR('Natural-language search query.'),
        limit: { type: 'number' as const, description: 'Max results to return (default 20).' },
        filter: { type: 'array' as const, description: 'Optional QueryFilter[] applied to results: [{ field, op, value }], op ∈ eq|ne|gt|gte|lt|lte|in|contains.', items: { type: 'object' as const } },
        key: STR('Access key granting search/read (omit if local).'),
      },
      required: ['dataset', 'query'],
    },
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
  {
    name: 'data_admin',
    description: 'Run a declared maintenance op on a (system) dataset — break-glass management of the existing knowledge/vectors stores. knowledge ops: stats, add-comment, regenerate, dedup, review, remote-sync. vectors ops: stats, rebuild-fts, delete-knowledge, delete-session, delete-all-by-type. Requires the manage action (local by default; cloud only via an explicit operator ACL rule + key).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset: STR('System dataset id (e.g. "knowledge" or "vectors").'),
        op: STR('The maintenance op to run.'),
        args: { type: 'object' as const, description: 'Op-specific arguments (e.g. { knowledgeId } for regenerate, { type } for delete-all-by-type).' },
        key: STR('Access key granting manage (omit if local).'),
      },
      required: ['dataset', 'op'],
    },
  },
  {
    name: 'data_create_dataset',
    description: 'Create a new data-service dataset (cache/vector/sql). LOCAL-ONLY: works only from a Claude Code session running on the data-service host; a remote/hub session is refused. Check data_catalog -> you.canManage first. Body: { id, backend, visibility?, syncMode?, config?, acl?, readOnly?, sensitive? }.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: {
      id: STR('Dataset id (^[a-z0-9][a-z0-9_-]{0,63}$; not a reserved name).'),
      backend: STR('Backend: cache | vector | sql.'),
      visibility: STR('local-only | synced | cross-node-readable.'),
      syncMode: STR('none | full | partial.'),
      config: { type: 'object' as const, description: 'BackendConfig, e.g. { kind:"sql", indexedFields:[...] }.' },
      acl: { type: 'array' as const, description: 'AclRule[]: [{ principal, actions[] }].', items: { type: 'object' as const } },
      title: STR('Optional title.'),
    }, required: ['id', 'backend'] },
  },
  {
    name: 'data_drop_dataset',
    description: 'Drop a dataset and its backend storage. LOCAL-ONLY (remote sessions refused). Refuses system datasets + remote replicas. Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { dataset: STR('Dataset id to drop.') }, required: ['dataset'] },
  },
  {
    name: 'data_keys',
    description: 'List issued access keys (metadata only — keyId, principal, grants, expiry, revoked; NEVER secrets). LOCAL-ONLY (remote sessions refused). Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'data_revoke_key',
    description: 'Revoke an access key by keyId. LOCAL-ONLY (remote sessions refused). Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: { keyId: STR('The keyId to revoke (from data_keys).') }, required: ['keyId'] },
  },
  {
    name: 'data_sync',
    description: 'Trigger a cross-node reconcile (pull synced datasets from peers). LOCAL-ONLY (remote sessions refused). Returns the sync run summary. Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: false },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
  {
    name: 'data_sync_status',
    description: 'Report the cross-node sync status (last run, peers checked, records applied/skipped, errors). LOCAL-ONLY (remote sessions refused). Check data_catalog -> you.canManage.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
] as const;

export const DATA_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  data_catalog: handleDataCatalog,
  data_request_access: handleDataRequestAccess,
  data_get: handleDataGet,
  data_query: handleDataQuery,
  data_search: handleDataSearch,
  data_put: handleDataPut,
  data_delete: handleDataDelete,
  data_admin: handleDataAdmin,
  data_create_dataset: handleDataCreateDataset,
  data_drop_dataset: handleDataDropDataset,
  data_keys: handleDataKeys,
  data_revoke_key: handleDataRevokeKey,
  data_sync: handleDataSync,
  data_sync_status: handleDataSyncStatus,
};
