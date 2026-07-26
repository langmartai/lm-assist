// Summary projections + paging for the MCP tools that return record COLLECTIONS.
//
// WHY (measured, backlog bl_5cc4bad9): `mission_list` and `mission_query` each returned
// ~900KB in a single call — every Mission in full, including `objective` (uncapped, 8KB
// in a live sample), `history` (≤50 entries each carrying a full actor plus per-field
// diffs), and `results` (≤100 × 2KB). At ~4 chars/token that is more than the whole 200K
// context window, from ONE call.
//
// The central ceiling in `result-cap.ts` makes that survivable; this module makes it
// unnecessary. A list call should answer "what is there", and a detail call should answer
// "tell me everything about this one" — collapsing the two is what made the list fatal.
//
// SCOPE — deliberately applied in the MCP tool layer, NOT in the REST routes. The web UI
// consumes `/mission`, `/mission/query` and `/terminal/cc-sessions` directly, so changing
// the routes would risk the UI for no benefit; only LLM callers reach these tools.
//
// The full objects stay one flag away (`detail:'full'`) — the Mission Controller depends
// on reading whole missions, and a guardrail that removed that capability would just be
// moved out of the way later.

/** How much of each record to return. `summary` is the default everywhere. */
export type DetailLevel = 'summary' | 'full';

/** Coerce a caller-supplied detail argument. Anything unrecognised means summary: this is
 *  a size guard, so an unknown value must fail SAFE (small), not open. `full`/`true`/
 *  `all` are accepted because callers reach for all three. */
export function detailLevel(v: unknown): DetailLevel {
  if (v === true) return 'full';
  const s = String(v ?? '').toLowerCase();
  return s === 'full' || s === 'true' || s === 'all' ? 'full' : 'summary';
}

/** Parse a non-negative integer argument, tolerating the strings MCP clients often send
 *  for number-typed params. Returns `fallback` for anything invalid. */
export function intArg(v: unknown, fallback: number, max = 1000): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export interface Page<T> {
  rows: T[];
  meta: { total: number; shown: number; offset: number; limit: number; hasMore: boolean };
}

/** Slice a collection and report enough for the caller to page WITHOUT guessing. `total`
 *  and `hasMore` are the point: a bare truncated array reads as a complete one. */
export function paginate<T>(all: T[], limit: number, offset: number): Page<T> {
  const rows = all.slice(offset, offset + limit);
  return {
    rows,
    meta: { total: all.length, shown: rows.length, offset, limit, hasMore: offset + rows.length < all.length },
  };
}

/** Bound a free-text field for a summary row. Long values are the whole problem — the
 *  controller writes `ctl:surfaced` tag values of 300+ chars — so summaries keep the
 *  head and say how much is missing rather than dropping the field entirely. */
