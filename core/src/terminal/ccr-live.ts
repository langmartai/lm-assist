/**
 * CCR live session listing — the SOURCE OF TRUTH for "what remote-control /
 * cloud sessions exist right now".
 *
 * Distinct from `ccr-manager`'s remote registry (`GET /ccr/remote`), which only
 * knows bridges lm-assist itself spawned via ccr_connect/ccr_mirror/ccr_load. A
 * session connected by a native `/remote-control` slash inject is a real, live,
 * web-reachable connection that the registry has never heard of. This module
 * asks the account instead: `GET /v1/sessions` on the OAuth ingress.
 *
 * Ingress: api.anthropic.com + OAuth bearer (`session_…` ids), via
 * `utils/claude-oauth` so the token REFRESHES and 401s retry politely. The
 * claude.ai + cookie ingress (`cse_…` ids) is deliberately not used — no node in
 * this fleet has a usable cookie and the cookie is IP-pinned besides.
 *
 * ─── Everything below is MEASURED against the live endpoint (117, 2026-07-29,
 *     100 rows), not inferred from the protocol notes. Three findings shape the
 *     whole design and each contradicts an assumption in the original spec:
 *
 *  1. `session_context.cwd` is EMPTY on 100/100 rows — including live bridge
 *     sessions. The `ccr-protocol-js-direct` note claims a `--remote-control`
 *     session "appears here with its cwd"; it does not. Repo/branch from
 *     `external_metadata.current_branches` is the locator that IS populated,
 *     so that is what this module surfaces. `cwd` is passed through as null
 *     rather than dropped, so a caller never silently reads absent as unknown.
 *
 *  2. The local-vs-cloud discriminator is `environment_kind`
 *     (`bridge`×99 / `anthropic_cloud`×1), NOT `type` — which is
 *     `internal_session` on every row and discriminates nothing.
 *
 *  3. A raw `limit=100` page is 544,910 bytes. The MCP budget for a list tool
 *     of this class is 25,000 (see `tool-output-budget.ts`), so a passthrough
 *     would overrun it 21.8× — the `mission_list` incident, which cost a
 *     110-message conversation. Hence: project a narrow row, bound the count,
 *     and never return a bare array.
 *
 * LIVENESS IS TWO AXES, and neither alone answers it: `connection_status`
 * (connected/disconnected — is a worker attached) and `session_status`
 * (running/idle/pending/archived). 67 archived rows were still `connected`, so
 * "connected" does not mean live. See {@link isLive}.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { anthropicOAuthGet } from '../utils/claude-oauth';

/** Upstream page size cap. The API accepts limit=100; larger is not honoured. */
const UPSTREAM_PAGE_MAX = 100;
/** Default rows returned to the caller — keeps a normal call far under budget. */
const DEFAULT_LIMIT = 25;
/**
 * Hard ceiling on rows returned, whatever the caller asks for.
 *
 * Set from MEASUREMENT, not taste: a projected row is ~495 bytes, and the MCP
 * budget for this class of tool is 25,000 (`tool-output-budget.ts`). A ceiling
 * of 100 measured 49,982 bytes — 2x over — so the bound would have been
 * nominal, firing only after the damage. 40 rows lands near 20 KB and keeps
 * headroom for the envelope. Raise this only alongside a fresh measurement.
 */
const MAX_LIMIT = 40;
/** Default upstream pages scanned. Rows come back newest-first, so 1 page covers live work. */
const DEFAULT_PAGES = 1;
/** Ceiling on upstream pages, so a caller cannot turn this into an unbounded crawl. */
const MAX_PAGES = 5;

const CCR_BETA = 'ccr-byoc-2025-07-29';

/** A row as it arrives from `GET /v1/sessions`. Only the fields we consume. */
export interface RawSession {
  id?: string;
  title?: string;
  type?: string;
  environment_kind?: string;
  environment_id?: string;
  connection_status?: string;
  session_status?: string;
  status_bucket?: string;
  tags?: string[];
  origin?: string;
  unread?: boolean;
  created_at?: string;
  updated_at?: string;
  external_metadata?: { current_branches?: Record<string, string>; task_summary?: unknown };
  session_context?: { cwd?: string; model?: string; sources?: Array<{ url?: string; revision?: string }> };
}

export type SessionKind = 'local-remote-control' | 'cloud' | 'unknown';
export type ConnectVia = 'native-inject' | 'lm-assist-bridge' | null;

