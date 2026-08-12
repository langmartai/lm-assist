/** Backlog-registry MCP tools (proxy the /backlog routes) — manage the fleet-synced
 *  backlog/feature-idea GRAPH from any session (claude.ai conversation, Claude Code,
 *  remote/CCR). Writes ride the `_actor` hint so the route attributes them to the
 *  precise caller session (connector tool-call id → resolveMcpActor). */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { withActorHint } from './mission-query';
import { compactActor, compactBacklogWrite, intArg, paginate } from './projections';

const S = { type: 'string' as const };
const B = { type: 'boolean' as const };
const N = { type: 'number' as const };
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

// ── collection projections (MCP layer only — the /backlog web page keeps the full routes) ──
//
// Measured 2026-08-12: the routine no-arg backlog_list was 65,833 B — past the
// 65,536 B enforced ceiling in result-cap.ts, i.e. silently TRUNCATED on every
// routine call — and backlog_graph was 47,843 B and climbing (the fleet backlog
// only accumulates; +22 KB in the prior 6 days). Sized so the DEFAULT call sits
// under the 25 KiB soft budget: a full list row was ~800 B, 30% of it the
// lastUpdatedBy actor (kind/id/node/channel/label-as-absolute-path/toolUseId),
// which compactActor collapses to `kind:id8`; a slim row is ~640 B incl.
// envelope, so 30 rows ≈ 19.1 KB. A slim graph node is ~274 B, so 50 nodes plus
// their within-page edges ≈ 19.9 KB on the 90-node/66-edge fleet.
// Pinned by backlog-output-size.test.ts; budgets in tool-output-budget.ts.

export const BACKLOG_LIST_DEFAULT_LIMIT = 30;
export const BACKLOG_GRAPH_DEFAULT_NODES = 50;

/** One list row, slimmed: the route's toListRow minus the full actor object
 *  (→ `by: kind:id8`), the duplicated `version` (rev survives), and the
 *  `removed:false` noise (removed rows still say so). */
function slimListRow(r: Record<string, unknown>): Record<string, unknown> {
  const { lastUpdatedBy, version, removed, ...rest } = r;
  void version;
  const by = compactActor(lastUpdatedBy);
  return { ...rest, ...(removed ? { removed: true } : {}), ...(by ? { by } : {}) };
}

/** Page + slim the GET /backlog response. Meta stays total/shown/offset/hasMore
 *  (paginate) and the route's counts (incl. removed) survive, so a page never
 *  reads as the whole set. */
export function projectBacklogList(res: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const all = Array.isArray(res?.items) ? res.items as Array<Record<string, unknown>> : [];
  const { rows, meta } = paginate(all, intArg(args.limit, BACKLOG_LIST_DEFAULT_LIMIT), intArg(args.offset, 0));
  return {
    ...res,
    ...meta,
    hint: 'Paged summary, most recently updated first. Narrow with {status,type,tag}, page with {limit,offset}; full item = backlog_get({id}).',
    items: rows.map(slimListRow),
  };
}

/** One graph node, slimmed to drawable identity: counts are list detail,
 *  updatedAt only served the sort, removed carries only when true. */
function slimGraphNode(n: Record<string, unknown>): Record<string, unknown> {
  return {
    id: n.id, title: n.title, type: n.type, status: n.status, priority: n.priority, tags: n.tags,
    ...(n.removed ? { removed: true } : {}),
  };
}

/** Page the GET /backlog/graph response: nodes sorted updatedAt-desc then paged;
 *  edges are those WITHIN the shown page, with edgesTotal/edgesShown reported so
 *  the omission is explicit — a raised {limit} reaches the whole graph. */
