/** Pure backlog-item model (backlog-graph design 2026-07-21): versioned JSON meta docs
 *  for NOT-YET-IMPLEMENTED ideas/features/issues/bugs/tasks, forming a graph via typed
 *  edges stored on each item. Third instantiation of the overlay-doc registry family
 *  (mcp-tool registry, assist-content registry) — same OverlayDoc bookkeeping, so the
 *  API aliases `id = name` and `version = rev`.
 *
 *  No IO — safe anywhere in the import graph (the content-model precedent). */
import type { OverlayChange, OverlayDoc, Validation } from './doc-model';

export const BACKLOG_DATASET = 'backlog';
export const BACKLOG_HISTORY_CAP = 20;
export const MAX_TITLE_CHARS = 300;
export const MAX_DESCRIPTION_BYTES = 16384;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_EDGES = 100;
export const MAX_NOTE_CHARS = 4000;
export const MAX_DISCUSSION_ENTRIES = 200;
export const MAX_REVIEWS = 100;

export const BACKLOG_TYPES = ['idea', 'feature', 'issue', 'bug', 'task'] as const;
export type BacklogType = (typeof BACKLOG_TYPES)[number];

export const BACKLOG_STATUSES = ['open', 'discussing', 'accepted', 'deferred', 'rejected', 'planned', 'implemented'] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

export const BACKLOG_PRIORITIES = ['low', 'med', 'high', 'critical'] as const;
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number];

export const BACKLOG_EDGE_KINDS = ['depends-on', 'blocks', 'relates-to', 'parent-of', 'duplicate-of', 'spawned-mission'] as const;
export type BacklogEdgeKind = (typeof BACKLOG_EDGE_KINDS)[number];

/** `conversation|code|remote` are what MCP callers resolve/declare (the mission schema);
 *  `web|api` cover management-UI / plain-API notes so entries never misattribute. */
export const SESSION_KINDS = ['conversation', 'code', 'remote', 'web', 'api'] as const;
export type BacklogSessionKind = (typeof SESSION_KINDS)[number];

export interface BacklogEdge { to: string; kind: BacklogEdgeKind }
export interface BacklogDiscussionEntry {
  sessionId: string;
  sessionKind: BacklogSessionKind;
  note: string;
  at: number;
  label?: string;
}
export const REVIEW_VERDICTS = ['approve', 'reject', 'concerns'] as const;
export type BacklogReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export interface BacklogReview { by: string; verdict: BacklogReviewVerdict; note?: string; at: number }

export type BacklogState = {
  title: string;
  description: string;
  type: BacklogType;
  status: BacklogStatus;
  priority: BacklogPriority;
  tags: string[];
  edges: BacklogEdge[];
  discussion: BacklogDiscussionEntry[];
  reviews: BacklogReview[];
  removed: boolean;
};

export type BacklogChange = OverlayChange<BacklogState>;
export type BacklogDoc = OverlayDoc<BacklogState>;

// ── ids ────────────────────────────────────────────────────────────────────

const ID_RE = /^bl_[a-z0-9]{4,16}$/;

export function validateBacklogId(id: string): Validation {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, code: 'INVALID_INPUT', message: `invalid backlog item id "${id}" (want bl_<4-16 lowercase [a-z0-9]>)` };
  }
  return { ok: true };
}

/** Generate a fresh item id. `rand` is injectable for tests; the default uses 8 hex
 *  chars of crypto randomness (collision guarded by create-if-absent at the store). */
export function genBacklogId(rand?: () => string): string {
  if (rand) return `bl_${rand()}`;
  // node:crypto via eval-free require — this module stays import-pure for the stdio graph.
  const { randomBytes } = require('crypto') as typeof import('crypto');
  return `bl_${randomBytes(4).toString('hex')}`;
}

// ── field validators (store-enforced on every write path incl. rollback) ───

const fail = (code: string, message: string): Validation => ({ ok: false, code, message });

export function validateTitle(v: unknown): Validation {
  if (typeof v !== 'string') return fail('INVALID_INPUT', 'title must be a string');
  if (v.trim().length === 0) return fail('INVALID_INPUT', 'title must be non-empty');
  if (v.length > MAX_TITLE_CHARS) return fail('TITLE_TOO_LARGE', `title exceeds ${MAX_TITLE_CHARS} chars`);
  return { ok: true };
}

export function validateDescription(v: unknown): Validation {
  if (typeof v !== 'string') return fail('INVALID_INPUT', 'description must be a string (markdown)');
  if (Buffer.byteLength(v, 'utf8') > MAX_DESCRIPTION_BYTES) {
    return fail('DESCRIPTION_TOO_LARGE', `description exceeds ${MAX_DESCRIPTION_BYTES} bytes`);
  }
  return { ok: true };
}

