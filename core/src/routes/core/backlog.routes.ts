/** Backlog registry routes (backlog-graph design 2026-07-21) — the /backlog management
 *  surface behind the MCP tools and the /backlog web page. Bare {success,data}/{success,
 *  error} envelopes (assist-content idiom), handlers port-injected for tests.
 *
 *  Reads are LOCAL (the fleet replica syncs in); writes are ORIGIN-anchored through the
 *  SHARED origin-anchor: proxy to the dataset origin with the `_originHop` loop guard,
 *  fail CLOSED on unreachable, origin refusals relayed verbatim. Reads NEVER create the
 *  dataset (the split-brain catch) — creation happens on the first origin write inside
 *  the doc-store factory. */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import {
  createBacklogItem, getBacklogDoc, listBacklogDocs, mutateBacklogItem,
  rollbackBacklogItem, updateBacklogItem,
  BACKLOG_DATASET, type BacklogPort,
} from '../../mcp-server/registry/backlog-store';
import {
  appendCapped, buildBacklogGraph, normalizeTags, toApiItem, toListRow,
  validateBacklogId,
  BACKLOG_EDGE_KINDS, MAX_DISCUSSION_ENTRIES, MAX_REVIEWS, REVIEW_VERDICTS, SESSION_KINDS,
  type BacklogDiscussionEntry, type BacklogDoc, type BacklogEdgeKind, type BacklogReview,
  type BacklogReviewVerdict, type BacklogSessionKind, type BacklogState,
} from '../../mcp-server/registry/backlog-model';
import { coarseActor, type MissionActor } from '../../mission/mission-model';
import { thisNode } from '../../mission/mission-store';
import { resolveMcpActor } from '../../mission/mission-actor';
import { anchorToOrigin, realOriginAnchor, type OriginAnchorDeps } from './origin-anchor';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

const BACKLOG_ANCHOR_LABEL = 'backlog';

export function realBacklogOriginAnchor(): OriginAnchorDeps {
  return realOriginAnchor(BACKLOG_DATASET);
}

/** Resolve the writing actor from the `_actor` transport hint (the mission.routes
 *  pattern): MCP callers resolve to their precise session/conversation; everything
 *  else is a coarse api actor. Consumes (deletes) the hint. */
async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as Record<string, unknown>)._actor;
  if (hint && hint.channel === 'mcp') {
    return resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
  }
  return coarseActor('api', thisNode(), Date.now());
}

/** The caller session a discussion note attaches to: explicit `session` from the body
 *  wins (remote/CCR callers must self-declare); else derived from the resolved actor;
 *  else a plain `api` attribution so a note is never lost for lack of identity. */
function sessionFrom(
  explicit: unknown,
  actor: MissionActor,
): { ok: true; session: { id: string; kind: BacklogSessionKind; label?: string } } | { ok: false; message: string } {
  if (explicit !== undefined && explicit !== null) {
    const s = explicit as { id?: unknown; kind?: unknown; label?: unknown };
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    const kind = typeof s.kind === 'string' ? s.kind : '';
    if (!id || id.length > 128) return { ok: false, message: 'session.id must be a non-empty string ≤128 chars' };
    if (!(SESSION_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, message: `session.kind must be one of: ${SESSION_KINDS.join(', ')}` };
    }
    const label = typeof s.label === 'string' ? s.label.slice(0, 200) : undefined;
    return { ok: true, session: { id, kind: kind as BacklogSessionKind, ...(label ? { label } : {}) } };
  }
  if ((actor.kind === 'local-session' || actor.kind === 'controller') && actor.id) {
    return { ok: true, session: { id: actor.id, kind: 'code', ...(actor.label ? { label: actor.label } : {}) } };
  }
  if (actor.kind === 'claudeai-conversation' && actor.id) {
    return { ok: true, session: { id: actor.id, kind: 'conversation', ...(actor.label ? { label: actor.label } : {}) } };
  }
  return { ok: true, session: { id: actor.channel === 'api' ? 'api' : (actor.id ?? 'unknown'), kind: 'api' } };
}

const codeOf = (e: unknown): string => (e as { code?: string }).code ?? 'INVALID_INPUT';
const msgOf = (e: unknown): string => (e as Error).message;

// ── reads (local; NEVER create the dataset) ────────────────────────────────

export async function handleBacklogList(q: Record<string, string>, port?: BacklogPort): Promise<Envelope> {
  let docs: BacklogDoc[] = [];
  try { docs = await listBacklogDocs(port); } catch { docs = []; }
  const includeRemoved = q.includeRemoved === 'true';
  const rows = docs
    .filter((d) => includeRemoved || !d.removed)
    .filter((d) => !q.status || d.status === q.status)
    .filter((d) => !q.type || d.type === q.type)
    .filter((d) => !q.tag || d.tags.includes(q.tag))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toListRow);
  return ok({
    items: rows,
    counts: { shown: rows.length, total: docs.length, removed: docs.filter((d) => d.removed).length },
  });
}

