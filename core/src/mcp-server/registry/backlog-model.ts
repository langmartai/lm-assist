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
  /** Client-supplied idempotency key stamped at CREATE (empty = none). Persisted so a
   *  retry resolves to the same item across a Core restart and across the fleet
   *  replica, not just within one process's memory. Never patchable.
   *
   *  Optional because every item written BEFORE this field existed simply has none —
   *  the live dataset is full of them, and they must keep reading cleanly. */
  requestId?: string;
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
    : fail('INVALID_INPUT', `${name} ${JSON.stringify(v)} is not valid — must be one of: ${allowed.join(', ')}`));
}

export const validateType = enumValidator('type', BACKLOG_TYPES);
export const validateStatus = enumValidator('status', BACKLOG_STATUSES);
export const validatePriority = enumValidator('priority', BACKLOG_PRIORITIES);

// ── enum coercion (route-layer, like normalizeTags) ────────────────────────
//
// The 2026-07-25 incident: three consecutive backlog_create calls died on
// `priority: "medium"` because the canonical token is `med`. The caller had no way
// to recover — the schema advertises the enum, but nothing enforces it on the way in
// and nothing mapped the obvious synonym on the way through. These tables map the
// words a caller actually reaches for; anything genuinely unmappable still fails the
// validator (coercion must never INVENT a value), and the refusal now echoes what
// was sent so the next attempt can be different.

const canon = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '') || null : null;

const PRIORITY_ALIASES: Record<string, BacklogPriority> = {
  medium: 'med', normal: 'med', moderate: 'med', mid: 'med', middle: 'med', m: 'med', p2: 'med', '2': 'med',
  important: 'high', major: 'high', h: 'high', p1: 'high', '1': 'high',
  urgent: 'critical', blocker: 'critical', blocking: 'critical', crit: 'critical', highest: 'critical',
  emergency: 'critical', asap: 'critical', p0: 'critical', '0': 'critical',
  minor: 'low', trivial: 'low', lowest: 'low', l: 'low', 'nice-to-have': 'low', someday: 'low', p3: 'low', '3': 'low',
};

const TYPE_ALIASES: Record<string, BacklogType> = {
  enhancement: 'feature', improvement: 'feature', story: 'feature', request: 'feature', capability: 'feature',
  defect: 'bug', error: 'bug', fault: 'bug', regression: 'bug', broken: 'bug', fix: 'bug',
  chore: 'task', todo: 'task', work: 'task', action: 'task', 'action-item': 'task',
  proposal: 'idea', suggestion: 'idea', concept: 'idea', thought: 'idea', brainstorm: 'idea',
  problem: 'issue', incident: 'issue', concern: 'issue', gap: 'issue',
};

const STATUS_ALIASES: Record<string, BacklogStatus> = {
  new: 'open', todo: 'open', backlog: 'open', pending: 'open', 'not-started': 'open', filed: 'open',
  discussion: 'discussing', 'in-discussion': 'discussing', reviewing: 'discussing', 'under-review': 'discussing',
  approved: 'accepted', agreed: 'accepted', 'signed-off': 'accepted',
  postponed: 'deferred', later: 'deferred', 'on-hold': 'deferred', paused: 'deferred', snoozed: 'deferred',
  declined: 'rejected', wontfix: 'rejected', 'wont-fix': 'rejected', 'will-not-fix': 'rejected', dropped: 'rejected',
  scheduled: 'planned', 'in-progress': 'planned', 'in-flight': 'planned', doing: 'planned', wip: 'planned', started: 'planned',
  done: 'implemented', complete: 'implemented', completed: 'implemented', shipped: 'implemented',
  merged: 'implemented', delivered: 'implemented', resolved: 'implemented', fixed: 'implemented',
};

function coerceEnum<T extends string>(v: unknown, allowed: readonly T[], aliases: Record<string, T>): T | null {
  const c = canon(v);
  if (c === null) return null;
  if ((allowed as readonly string[]).includes(c)) return c as T;
  return aliases[c] ?? null;
}

/** `"medium"`/`"P0"`/`"urgent"` → a canonical priority; null when unmappable. */
export const normalizePriority = (v: unknown): BacklogPriority | null => coerceEnum(v, BACKLOG_PRIORITIES, PRIORITY_ALIASES);
/** `"enhancement"`/`"defect"` → a canonical type; null when unmappable. */
export const normalizeType = (v: unknown): BacklogType | null => coerceEnum(v, BACKLOG_TYPES, TYPE_ALIASES);
/** `"done"`/`"wip"` → a canonical status; null when unmappable (`"closed"` is
 *  deliberately absent — implemented or rejected? guessing would corrupt the board). */
export const normalizeStatus = (v: unknown): BacklogStatus | null => coerceEnum(v, BACKLOG_STATUSES, STATUS_ALIASES);

// ── idempotency + duplicate detection ──────────────────────────────────────

