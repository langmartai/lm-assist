/** Mission graph-query + view MCP tools (proxy the /mission query/view routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';

export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}
const S = { type: 'string' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));
const FILTER = { type: 'array' as const, items: { type: 'object' as const, properties: { field: S, op: S, value: {}, flags: S }, required: ['field', 'op'] }, description: 'AND-ed clauses {field,op,value,flags?}; op ∈ eq/ne/gt/gte/lt/lte/in/nin/contains/regex/wildcard/exists. tags.<dim>/dependsOn/projects are array fields (contains=includes, in=intersects, exists=non-empty).' };
const EXPAND = { type: 'object' as const, properties: { direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } } };

export const MISSION_QUERY_TOOL_DEFS = [
  { name: 'mission_query', description: 'Filter missions by attributes incl. tag dimensions (tags.<dim>). Returns the matching missions. {filter?:[{field,op,value}], sort?:[{field,dir}], limit?}.', inputSchema: obj({ filter: FILTER, sort: { type: 'array' as const, items: { type: 'object' as const } }, limit: { type: 'number' as const } }) },
  { name: 'mission_neighbors', description: 'Relationship neighbors of ONE mission: parents/children (parentId) + dependencies/dependents (dependsOn), BFS to depth. {id, direction?:parents|children|dependencies|dependents|all (default all), depth?(default 1)}.', inputSchema: obj({ id: S, direction: { ...S, enum: ['parents', 'children', 'dependencies', 'dependents', 'all'] }, depth: { type: 'number' as const } }, ['id']) },
  { name: 'mission_graph', description: 'Drawable graph: filter selects matches, optional expand pulls in their neighbors; returns {nodes,edges:[{from,to,type:parent|dependsOn}]}. {filter?, expand?:{direction,depth}}.', inputSchema: obj({ filter: FILTER, expand: EXPAND }) },
] as const;

export const MISSION_QUERY_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_query: async (a) => { try { return pretty(await workerPost('/mission/query', a)); } catch (e) { return err((e as Error).message); } },
  mission_neighbors: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/${encodeURIComponent(id)}/neighbors`, a)); } catch (e) { return err((e as Error).message); } },
  mission_graph: async (a) => { try { return pretty(await workerPost('/mission/graph', a)); } catch (e) { return err((e as Error).message); } },
};