export function projectBacklogGraph(g: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const allNodes = Array.isArray(g?.nodes) ? g.nodes as Array<Record<string, unknown>> : [];
  const allEdges = Array.isArray(g?.edges) ? g.edges as Array<Record<string, unknown>> : [];
  const sorted = [...allNodes].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const { rows, meta } = paginate(sorted, intArg(args.limit, BACKLOG_GRAPH_DEFAULT_NODES), intArg(args.offset, 0));
  const shown = new Set(rows.map((n) => String(n.id)));
  const edges = allEdges.filter((e) => shown.has(String(e.from)) && shown.has(String(e.to)));
  return {
    ...meta,
    edgesTotal: allEdges.length,
    edgesShown: edges.length,
    hint: 'Node page (most recently updated first); edges shown are those within the page. Raise {limit} or page with {offset} for the rest.',
    nodes: rows.map(slimGraphNode),
    edges,
  };
}

export const BACKLOG_TOOL_DEFS = [
  { name: 'backlog_list', description: 'List backlog items (the fleet-synced idea/feature/issue/bug/task graph — things NOT yet turned into missions). Filters: {status?, type?, tag?, includeRemoved?}. Returns a paged set of compact rows with edge/discussion/review counts.', annotations: { readOnlyHint: true }, inputSchema: obj({ status: { ...S, enum: STATUSES }, type: { ...S, enum: TYPES }, tag: S, includeRemoved: B, limit: { ...N, description: 'Page size (default 30).' }, offset: N }) },
  { name: 'backlog_get', description: 'Get ONE backlog item by id (bl_…): full markdown description, edges, discussion, reviews, and version history (every write is a numbered rev).', annotations: { readOnlyHint: true }, inputSchema: obj({ id: S }, ['id']) },
  {
    name: 'backlog_create',
    description: 'Create a backlog item: {title, description? (markdown), type?: idea|feature|issue|bug|task, '
      + 'priority?: low|med|high|critical (common synonyms like "medium"/"urgent"/"p1" are accepted and mapped), tags?, requestId?}. '
      + 'Returns the item with its generated id (bl_…). Use backlog_link afterwards to relate it to other items. '
      + 'IDEMPOTENT: pass a requestId and a repeat of the SAME call resolves to the SAME item (response carries idempotent:true) — '
      + 'always reuse it when retrying after an ORIGIN_TIMEOUT, which means the write may already have landed. '
      + 'Do NOT file the same idea twice in one turn: if the response carries possibleDuplicates, link duplicate-of or backlog_remove the extra.',
    inputSchema: obj({
      title: S, description: S,
      type: { ...S, enum: TYPES }, priority: { ...S, enum: PRIORITIES }, tags: TAGS,
      requestId: { ...S, description: 'Idempotency key (≤128 chars of [A-Za-z0-9._:-]). Reuse the SAME value when retrying so a lost/late ack cannot create a duplicate.' },
    }, ['title']),
  },
  { name: 'backlog_update', description: 'Update fields of a backlog item: {id, title?, description?, type?, status? (open|discussing|accepted|deferred|rejected|planned|implemented), priority?, tags?}. Edges/discussion/reviews/removal have their own tools. Every change is a new rev.', inputSchema: obj({ id: S, title: S, description: S, type: { ...S, enum: TYPES }, status: { ...S, enum: STATUSES }, priority: { ...S, enum: PRIORITIES }, tags: TAGS }, ['id']) },
  { name: 'backlog_link', description: 'Add a typed edge between backlog items: {from, to, kind: depends-on|blocks|relates-to|parent-of|duplicate-of|spawned-mission}. depends-on means FROM depends on TO. Duplicate edges no-op; the target must exist.', inputSchema: obj({ from: S, to: S, kind: { ...S, enum: EDGE_KINDS } }, ['from', 'to', 'kind']) },
  { name: 'backlog_unlink', description: 'Remove edge(s) from→to: {from, to, kind?} — omit kind to remove every edge to that target.', inputSchema: obj({ from: S, to: S, kind: { ...S, enum: EDGE_KINDS } }, ['from', 'to']) },
  { name: 'backlog_review', description: 'Attach a review to a backlog item: {id, verdict: approve|reject|concerns, note?, by?}. `by` defaults to the calling session/conversation id.', inputSchema: obj({ id: S, verdict: { ...S, enum: ['approve', 'reject', 'concerns'] }, note: S, by: S }, ['id', 'verdict']) },
  { name: 'backlog_discuss', description: 'Attach a discussion note to a backlog item: {id, note}. The CALLER session is auto-attached (Claude Code sessions are pinned by tool-call id; claude.ai conversations by recency). Remote/CCR sessions should self-declare with {sessionId, sessionKind:"remote"}.', inputSchema: obj({ id: S, note: S, sessionId: S, sessionKind: { ...S, enum: ['conversation', 'code', 'remote'] } }, ['id', 'note']) },
  { name: 'backlog_remove', description: 'Soft-remove a backlog item (kept in history, excluded from list/graph): {id}. {id, restore:true} brings it back. Rev-tracked like every write.', inputSchema: obj({ id: S, restore: B }, ['id']) },
  { name: 'backlog_graph', description: 'The drawable backlog graph: {nodes (id/title/type/status/priority/tags), edges:[{from,to,kind}]}. Nodes are paged recent-first and edges are those within the page (edgesTotal reports the rest). {includeRemoved?, limit?, offset?}.', annotations: { readOnlyHint: true }, inputSchema: obj({ includeRemoved: B, limit: { ...N, description: 'Node page size (default 50).' }, offset: N }) },
] as const;