function enumValidator(name: string, allowed: readonly string[]): (v: unknown) => Validation {
  return (v) => (typeof v === 'string' && allowed.includes(v)
    ? { ok: true }
    : fail('INVALID_INPUT', `${name} must be one of: ${allowed.join(', ')}`));
}

export const validateType = enumValidator('type', BACKLOG_TYPES);
export const validateStatus = enumValidator('status', BACKLOG_STATUSES);
export const validatePriority = enumValidator('priority', BACKLOG_PRIORITIES);

export function validateTags(v: unknown): Validation {
  if (!Array.isArray(v)) return fail('INVALID_INPUT', 'tags must be an array of strings');
  if (v.length > MAX_TAGS) return fail('INVALID_INPUT', `at most ${MAX_TAGS} tags`);
  for (const t of v) {
    if (typeof t !== 'string' || t.trim().length === 0) return fail('INVALID_INPUT', 'each tag must be a non-empty string');
    if (t.length > MAX_TAG_CHARS) return fail('INVALID_INPUT', `tag "${t.slice(0, 20)}…" exceeds ${MAX_TAG_CHARS} chars`);
  }
  if (new Set(v).size !== v.length) return fail('INVALID_INPUT', 'tags must be unique');
  return { ok: true };
}

/** Trim, drop empties, dedupe (first occurrence wins), cap. Route-layer convenience —
 *  the validator still rejects out-of-grammar values that bypass normalization. */
export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const s = t.trim().slice(0, MAX_TAG_CHARS);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function validateEdges(v: unknown): Validation {
  if (!Array.isArray(v)) return fail('INVALID_INPUT', 'edges must be an array of {to, kind}');
  if (v.length > MAX_EDGES) return fail('INVALID_INPUT', `at most ${MAX_EDGES} edges per item`);
  const seen = new Set<string>();
  for (const e of v) {
    if (!e || typeof e !== 'object') return fail('INVALID_INPUT', 'each edge must be an object {to, kind}');
    const { to, kind } = e as { to?: unknown; kind?: unknown };
    const idv = validateBacklogId(String(to ?? ''));
    if (!idv.ok) return fail('INVALID_INPUT', `edge target ${idv.message}`);
    if (typeof kind !== 'string' || !(BACKLOG_EDGE_KINDS as readonly string[]).includes(kind)) {
      return fail('INVALID_INPUT', `edge kind must be one of: ${BACKLOG_EDGE_KINDS.join(', ')}`);
    }
    const key = `${to}|${kind}`;
    if (seen.has(key)) return fail('INVALID_INPUT', `duplicate edge ${kind} → ${to}`);
    seen.add(key);
  }
  return { ok: true };
}

export function validateDiscussion(v: unknown): Validation {
  if (!Array.isArray(v)) return fail('INVALID_INPUT', 'discussion must be an array');
  if (v.length > MAX_DISCUSSION_ENTRIES) return fail('INVALID_INPUT', `at most ${MAX_DISCUSSION_ENTRIES} discussion entries`);
  for (const d of v) {
    if (!d || typeof d !== 'object') return fail('INVALID_INPUT', 'each discussion entry must be an object');
    const e = d as Partial<BacklogDiscussionEntry>;
    if (typeof e.sessionId !== 'string' || e.sessionId.length === 0 || e.sessionId.length > 128) {
      return fail('INVALID_INPUT', 'discussion.sessionId must be a non-empty string ≤128 chars');
    }
    if (typeof e.sessionKind !== 'string' || !(SESSION_KINDS as readonly string[]).includes(e.sessionKind)) {
      return fail('INVALID_INPUT', `discussion.sessionKind must be one of: ${SESSION_KINDS.join(', ')}`);
    }
    if (typeof e.note !== 'string' || e.note.trim().length === 0 || e.note.length > MAX_NOTE_CHARS) {
      return fail('INVALID_INPUT', `discussion.note must be a non-empty string ≤${MAX_NOTE_CHARS} chars`);
    }
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return fail('INVALID_INPUT', 'discussion.at must be a timestamp (ms)');
    if (e.label !== undefined && (typeof e.label !== 'string' || e.label.length > 200)) {
      return fail('INVALID_INPUT', 'discussion.label must be a string ≤200 chars');
    }
  }
  return { ok: true };
}