/** The projected row. Deliberately narrow — see finding 3 in the file header. */
export interface LiveSession {
  id: string;
  title: string | null;
  kind: SessionKind;
  via: ConnectVia;
  live: boolean;
  connection: string | null;
  status: string | null;
  bucket: string | null;
  repo: string | null;
  branch: string | null;
  /** Always null in practice — upstream leaves it empty. See finding 1. */
  cwd: string | null;
  model: string | null;
  unread: boolean;
  webUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LiveListResult {
  sessions: LiveSession[];
  /** Rows returned after filtering AND the limit. */
  returned: number;
  /** Rows that matched the filter, before the limit. */
  matched: number;
  /** Rows pulled from upstream and examined. */
  scanned: number;
  scannedPages: number;
  /** True when the limit dropped matching rows — `matched > returned`. */
  truncated: boolean;
  /** True when upstream still had pages we did not scan. */
  upstreamHasMore: boolean;
  filter: { live: boolean; kind: SessionKind | 'any'; limit: number; pages: number };
  counts: { localRemoteControl: number; cloud: number; live: number };
  /** Present only when the answer is knowably partial. */
  note?: string;
}

// ── classification ──────────────────────────────────────────────────────────

/**
 * Local bridge vs cloud worker, from `environment_kind` (finding 2).
 * `bridge` = a Claude Code process on someone's machine, driven from the web.
 * `anthropic_cloud` = a container Anthropic runs.
 */
export function classifyKind(s: RawSession): SessionKind {
  switch (s.environment_kind) {
    case 'bridge':
      return 'local-remote-control';
    case 'anthropic_cloud':
      return 'cloud';
    default:
      // Corroborating signal: bridges carry an empty environment_id, cloud
      // sessions carry env_…. Only consulted when environment_kind is absent
      // or a value this build has not seen.
      if (typeof s.environment_id === 'string') return s.environment_id ? 'cloud' : 'local-remote-control';
      return 'unknown';
  }
}

/**
 * HOW the session got connected, from `tags` — free provenance that
 * distinguishes the two connect paths:
 *   `remote-control-auto` → a native `/remote-control` inject (the blind spot
 *      `ccr_remote_list` cannot see, because lm-assist did not spawn it)
 *   `remote-control-repl` → a bridge lm-assist started itself
 */
export function classifyVia(s: RawSession): ConnectVia {
  const tags = s.tags ?? [];
  if (tags.includes('remote-control-auto')) return 'native-inject';
  if (tags.includes('remote-control-repl')) return 'lm-assist-bridge';
  return null;
}

/**
 * Is this session actually usable right now?
 *
 * Requires BOTH axes to agree, because neither is sufficient alone: `archived`
 * rows are frequently still `connection_status: connected` (measured: 67 of
 * them), so trusting `connected` would report long-finished work as live.
 */
export function isLive(s: RawSession): boolean {
  if (s.session_status === 'archived') return false;
  return s.connection_status === 'connected' || s.session_status === 'running' || s.session_status === 'pending';
}

/** Repo + branch from `external_metadata.current_branches` (the populated locator). */
function repoAndBranch(s: RawSession): { repo: string | null; branch: string | null } {
  const branches = s.external_metadata?.current_branches;
  if (branches) {
    const first = Object.keys(branches)[0];
    if (first) return { repo: first, branch: branches[first] ?? null };
  }
  // Fall back to the declared source when no branch has been reported yet.
  const url = s.session_context?.sources?.[0]?.url;
  if (typeof url === 'string' && url) {
    const m = url.match(/github\.com\/([^/]+\/[^/.]+)/);
    return { repo: m ? m[1] : url, branch: s.session_context?.sources?.[0]?.revision ?? null };
  }
  return { repo: null, branch: null };
}

/** Narrow a raw row to the projected shape. Pure. */
export function projectRow(s: RawSession): LiveSession {
  const { repo, branch } = repoAndBranch(s);
  const id = s.id ?? '';
  const cwd = s.session_context?.cwd;
  return {
    id,
    title: s.title ?? null,
    kind: classifyKind(s),
    via: classifyVia(s),
    live: isLive(s),
    connection: s.connection_status ?? null,
    status: s.session_status ?? null,
    bucket: s.status_bucket ?? null,
    repo,
    branch,
    cwd: cwd ? cwd : null,
    model: s.session_context?.model ?? null,
    unread: s.unread === true,
    webUrl: id ? `https://claude.ai/code/${id}` : '',
    createdAt: s.created_at ?? null,
    updatedAt: s.updated_at ?? null,
  };
}

// ── selection ───────────────────────────────────────────────────────────────

export interface LiveListOptions {
  /** Include non-live (archived / disconnected-idle) sessions. Default false. */
  includeArchived?: boolean;
  /** Restrict to one class. Default 'any'. */
  kind?: SessionKind | 'any';
  /** Max rows returned. Default 25, hard ceiling 100. */
  limit?: number;
  /** Upstream pages to scan. Default 1, hard ceiling 5. */
  pages?: number;
}

/**
 * Filter + bound a scanned set. Pure, so the honesty rules (`matched` vs
 * `returned`, `truncated`) are directly testable without a network.
 */
export function selectSessions(
  rows: RawSession[],
  opts: LiveListOptions,
  meta: { scannedPages: number; upstreamHasMore: boolean },
): LiveListResult {
  const wantLive = !opts.includeArchived;
  const wantKind = opts.kind ?? 'any';
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  const pages = Math.max(1, Math.min(MAX_PAGES, Math.floor(opts.pages ?? DEFAULT_PAGES)));

  const projected = rows.map(projectRow);
  const matching = projected.filter((p) => {
    if (wantLive && !p.live) return false;
    if (wantKind !== 'any' && p.kind !== wantKind) return false;
    return true;
  });

  const sessions = matching.slice(0, limit);
  const truncated = matching.length > sessions.length;

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `${matching.length} sessions matched but only ${sessions.length} are shown (limit=${limit}) — raise limit to see the rest.`,
    );
  }
  if (meta.upstreamHasMore) {
    notes.push(
      `Upstream reported more pages beyond the ${meta.scannedPages} scanned (${rows.length} rows) — older sessions were not examined. Raise pages (max ${MAX_PAGES}) to widen.`,
    );
  }

  return {
    sessions,
    returned: sessions.length,
    matched: matching.length,
    scanned: rows.length,
    scannedPages: meta.scannedPages,
    truncated,
    upstreamHasMore: meta.upstreamHasMore,
    filter: { live: wantLive, kind: wantKind, limit, pages },
    counts: {
      localRemoteControl: projected.filter((p) => p.kind === 'local-remote-control').length,
      cloud: projected.filter((p) => p.kind === 'cloud').length,
      live: projected.filter((p) => p.live).length,
    },
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}