export async function handleBacklogGraph(q: Record<string, string>, port?: BacklogPort): Promise<Envelope> {
  let docs: BacklogDoc[] = [];
  try { docs = await listBacklogDocs(port); } catch { docs = []; }
  return ok(buildBacklogGraph(docs, { includeRemoved: q.includeRemoved === 'true' }));
}

export async function handleBacklogGet(id: string, port?: BacklogPort): Promise<Envelope> {
  let doc: BacklogDoc | null = null;
  try { doc = await getBacklogDoc(id, port); } catch { doc = null; }
  if (!doc) return fail('NOT_FOUND', `no backlog item "${id}"`);
  return ok({ item: toApiItem(doc, { includeHistory: true }) });
}

export async function handleBacklogHistory(id: string, port?: BacklogPort): Promise<Envelope> {
  let doc: BacklogDoc | null = null;
  try { doc = await getBacklogDoc(id, port); } catch { doc = null; }
  if (!doc) return fail('NOT_FOUND', `no backlog item "${id}"`);
  const history = [...doc.history].reverse().map((h) => ({ rev: h.rev, at: h.at, actor: h.actor, changes: h.changes }));
  return ok({ id, rev: doc.rev, history });
}

// ── writes (origin-anchored) ───────────────────────────────────────────────

export async function handleBacklogCreate(
  b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, '/backlog', b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  if (typeof b.title !== 'string' || b.title.trim().length === 0) return fail('INVALID_INPUT', 'title (non-empty string) is required');
  const fields: Partial<BacklogState> & { title: string } = { title: b.title.trim() };
  if (b.description !== undefined) fields.description = String(b.description);
  if (b.type !== undefined) fields.type = b.type as BacklogState['type'];
  if (b.status !== undefined) fields.status = b.status as BacklogState['status'];
  if (b.priority !== undefined) fields.priority = b.priority as BacklogState['priority'];
  if (b.tags !== undefined) fields.tags = normalizeTags(b.tags);
  try {
    const r = await createBacklogItem(fields, who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

const UPDATE_FIELDS = new Set(['title', 'description', 'type', 'status', 'priority', 'tags']);

export async function handleBacklogUpdate(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  // A misspelled field silently changing nothing is the assist-content 200-noop lesson —
  // refuse anything outside the whitelist (edges/discussion/reviews/removed have their
  // own dedicated operations).
  const unknown = Object.keys(b).filter((k) => !UPDATE_FIELDS.has(k) && k !== 'id' && k !== '_actor');
  if (unknown.length > 0) {
    return fail('UNSUPPORTED_FIELD', `unsupported update field(s): ${unknown.join(', ')} — supported: ${[...UPDATE_FIELDS].join(', ')} (edges/discussion/reviews/removed change via link/unlink/discuss/review/remove)`);
  }
  const patch: Partial<BacklogState> = {};
  if (b.title !== undefined) patch.title = typeof b.title === 'string' ? b.title.trim() : (b.title as never);
  if (b.description !== undefined) patch.description = b.description as string;
  if (b.type !== undefined) patch.type = b.type as BacklogState['type'];
  if (b.status !== undefined) patch.status = b.status as BacklogState['status'];
  if (b.priority !== undefined) patch.priority = b.priority as BacklogState['priority'];
  if (b.tags !== undefined) patch.tags = normalizeTags(b.tags);
  if (Object.keys(patch).length === 0) return fail('INVALID_INPUT', 'no fields to update');
  try {
    const r = await updateBacklogItem(id, patch, who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogLink(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/link`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const to = String(b.to ?? '');
  const kind = String(b.kind ?? '');
  const vt = validateBacklogId(to);
  if (!vt.ok) return fail(vt.code, `link target: ${vt.message}`);
  if (!(BACKLOG_EDGE_KINDS as readonly string[]).includes(kind)) {
    return fail('INVALID_INPUT', `kind must be one of: ${BACKLOG_EDGE_KINDS.join(', ')}`);
  }
  if (to === id) return fail('INVALID_INPUT', `item ${id} cannot link to itself`);
  try {
    const target = await getBacklogDoc(to, port);
    if (!target) return fail('NOT_FOUND', `link target "${to}" does not exist`);
    const r = await mutateBacklogItem(id, (prev) => {
      if (prev.edges.some((e) => e.to === to && e.kind === kind)) return null; // duplicate ⇒ no-op
      return { edges: [...prev.edges, { to, kind: kind as BacklogEdgeKind }] };
    }, who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogUnlink(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/unlink`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const to = String(b.to ?? '');
  const kind = b.kind === undefined ? undefined : String(b.kind);
  try {
    const r = await mutateBacklogItem(id, (prev) => {
      const next = prev.edges.filter((e) => !(e.to === to && (kind === undefined || e.kind === kind)));
      if (next.length === prev.edges.length) return null; // nothing matched ⇒ no-op
      return { edges: next };
    }, who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogDiscuss(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/discuss`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (!note) return fail('INVALID_INPUT', 'note (non-empty string) is required');
  const sess = sessionFrom(b.session, who);
  if (!sess.ok) return fail('INVALID_INPUT', sess.message);
  const entry: BacklogDiscussionEntry = {
    sessionId: sess.session.id,
    sessionKind: sess.session.kind,
    note,
    at: Date.now(),
    ...(sess.session.label ? { label: sess.session.label } : {}),
  };
  try {
    const r = await mutateBacklogItem(id, (prev) => ({ discussion: appendCapped(prev.discussion, entry, MAX_DISCUSSION_ENTRIES) }), who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed, attached: { sessionId: entry.sessionId, sessionKind: entry.sessionKind } });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogReview(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/review`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const verdict = String(b.verdict ?? '');
  if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
    return fail('INVALID_INPUT', `verdict must be one of: ${REVIEW_VERDICTS.join(', ')}`);
  }
  const by = typeof b.by === 'string' && b.by.trim()
    ? b.by.trim().slice(0, 200)
    : (who.id ?? who.channel);
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined;
  const review: BacklogReview = { by, verdict: verdict as BacklogReviewVerdict, ...(note ? { note } : {}), at: Date.now() };
  try {
    const r = await mutateBacklogItem(id, (prev) => ({ reviews: appendCapped(prev.reviews, review, MAX_REVIEWS) }), who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogRemove(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/remove`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const removed = !(b.restore === true || b.restore === 'true');
  try {
    const r = await mutateBacklogItem(id, (prev) => (prev.removed === removed ? null : { removed }), who, port);
    return ok({ item: toApiItem(r.doc), changed: r.changed, removed });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

export async function handleBacklogRollback(
  id: string, b: Record<string, unknown>,
  port?: BacklogPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/backlog/${encodeURIComponent(id)}/rollback`, b, BACKLOG_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const toRevRaw = b.toRev;
  const toRev = typeof toRevRaw === 'number' ? toRevRaw : parseInt(String(toRevRaw ?? ''), 10);
  if (Number.isNaN(toRev)) return fail('INVALID_INPUT', 'toRev (number) is required');
  try {
    const r = await rollbackBacklogItem(id, toRev, who, port);
    if ('error' in r) return fail(r.error.code, r.error.message);
    return ok({ item: toApiItem(r.doc) });
  } catch (e) {
    return fail(codeOf(e), msgOf(e));
  }
}

// --- route registration ---

/** Route-layer envelope→ApiResponse (assist-content idiom): handlers stay pure
 *  {success,data|error}; the wire carries wrapResponse/wrapError with meta. */
function toApi(e: Envelope, start: number) {
  return e.success
    ? wrapResponse(e.data, start)
    : wrapError(e.error?.code ?? 'ERROR', e.error?.message ?? 'error', start);
}

export function createBacklogRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrapped = (run: (req: Parameters<RouteHandler['handler']>[0]) => Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => { const start = Date.now(); return toApi(await run(req), start); };
  const body = (req: { body?: unknown }): Record<string, unknown> => (req.body || {}) as Record<string, unknown>;
  return [
    // literals MUST precede the /:id patterns
    { method: 'GET', pattern: /^\/backlog$/, handler: wrapped((req) => handleBacklogList(req.query ?? {})) },
    { method: 'GET', pattern: /^\/backlog\/graph$/, handler: wrapped((req) => handleBacklogGraph(req.query ?? {})) },
    { method: 'GET', pattern: /^\/backlog\/(?<id>[^/]+)\/history$/, handler: wrapped((req) => handleBacklogHistory(req.params.id)) },
    { method: 'POST', pattern: /^\/backlog$/, handler: wrapped((req) => handleBacklogCreate(body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/link$/, handler: wrapped((req) => handleBacklogLink(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/unlink$/, handler: wrapped((req) => handleBacklogUnlink(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/discuss$/, handler: wrapped((req) => handleBacklogDiscuss(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/review$/, handler: wrapped((req) => handleBacklogReview(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/remove$/, handler: wrapped((req) => handleBacklogRemove(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/rollback$/, handler: wrapped((req) => handleBacklogRollback(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
    { method: 'GET', pattern: /^\/backlog\/(?<id>[^/]+)$/, handler: wrapped((req) => handleBacklogGet(req.params.id)) },
    { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)$/, handler: wrapped((req) => handleBacklogUpdate(req.params.id, body(req), undefined, undefined, realBacklogOriginAnchor())) },
  ];
}
