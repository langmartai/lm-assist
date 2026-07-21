/** Backlog-registry MCP tools (proxy the /backlog routes) — manage the fleet-synced
 *  backlog/feature-idea GRAPH from any session (claude.ai conversation, Claude Code,
 *  remote/CCR). Writes ride the `_actor` hint so the route attributes them to the
 *  precise caller session (connector tool-call id → resolveMcpActor). */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { withActorHint } from './mission-query';

const S = { type: 'string' as const };
const B = { type: 'boolean' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

const TYPES = ['idea', 'feature', 'issue', 'bug', 'task'];
const STATUSES = ['open', 'discussing', 'accepted', 'deferred', 'rejected', 'planned', 'implemented'];
const PRIORITIES = ['low', 'med', 'high', 'critical'];
const EDGE_KINDS = ['depends-on', 'blocks', 'relates-to', 'parent-of', 'duplicate-of', 'spawned-mission'];
const TAGS = { type: 'array' as const, items: S, description: 'Short labels; a JSON/comma string is coerced.' };

/** Connector clients deliver array args as strings sometimes — coerce liberally. */
export function coerceTags(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try { const p = JSON.parse(s); if (Array.isArray(p)) return p.map(String); } catch { /* fall through to comma split */ }
    }
    return s.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return undefined;
}

const flag = (v: unknown): boolean => v === true || v === 'true';

function hinted(a: Record<string, unknown>): Record<string, unknown> {
  return withActorHint(a, currentMcpContext()?.toolUseId);
}

export const BACKLOG_TOOL_DEFS = [
  { name: 'backlog_list', description: 'List backlog items (the fleet-synced idea/feature/issue/bug/task graph — things NOT yet turned into missions). Filters: {status?, type?, tag?, includeRemoved?}. Returns compact rows with edge/discussion/review counts.', annotations: { readOnlyHint: true }, inputSchema: obj({ status: { ...S, enum: STATUSES }, type: { ...S, enum: TYPES }, tag: S, includeRemoved: B }) },
  { name: 'backlog_get', description: 'Get ONE backlog item by id (bl_…): full markdown description, edges, discussion, reviews, and version history (every write is a numbered rev).', annotations: { readOnlyHint: true }, inputSchema: obj({ id: S }, ['id']) },
  { name: 'backlog_create', description: 'Create a backlog item: {title, description? (markdown), type?: idea|feature|issue|bug|task, priority?: low|med|high|critical, tags?}. Returns the item with its generated id (bl_…). Use backlog_link afterwards to relate it to other items.', inputSchema: obj({ title: S, description: S, type: { ...S, enum: TYPES }, priority: { ...S, enum: PRIORITIES }, tags: TAGS }, ['title']) },
  { name: 'backlog_update', description: 'Update fields of a backlog item: {id, title?, description?, type?, status? (open|discussing|accepted|deferred|rejected|planned|implemented), priority?, tags?}. Edges/discussion/reviews/removal have their own tools. Every change is a new rev.', inputSchema: obj({ id: S, title: S, description: S, type: { ...S, enum: TYPES }, status: { ...S, enum: STATUSES }, priority: { ...S, enum: PRIORITIES }, tags: TAGS }, ['id']) },
  { name: 'backlog_link', description: 'Add a typed edge between backlog items: {from, to, kind: depends-on|blocks|relates-to|parent-of|duplicate-of|spawned-mission}. depends-on means FROM depends on TO. Duplicate edges no-op; the target must exist.', inputSchema: obj({ from: S, to: S, kind: { ...S, enum: EDGE_KINDS } }, ['from', 'to', 'kind']) },
  { name: 'backlog_unlink', description: 'Remove edge(s) from→to: {from, to, kind?} — omit kind to remove every edge to that target.', inputSchema: obj({ from: S, to: S, kind: { ...S, enum: EDGE_KINDS } }, ['from', 'to']) },
  { name: 'backlog_review', description: 'Attach a review to a backlog item: {id, verdict: approve|reject|concerns, note?, by?}. `by` defaults to the calling session/conversation id.', inputSchema: obj({ id: S, verdict: { ...S, enum: ['approve', 'reject', 'concerns'] }, note: S, by: S }, ['id', 'verdict']) },
  { name: 'backlog_discuss', description: 'Attach a discussion note to a backlog item: {id, note}. The CALLER session is auto-attached (Claude Code sessions are pinned by tool-call id; claude.ai conversations by recency). Remote/CCR sessions should self-declare with {sessionId, sessionKind:"remote"}.', inputSchema: obj({ id: S, note: S, sessionId: S, sessionKind: { ...S, enum: ['conversation', 'code', 'remote'] } }, ['id', 'note']) },
  { name: 'backlog_remove', description: 'Soft-remove a backlog item (kept in history, excluded from list/graph): {id}. {id, restore:true} brings it back. Rev-tracked like every write.', inputSchema: obj({ id: S, restore: B }, ['id']) },
  { name: 'backlog_graph', description: 'The drawable backlog graph: {nodes (id/title/type/status/priority/tags/counts), edges:[{from,to,kind}]}. Same data the /backlog web page renders. {includeRemoved?}.', annotations: { readOnlyHint: true }, inputSchema: obj({ includeRemoved: B }) },
] as const;

