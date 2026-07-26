/** Mission graph-query + view MCP tools (proxy the /mission query/view routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { projectMissions } from './projections';

export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}
const S = { type: 'string' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));
const FILTER = { type: 'array' as const, items: { type: 'object' as const, properties: { field: S, op: S, value: {}, flags: S }, required: ['field', 'op'] }, description: 'AND-ed clauses {field,op,value,flags?}; op ∈ eq/ne/gt/gte/lt/lte/in/nin/contains/regex/wildcard/exists. tags.<dim>/dependsOn/projects are array fields (contains=includes, in=intersects, exists=non-empty).' };
const EXPAND = { type: 'object' as const, properties: { direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } } };

export const MISSION_QUERY_TOOL_DEFS = [
  { name: 'mission_query', description: 'Filter missions by attributes incl. tag dimensions (tags.<dim>). Returns a SUMMARY projection by default (id/title/status/progress/deps/binding/env/tags + an "omitted" count of the narrative fields); pass detail:"full" for whole missions — ~20KB EACH, so page it. {filter?:[{field,op,value}], sort?:[{field,dir}], detail?:"summary"|"full", limit?, offset?, id?}.', inputSchema: obj({ filter: FILTER, sort: { type: 'array' as const, items: { type: 'object' as const } }, detail: { ...S, enum: ['summary', 'full'], description: 'summary (default) | full' }, limit: { type: 'number' as const, description: 'page size (default 50 summary / 5 full)' }, offset: { type: 'number' as const, description: 'page offset (default 0)' }, id: { ...S, description: 'scope to one mission' } }) },
  { name: 'mission_neighbors', description: 'Relationship neighbors of ONE mission: parents/children (parentId) + dependencies/dependents (dependsOn), BFS to depth. {id, direction?:parents|children|dependencies|dependents|all (default all), depth?(default 1)}.', inputSchema: obj({ id: S, direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } }, ['id']) },
  { name: 'mission_graph', description: 'Drawable graph: filter selects matches, optional expand pulls in their neighbors; returns {nodes,edges:[{from,to,type:parent|dependsOn}]}. {filter?, expand?:{direction,depth}}.', inputSchema: obj({ filter: FILTER, expand: EXPAND }) },
  { name: 'mission_view_set', description: 'Create or update a saved dashboard view = a query (filter+expand) + display hints (groupBy a tag dimension, highlight, layout tree|dag, nodeFields). Omit id to create. {id?, name, query?, display?}.', inputSchema: obj({ id: S, name: S, query: { type: 'object' as const }, display: { type: 'object' as const } }, ['name']) },
  { name: 'mission_view_list', description: 'List saved dashboard views.', inputSchema: obj({}) },
  { name: 'mission_view_get', description: 'Get one saved dashboard view by id.', inputSchema: obj({ id: S }, ['id']) },
  { name: 'mission_view_delete', description: 'Delete a saved dashboard view by id.', inputSchema: obj({ id: S }, ['id']) },
] as const;

export const MISSION_QUERY_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  // SUMMARY by default — measured at 960,675 bytes before this change (larger than the
  // whole context window, from one call). `limit`/`offset`/`detail` are applied HERE
  // rather than forwarded, so paging is coherent: the route's own `limit` is a plain
  // post-filter slice with no offset, so combining the two would silently page inside an
  // already-truncated set. The route still does the filtering and sorting, and it loads
  // every mission regardless, so there is no extra cost to slicing on this side.
  mission_query: async (a) => {
    try {
      const { limit: _l, offset: _o, detail: _d, id: _i, ids: _is, ...forward } = a || {};
      const res = await workerPost('/mission/query', forward) as Record<string, unknown>;
      const rows = Array.isArray(res?.missions) ? res.missions as Array<Record<string, unknown>> : [];
      return pretty(projectMissions(rows, a || {}, 'mission_query'));
    } catch (e) { return err((e as Error).message); }
  },
  mission_neighbors: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/${encodeURIComponent(id)}/neighbors`, a)); } catch (e) { return err((e as Error).message); } },
  mission_graph: async (a) => { try { return pretty(await workerPost('/mission/graph', a)); } catch (e) { return err((e as Error).message); } },
  mission_view_set: async (a) => { try { return pretty(await workerPost('/mission/views', withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
  mission_view_list: async () => { try { return pretty(await workerGet('/mission/views')); } catch (e) { return err((e as Error).message); } },
  mission_view_get: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerGet(`/mission/views/${encodeURIComponent(id)}`)); } catch (e) { return err((e as Error).message); } },
  mission_view_delete: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/views/${encodeURIComponent(id)}/delete`, {})); } catch (e) { return err((e as Error).message); } },
};