// ── transport ───────────────────────────────────────────────────────────────

/**
 * Organization uuid for the `x-organization-uuid` header.
 *
 * Read from `~/.claude.json` first: it is free and offline. `getOrganizationUuid()`
 * in claude-oauth is the fallback, and it costs a network round-trip to
 * `/api/oauth/profile` on first use — worth avoiding when the file is right there.
 */
export function readOrgUuidFromDisk(): string | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8');
    const org = JSON.parse(raw)?.oauthAccount?.organizationUuid;
    return typeof org === 'string' && org ? org : null;
  } catch {
    return null;
  }
}

async function resolveOrgUuid(): Promise<string> {
  const fromDisk = readOrgUuidFromDisk();
  if (fromDisk) return fromDisk;
  const { getOrganizationUuid } = require('../utils/claude-oauth') as typeof import('../utils/claude-oauth');
  return getOrganizationUuid();
}

export interface FetchPageResult { rows: RawSession[]; hasMore: boolean; lastId: string | null }
export type FetchPage = (afterId: string | null) => Promise<FetchPageResult>;

/** One upstream page over the OAuth ingress. */
async function fetchPageLive(afterId: string | null): Promise<FetchPageResult> {
  const org = await resolveOrgUuid();
  const params = new URLSearchParams({ limit: String(UPSTREAM_PAGE_MAX) });
  if (afterId) params.set('after_id', afterId);
  const r = await anthropicOAuthGet(`/v1/sessions?${params}`, {
    betaHeader: CCR_BETA,
    extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org },
    timeoutMs: 20_000,
  });
  if (r.status >= 400) {
    const detail = typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body ?? {}).slice(0, 200);
    throw new Error(`GET /v1/sessions responded ${r.status} ${r.statusText}: ${detail}`);
  }
  const body = r.body as { data?: RawSession[]; has_more?: boolean; last_id?: string };
  return { rows: body?.data ?? [], hasMore: body?.has_more === true, lastId: body?.last_id ?? null };
}

/**
 * List live CCR / remote-control sessions from the account.
 *
 * `fetchPage` is injectable so the paging and bounding logic is testable
 * without a network or a live OAuth token.
 */
export async function listLiveSessions(
  opts: LiveListOptions = {},
  fetchPage: FetchPage = fetchPageLive,
): Promise<LiveListResult> {
  const pages = Math.max(1, Math.min(MAX_PAGES, Math.floor(opts.pages ?? DEFAULT_PAGES)));
  const rows: RawSession[] = [];
  let after: string | null = null;
  let scannedPages = 0;
  let hasMore = false;

  for (let i = 0; i < pages; i++) {
    const page: FetchPageResult = await fetchPage(after);
    scannedPages++;
    rows.push(...page.rows);
    hasMore = page.hasMore;
    if (!page.hasMore || !page.lastId) break;
    after = page.lastId;
  }

  return selectSessions(rows, opts, { scannedPages, upstreamHasMore: hasMore });
}