export const BACKLOG_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  backlog_list: async (a) => {
    try {
      const qs = new URLSearchParams();
      for (const k of ['status', 'type', 'tag'] as const) if (typeof a[k] === 'string' && a[k]) qs.set(k, String(a[k]));
      if (flag(a.includeRemoved)) qs.set('includeRemoved', 'true');
      return pretty(await workerGet(`/backlog${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_get: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerGet(`/backlog/${encodeURIComponent(id)}`));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_create: async (a) => {
    try {
      const body: Record<string, unknown> = { title: a.title, description: a.description, type: a.type, priority: a.priority };
      const tags = coerceTags(a.tags);
      if (tags !== undefined) body.tags = tags;
      return pretty(await workerPost('/backlog', hinted(body)));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_update: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const body: Record<string, unknown> = {};
      for (const k of ['title', 'description', 'type', 'status', 'priority'] as const) if (a[k] !== undefined) body[k] = a[k];
      const tags = coerceTags(a.tags);
      if (tags !== undefined) body.tags = tags;
      return pretty(await workerPost(`/backlog/${encodeURIComponent(id)}`, hinted(body)));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_link: async (a) => {
    try {
      const from = String(a.from || '');
      if (!from) return err('from is required');
      return pretty(await workerPost(`/backlog/${encodeURIComponent(from)}/link`, hinted({ to: a.to, kind: a.kind })));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_unlink: async (a) => {
    try {
      const from = String(a.from || '');
      if (!from) return err('from is required');
      return pretty(await workerPost(`/backlog/${encodeURIComponent(from)}/unlink`, hinted({ to: a.to, ...(a.kind !== undefined ? { kind: a.kind } : {}) })));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_review: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/backlog/${encodeURIComponent(id)}/review`, hinted({ verdict: a.verdict, note: a.note, by: a.by })));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_discuss: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const body: Record<string, unknown> = { note: a.note };
      // Explicit self-declaration (remote/CCR) wins; otherwise the route derives the
      // session from the resolved actor (the auto-attach path).
      if (typeof a.sessionId === 'string' && a.sessionId) {
        body.session = { id: a.sessionId, kind: typeof a.sessionKind === 'string' && a.sessionKind ? a.sessionKind : 'remote' };
      }
      return pretty(await workerPost(`/backlog/${encodeURIComponent(id)}/discuss`, hinted(body)));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_remove: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/backlog/${encodeURIComponent(id)}/remove`, hinted({ ...(flag(a.restore) ? { restore: true } : {}) })));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_graph: async (a) => {
    try {
      const qs = flag(a.includeRemoved) ? '?includeRemoved=true' : '';
      return pretty(await workerGet(`/backlog/graph${qs}`));
    } catch (e) { return err((e as Error).message); }
  },
};
