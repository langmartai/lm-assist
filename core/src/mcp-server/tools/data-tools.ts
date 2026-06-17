// core/src/mcp-server/tools/data-tools.ts
// MCP tools for the generic data service. Handlers resolve the caller's principal from the
// MCP call context (set at the entry point) and call the in-process DataService directly, so
// a hub-relayed (cloud) call is enforced as cloud — never silently escalated to local root.
import type { McpToolResult } from '../configure';
import { ok, err } from './_passthrough';
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

function pretty(v: unknown): string { return JSON.stringify(v, null, 2); }

async function handleDataCatalog(_args: Record<string, unknown>): Promise<McpToolResult> {
  const c = currentMcpContext();
  if (!c) return err('no MCP principal context');
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const cfg = getHubConfig();
  const servedBy = { node: cfg.gatewayId || cfg.machineId, hostname: cfg.hostname, platform: cfg.platform };
  return ok(pretty({ servedBy, datasets: svc.catalog(c.principal) }));
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

async function handleDataSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  const ctx = ctxFromArgs(args);
  if ('error' in ctx) return err(ctx.error);
  const svc = getDataService();
  if (!svc.isEnabled()) return err('data service is disabled');
  const dataset = String(args.dataset || '');
  if (!dataset) return err('dataset is required');
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query) return err('query is required');
  const spec: SearchSpec = {
    query,
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    filter: Array.isArray(args.filter) ? (args.filter as SearchSpec['filter']) : undefined,
  };
  const r = await svc.search(ctx, dataset, spec);
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
    name: 'data_search',
    description: 'Semantic + full-text hybrid search over a vector-backed dataset. Returns the best-matching records (redacted) each with a relevance `score`, ranked high to low. Only datasets whose backend is `vector` support this; others return NOT_SUPPORTED. Pass `key` if you have one. Search quality depends on each record having a meaningful \'text\' (or string fields); records with only numeric fields fall back to their id.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        dataset: STR('Dataset id (must be a vector-backed dataset).'),
        query: STR('Natural-language search query.'),
        limit: { type: 'number' as const, description: 'Max results to return (default 20).' },
        filter: { type: 'array' as const, description: 'Optional QueryFilter[] applied to results: [{ field, op, value }].', items: { type: 'object' as const } },
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
] as const;

export const DATA_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  data_catalog: handleDataCatalog,
  data_request_access: handleDataRequestAccess,
  data_get: handleDataGet,
  data_query: handleDataQuery,
  data_search: handleDataSearch,
  data_put: handleDataPut,
  data_delete: handleDataDelete,
};