export const MAX_REQUEST_ID_CHARS = 128;
/** How long an identical create is treated as a repeat of the same intent rather than
 *  a deliberate second filing. Long enough to cover a relay timeout + agent retry
 *  (seconds), short enough that re-raising an old title next week still works. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
/** Dice coefficient above which two titles are REPORTED as possible duplicates. Never
 *  refuses a write — a false positive must not be able to eat a legitimate item. */
export const DUPLICATE_SIMILARITY = 0.5;
/** Minimum shared content words before similarity counts at all. */
export const MIN_SHARED_TITLE_TOKENS = 3;
export const MAX_DUPLICATE_HINTS = 3;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateRequestId(v: unknown): Validation {
  if (typeof v !== 'string' || !REQUEST_ID_RE.test(v)) {
    return fail('INVALID_INPUT', `requestId must be ≤${MAX_REQUEST_ID_CHARS} chars of [A-Za-z0-9._:-]`);
  }
  return { ok: true };
}

/** Case/punctuation-insensitive title key — the exact-repeat identity. */
export function normalizeTitleKey(title: unknown): string {
  return String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'not', 'so', 'at', 'by', 'it', 'that', 'this']);

/** Crude singular-ing so "sessions"/"session" and "reports"/"report" are one token —
 *  enough for title matching, and cheaper than pulling in a stemmer. */
const stem = (t: string): string => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

function titleTokens(title: unknown): Set<string> {
  return new Set(normalizeTitleKey(title).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(stem));
}

export function sharedTitleTokens(a: unknown, b: unknown): number {
  const tb = titleTokens(b);
  let shared = 0;
  for (const t of titleTokens(a)) if (tb.has(t)) shared++;
  return shared;
}

/** How alike two titles are: 1 = same words, 0 = nothing shared.
 *
 *  `max(dice, overlap)` rather than Dice alone, because the real duplicates are LOPSIDED
 *  — the second filing of an idea is usually a longer rewrite of the first ("CCR remote
 *  registry out of sync with live tmux sessions" vs "…keeps stale entries — dead
 *  sessions still registered, breaking cloud/remote list visibility"). Dice divides by
 *  the combined length and scores that pair 0.36, i.e. invisible; the overlap
 *  coefficient divides by the SHORTER title and scores it 0.5. Caller-side a minimum
 *  shared-token count keeps short titles from riding overlap to a false positive. */
export function titleSimilarity(a: unknown, b: unknown): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  if (shared === 0) return 0;
  const dice = (2 * shared) / (ta.size + tb.size);
  const overlap = shared / Math.min(ta.size, tb.size);
  return Math.max(dice, overlap);
}

/** The field validator: '' means "no key" (the default for items created without one). */
export function validateRequestIdField(v: unknown): Validation {
  if (v === '') return { ok: true };
  return validateRequestId(v);
}

export interface CreateIdentity { requestId?: string; title: string; description?: string; now: number }

/** An EXISTING item this create is a repeat of, or null to mint a new one. Pure, so the
 *  policy is testable without a store:
 *   - `requestId` is an exact contract — it matches however old the item is and whatever
 *     the rest of the payload says (the FIRST write is authoritative);
 *   - otherwise an identical title+description inside DUPLICATE_WINDOW_MS is treated as
 *     the same intent (covers a retry that carried no key). Outside the window the same
 *     title is a legitimate new filing.
 *  Removed items never match — re-filing a killed idea must work. */
export function findIdempotentMatch(
  docs: readonly BacklogDoc[],
  input: CreateIdentity,
): { doc: BacklogDoc; reason: 'requestId' | 'exact-repeat' } | null {
  if (input.requestId) {
    const byKey = docs.find((d) => d.requestId === input.requestId);
    if (byKey) return { doc: byKey, reason: 'requestId' };
  }
  const key = normalizeTitleKey(input.title);
  const desc = String(input.description ?? '');
  if (!key) return null;
  const repeat = docs
    .filter((d) => !d.removed
      && normalizeTitleKey(d.title) === key
      && String(d.description ?? '') === desc
      && input.now - d.createdAt <= DUPLICATE_WINDOW_MS)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  return repeat ? { doc: repeat, reason: 'exact-repeat' } : null;
}

/** Near-duplicates worth telling the caller about — ADVISORY only. This is what the
 *  2026-07-25 pairs actually were: one assistant turn firing rephrased siblings 13ms
 *  apart, too different for any exact rule to catch, obvious to a similarity check. */
export function findPossibleDuplicates(
  docs: readonly BacklogDoc[],
  title: string,
  excludeId?: string,
): { id: string; title: string; score: number }[] {
  return docs
    .filter((d) => !d.removed && d.name !== excludeId)
    .map((d) => ({ id: d.name, title: d.title, score: titleSimilarity(title, d.title), shared: sharedTitleTokens(title, d.title) }))
    // The shared-token floor is what keeps the overlap coefficient honest: two 2-word
    // titles sharing one word would otherwise score 0.5 on nothing.
    .filter((c) => c.score >= DUPLICATE_SIMILARITY && c.shared >= MIN_SHARED_TITLE_TOKENS)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DUPLICATE_HINTS)
    .map(({ id, title: t, score }) => ({ id, title: t, score: Math.round(score * 100) / 100 }));
}

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