export const BACKLOG_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  // Rows are already a projection server-side (no description/discussion/reviews/history),
  // but the collection itself was unbounded — it only ever grows, and by 2026-08-12 the
  // no-arg call rode the 64 KiB result cap. Paged + slimmed here (projectBacklogList) so
  // it cannot become the next mission_list.
  backlog_list: async (a) => {
    try {
      const qs = new URLSearchParams();
      for (const k of ['status', 'type', 'tag'] as const) if (typeof a[k] === 'string' && a[k]) qs.set(k, String(a[k]));
      if (flag(a.includeRemoved)) qs.set('includeRemoved', 'true');
      const res = await workerGet(`/backlog${qs.toString() ? `?${qs}` : ''}`) as Record<string, unknown>;
      return pretty(projectBacklogList(res, a));
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
      if (a.requestId !== undefined) body.requestId = String(a.requestId);
      // Compact echo: on the IDEMPOTENT path this used to return the resolved item's
      // whole accumulated discussion[] + reviews[] (measured 63KB), which made a
      // well-discussed item expensive merely to re-create.
      return pretty(compactBacklogWrite(await workerPost('/backlog', hinted(body))));
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
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(id)}`, hinted(body))));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_link: async (a) => {
    try {
      const from = String(a.from || '');
      if (!from) return err('from is required');
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(from)}/link`, hinted({ to: a.to, kind: a.kind }))));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_unlink: async (a) => {
    try {
      const from = String(a.from || '');
      if (!from) return err('from is required');
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(from)}/unlink`, hinted({ to: a.to, ...(a.kind !== undefined ? { kind: a.kind } : {}) }))));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_review: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(id)}/review`, hinted({ verdict: a.verdict, note: a.note, by: a.by }))));
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
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(id)}/discuss`, hinted(body))));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_remove: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(compactBacklogWrite(await workerPost(`/backlog/${encodeURIComponent(id)}/remove`, hinted({ ...(flag(a.restore) ? { restore: true } : {}) }))));
    } catch (e) { return err((e as Error).message); }
  },
  backlog_graph: async (a) => {
    try {
      const qs = flag(a.includeRemoved) ? '?includeRemoved=true' : '';
      const g = await workerGet(`/backlog/graph${qs}`) as Record<string, unknown>;
      return pretty(projectBacklogGraph(g, a));
    } catch (e) { return err((e as Error).message); }
  },
};