export function validateReviews(v: unknown): Validation {
  if (!Array.isArray(v)) return fail('INVALID_INPUT', 'reviews must be an array');
  if (v.length > MAX_REVIEWS) return fail('INVALID_INPUT', `at most ${MAX_REVIEWS} reviews`);
  for (const r of v) {
    if (!r || typeof r !== 'object') return fail('INVALID_INPUT', 'each review must be an object');
    const e = r as Partial<BacklogReview>;
    if (typeof e.by !== 'string' || e.by.length === 0 || e.by.length > 200) {
      return fail('INVALID_INPUT', 'review.by must be a non-empty string ≤200 chars');
    }
    if (typeof e.verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(e.verdict)) {
      return fail('INVALID_INPUT', `review.verdict must be one of: ${REVIEW_VERDICTS.join(', ')}`);
    }
    if (e.note !== undefined && (typeof e.note !== 'string' || e.note.length > MAX_NOTE_CHARS)) {
      return fail('INVALID_INPUT', `review.note must be a string ≤${MAX_NOTE_CHARS} chars`);
    }
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return fail('INVALID_INPUT', 'review.at must be a timestamp (ms)');
  }
  return { ok: true };
}

export function validateRemoved(v: unknown): Validation {
  return typeof v === 'boolean' ? { ok: true } : fail('INVALID_INPUT', 'removed must be a boolean');
}

/** Self-edges can only be judged with the doc's own name — hence the store's
 *  refuseWrite hook (covers EVERY write path incl. rollback), not a field validator. */
export function refuseSelfEdges(name: string, next: BacklogState): Validation {
  if (Array.isArray(next.edges) && next.edges.some((e) => e && e.to === name)) {
    return fail('INVALID_INPUT', `item ${name} cannot have an edge to itself`);
  }
  return { ok: true };
}

// ── equality / summaries (for the doc-store equals/summarize hooks) ────────

/** Deep-enough equality for our JSON-shaped field values (arrays of plain objects,
 *  stable key order — every write path builds them the same way). */
export function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export const countOf = (v: unknown): string => `n:${Array.isArray(v) ? v.length : 0}`;

// ── serialization (API shape: id/version aliases per the mission meta schema) ──

export interface BacklogApiItem extends BacklogState {
  id: string;
  version: number;
  rev: number;
  createdBy: BacklogDoc['createdBy'];
  lastUpdatedBy: BacklogDoc['lastUpdatedBy'];
  createdAt: number;
  updatedAt: number;
  history?: BacklogChange[];
}

export function toApiItem(doc: BacklogDoc, opts: { includeHistory?: boolean } = {}): BacklogApiItem {
  const { name, rev, history, createdBy, lastUpdatedBy, createdAt, updatedAt, ...state } = doc;
  return {
    id: name,
    ...(state as BacklogState),
    version: rev,
    rev,
    createdBy,
    lastUpdatedBy,
    createdAt,
    updatedAt,
    ...(opts.includeHistory ? { history } : {}),
  };
}

/** Compact list row: everything except the long/markdown bodies, plus counts. */
export function toListRow(doc: BacklogDoc) {
  return {
    id: doc.name,
    title: doc.title,
    type: doc.type,
    status: doc.status,
    priority: doc.priority,
    tags: doc.tags,
    edges: doc.edges,
    removed: doc.removed,
    counts: { discussion: doc.discussion.length, reviews: doc.reviews.length, edges: doc.edges.length },
    version: doc.rev,
    rev: doc.rev,
    lastUpdatedBy: doc.lastUpdatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── graph (drawable nodes + flattened typed edges) ─────────────────────────

export interface BacklogGraphNode {
  id: string;
  title: string;
  type: BacklogType;
  status: BacklogStatus;
  priority: BacklogPriority;
  tags: string[];
  removed: boolean;
  counts: { discussion: number; reviews: number };
  updatedAt: number;
}
export interface BacklogGraphEdge { from: string; to: string; kind: BacklogEdgeKind }

/** Nodes = items (removed excluded unless asked); edges = each item's typed edges,
 *  kept only when BOTH endpoints are visible (a dangling target renders as nothing
 *  rather than an arrow into the void). */
export function buildBacklogGraph(
  docs: BacklogDoc[],
  opts: { includeRemoved?: boolean } = {},
): { nodes: BacklogGraphNode[]; edges: BacklogGraphEdge[] } {
  const visible = docs.filter((d) => opts.includeRemoved || !d.removed);
  const ids = new Set(visible.map((d) => d.name));
  const nodes: BacklogGraphNode[] = visible.map((d) => ({
    id: d.name,
    title: d.title,
    type: d.type,
    status: d.status,
    priority: d.priority,
    tags: d.tags,
    removed: d.removed,
    counts: { discussion: d.discussion.length, reviews: d.reviews.length },
    updatedAt: d.updatedAt,
  }));
  const edges: BacklogGraphEdge[] = [];
  for (const d of visible) {
    for (const e of d.edges) {
      if (ids.has(e.to)) edges.push({ from: d.name, to: e.to, kind: e.kind });
    }
  }
  return { nodes, edges };
}

/** Append with the oldest entries dropped past `cap` (discussion/reviews). */
export function appendCapped<T>(arr: T[], entry: T, cap: number): T[] {
  return [...arr, entry].slice(-cap);
}