export function clip(s: unknown, maxChars: number): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}… [+${s.length - maxChars} chars]`;
}

/** Tags, kept useful for filtering but bounded. */
function compactTags(tags: unknown): Record<string, unknown> | undefined {
  if (!tags || typeof tags !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [dim, val] of Object.entries(tags as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      const vals = val.slice(0, 8).map((v) => clip(String(v), 80));
      out[dim] = val.length > 8 ? [...vals, `… [+${val.length - 8} more]`] : vals;
    } else {
      out[dim] = clip(String(val), 80);
    }
  }
  return out;
}

const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * One mission, small. Keeps identity, state, and the fields the Mission Controller needs
 * to PLACE work (dependencies, binding, host/isolation) — dropping only the narrative
 * bulk (`objective`, `plan`, `nextSteps`, `results`, `history`, `adjustments`).
 *
 * `has` reports what was left out, so a caller can see there IS more and fetch it,
 * instead of concluding a mission has no results because none were shown.
 */
export function missionSummary(m: Record<string, unknown>): Record<string, unknown> {
  const env = (m.env || {}) as Record<string, unknown>;
  const binding = m.binding as Record<string, unknown> | null | undefined;
  const progress = (m.progress || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: m.id,
    title: m.title,
    status: m.status,
  };
  if (m.priority !== undefined) out.priority = m.priority;
  if (progress.percent !== undefined) out.progressPercent = progress.percent;
  if (m.parentId) out.parentId = m.parentId;
  if (len(m.dependsOn)) out.dependsOn = m.dependsOn;
  if (binding) out.binding = { sessionId: binding.sessionId, kind: binding.kind };
  const envOut: Record<string, unknown> = {};
  for (const k of ['host', 'isolation', 'repo', 'branch'] as const) if (env[k]) envOut[k] = env[k];
  if (Object.keys(envOut).length) out.env = envOut;
  const tags = compactTags(m.tags);
  if (tags && Object.keys(tags).length) out.tags = tags;
  // A PREVIEW of the objective, not the whole thing and not nothing. The paired audit
  // (mission_8bc12731) measured objective at 20.1% of the payload — mean 2,836 chars,
  // max 15,890 — so carrying it whole is untenable, but a list with no hint of what each
  // mission is FOR is barely a list. 200 chars across 50 missions costs ~10KB.
  const preview = clip(m.objective, 200);
  if (preview) out.objectivePreview = preview;
  if (m.createdAt) out.createdAt = m.createdAt;
  if (m.updatedAt) out.updatedAt = m.updatedAt;
  // What the summary omitted — presence + size, never the bodies.
  const has: Record<string, unknown> = {};
  if (typeof m.objective === 'string' && m.objective) has.objectiveChars = (m.objective as string).length;
  if (typeof m.plan === 'string' && m.plan) has.planChars = (m.plan as string).length;
  if (len(m.nextSteps)) has.nextSteps = len(m.nextSteps);
  if (len(m.results)) has.results = len(m.results);
  if (len(m.history)) has.history = len(m.history);
  if (len(m.adjustments)) has.adjustments = len(m.adjustments);
  if (Object.keys(has).length) out.omitted = has;
  return out;
}

/**
 * One live Claude Code session, small. The fat fields are the absolute `jsonl` path, the
 * `owner.cwd`/`owner.entrypoint` strings and `verdict.reason` (a prose sentence).
 */
export function ccSessionSummary(s: Record<string, unknown>): Record<string, unknown> {
  const owner = (s.owner || {}) as Record<string, unknown>;
  const verdict = (s.verdict || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { sessionId: s.sessionId };
  if (owner.pid !== undefined) out.pid = owner.pid;
  if (owner.status !== undefined) out.status = owner.status;
  if (owner.cwd !== undefined) out.cwd = owner.cwd;
  if (owner.kind !== undefined) out.kind = owner.kind;
  if (owner.updatedAt !== undefined) out.updatedAt = owner.updatedAt;
  if (s.tmuxSession !== undefined) out.tmuxSession = s.tmuxSession;
  if (s.driveable !== undefined) out.driveable = s.driveable;
  if (verdict.live !== undefined) out.live = verdict.live;
  if (verdict.connectStrategy !== undefined) out.connectStrategy = verdict.connectStrategy;
  return out;
}

/** The line every summarised result carries, so the caller knows the projection happened
 *  and exactly how to get past it. Without this a summary is indistinguishable from a
 *  record that simply has no objective/results. */
export function summaryHint(tool: string, idArg = 'id'): string {
  return (
    `SUMMARY projection (default) — narrative fields are omitted, see "omitted" on each row. ` +
    `For full objects call ${tool}({detail:"full"}), optionally with ${idArg} to scope it, ` +
    `or page with {limit, offset}.`
  );
}

/**
 * One backlog item, small — used for the ECHO that every backlog write returns.
 *
 * The write path was measured at 63KB for a single `backlog_create`. The cause is the
 * IDEMPOTENT path: a repeat create resolves to the existing item and echoes its whole
 * accumulated `discussion[]` (≤200 × 4000 chars) and `reviews[]` (≤100 × 4000) — so the
 * more an item is discussed, the more expensive it becomes to touch it at all. A write
 * echo only needs to confirm WHAT was written; the bodies are one `backlog_get` away.
 */
export function backlogItemSummary(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
  };
  if (item.removed) out.removed = item.removed;
  const desc = clip(item.description, 600);
  if (desc) out.description = desc;
  const tags = compactTags(item.tags);
  if (tags && Object.keys(tags).length) out.tags = tags;
  if (len(item.edges)) out.edges = item.edges;
  for (const k of ['version', 'rev', 'createdAt', 'updatedAt', 'requestId'] as const) {
    if (item[k] !== undefined) out[k] = item[k];
  }
  const has: Record<string, unknown> = {};
  if (typeof item.description === 'string' && (item.description as string).length > 600) {
    has.descriptionChars = (item.description as string).length;
  }
  if (len(item.discussion)) has.discussion = len(item.discussion);
  if (len(item.reviews)) has.reviews = len(item.reviews);
  if (len(item.history)) has.history = len(item.history);
  if (Object.keys(has).length) {
    out.omitted = has;
    out.fullItem = `backlog_get({id:"${String(item.id)}"})`;
  }
  return out;
}

/** Compact the `item` echo on a backlog write response, leaving every other key
 *  (idempotent, possibleDuplicates, changed, …) exactly as the route returned it. */
export function compactBacklogWrite(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res;
  const r = res as Record<string, unknown>;
  if (!r.item || typeof r.item !== 'object') return res;
  return { ...r, item: backlogItemSummary(r.item as Record<string, unknown>) };
}

/**
 * One claude.ai plugin, small. Measured 1,156,396 bytes for 92 plugins — the single
 * largest result on the whole MCP surface, and never suspected before the paired audit
 * (mission_8bc12731) swept every read-only tool. The bulk is the nested CAPABILITY
 * arrays (`skills`, `commands`, `agents`, `mcp_servers`, `hooks`, `binaries`,
 * `monitors`), which a "what plugins do I have" answer does not need — their COUNTS
 * answer that, and the bodies are one targeted call away.
 */
export function claudeaiPluginSummary(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: p.id, name: p.name };
  for (const k of ['display_name', 'enabled', 'version', 'category', 'marketplace_name', 'author', 'updated_at'] as const) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') out[k] = p[k];
  }
  const desc = clip(p.description, 200);
  if (desc) out.description = desc;
  const counts: Record<string, number> = {};
  for (const k of ['skills', 'commands', 'agents', 'mcp_servers', 'hooks', 'clis', 'binaries', 'monitors'] as const) {
    if (len(p[k])) counts[k] = len(p[k]);
  }
  if (Object.keys(counts).length) out.provides = counts;
  return out;
}

/**
 * A MissionActor, compacted. The full object is 7 fields / ~274 bytes (kind, id, node,
 * channel, label — an absolute path — toolUseId, at) and it is embedded once per record,
 * so on `mission_changes` it was the single fattest field across 252 changes. `kind` plus a
 * short id answers "who did this"; the rest is addressing detail nobody reads in a list.
 */
export function compactActor(a: unknown): string | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.slice(0, 8) : '';
  const kind = typeof o.kind === 'string' ? o.kind : 'actor';
  return id ? `${kind}:${id}` : kind;
}

/**
 * One workflow doc, small. Measured 116,668 B for 35 workflows: the `body` IS the workflow
 * (~2KB each) and `history` carries a full post-change state per rev. A LIST of workflows
 * only has to say which ones exist; `mission_workflow_get` serves the body.
 */
export function missionWorkflowSummary(w: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: w.id, title: w.title };
  for (const k of ['editPolicy', 'rev', 'updatedAt'] as const) if (w[k] !== undefined) out[k] = w[k];
  const by = compactActor(w.lastUpdatedBy);
  if (by) out.lastUpdatedBy = by;
  const has: Record<string, unknown> = {};
  if (typeof w.body === 'string' && w.body) has.bodyChars = (w.body as string).length;
  if (len(w.history)) has.history = len(w.history);
  if (Object.keys(has).length) {
    out.omitted = has;
    out.fullDoc = `mission_workflow_get({id:"${String(w.id)}"})`;
  }
  return out;
}

/** One mission change, small — the actor collapses to `kind:id8`. */
export function missionChangeSummary(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { missionId: c.missionId, rev: c.rev, at: c.at };
  const by = compactActor(c.actor);
  if (by) out.by = by;
  if (c.changedFields !== undefined) out.changedFields = c.changedFields;
  return out;
}

/**
 * Default page size per detail level.
 *
 * Sized from measurement, not taste: a real mission SUMMARY row is 1,333 bytes on this
 * fleet (tags 236 B, objectivePreview 213 B, env 105 B, title 76 B…). A 50-row default
 * therefore produced 67.2KB and tripped the 64KB ceiling — the guardrail was shaping the
 * routine call, which is exactly what it must NOT do. 25 rows lands ~33KB, about half the
 * ceiling, leaving headroom as tags and titles grow.
 *
 * Full missions measure ~20KB EACH, so a full page has to be far smaller.
 */
export const DEFAULT_LIMIT_SUMMARY = 25;
export const DEFAULT_LIMIT_FULL = 5;

/**
 * Shared response builder for the mission collection tools (`mission_list`,
 * `mission_query`). Takes every matching mission and returns the projected, paged
 * envelope both tools now emit.
 *
 * `id` scopes to one (or several) missions, which is the natural way to ask for full
 * detail without paging: `mission_list({id:"mission_x", detail:"full"})`.
 */
export function projectMissions(
  all: Array<Record<string, unknown>>,
  args: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const detail = detailLevel(args.detail);
  const wanted = new Set(
    [args.id, ...(Array.isArray(args.ids) ? args.ids : [])]
      .filter((v) => typeof v === 'string' && v)
      .map((v) => String(v)),
  );
  const matched = wanted.size ? all.filter((m) => wanted.has(String(m.id))) : all;

  const limit = intArg(args.limit, detail === 'full' ? DEFAULT_LIMIT_FULL : DEFAULT_LIMIT_SUMMARY);
  const offset = intArg(args.offset, 0);
  const { rows, meta } = paginate(matched, limit, offset);

  return {
    detail,
    ...meta,
    ...(detail === 'summary'
      ? { hint: summaryHint(tool) }
      : { hint: `FULL objects — ${meta.shown} of ${meta.total}. Default page size is ${DEFAULT_LIMIT_FULL} because a full mission runs ~20KB; page with {limit, offset} or scope with {id}.` }),
    missions: detail === 'full' ? rows : rows.map(missionSummary),
  };
}
