/** Pure helpers for the /mcp-tools page (spec §4.6). Mirrors lib/mission-process.ts:
 *  types matching the core payloads + IO-free grouping/badge/count/conflict logic,
 *  vitest-covered in __tests__/mcp-tools.test.ts. */

export type ToolScope = 'read' | 'write' | 'admin';

export interface ToolActorSummary {
  kind?: string;
  channel?: string;
  node?: string | null;
  label?: string;
  at?: number;
}

/** One row of GET /mcp-tools (code catalog joined with the registry delta). */
export interface McpToolRow {
  name: string;
  category: string;
  module: string;
  scope: ToolScope;
  protected: boolean;
  defaultDescription: string;
  effectiveDescription: string;
  enabled: boolean;
  hasOverride: boolean;
  rev?: number;
  lastUpdatedBy?: ToolActorSummary;
  updatedAt?: number;
}

/** Registry doc as served inside GET /mcp-tools/:name. */
export interface ToolRegistryDocView {
  name: string;
  descriptionOverride: string | null;
  enabled: boolean;
  rev: number;
  history: ToolHistoryEntry[];
  lastUpdatedBy?: ToolActorSummary;
  createdAt?: number;
  updatedAt?: number;
}

export interface ToolHistoryEntry {
  rev: number;
  at: number;
  actor: ToolActorSummary;
  state: { descriptionOverride: string | null; enabled: boolean };
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface ToolDetailResponse extends Partial<McpToolRow> {
  name?: string;
  knownTool: boolean;
  def: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown } | null;
  doc: ToolRegistryDocView | null;
  implementation: { module: string; handlerSource: string } | null;
}

export interface McpToolGroup {
  category: string;
  tools: McpToolRow[];
}

/** Group rows by category following the server-provided order; categories not in
 *  the order (e.g. a build-drift 'other') sort last; tools alphabetical inside a
 *  group; empty categories are dropped. */
export function groupTools(rows: McpToolRow[], categoryOrder: string[]): McpToolGroup[] {
  const byCat = new Map<string, McpToolRow[]>();
  for (const r of rows) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  const rank = new Map(categoryOrder.map((c, i) => [c, i]));
  const cats = [...byCat.keys()].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  return cats.map((category) => ({
    category,
    tools: [...byCat.get(category)!].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export interface ToolBadges {
  scope: ToolScope;
  off: boolean;
  override: boolean;
  protected: boolean;
}

export function toolBadges(row: McpToolRow): ToolBadges {
  return { scope: row.scope, off: !row.enabled, override: row.hasOverride, protected: row.protected };
}

export function summarizeCounts(rows: McpToolRow[]): { tools: number; overridden: number; disabled: number } {
  return {
    tools: rows.length,
    overridden: rows.filter((r) => r.hasOverride).length,
    disabled: rows.filter((r) => !r.enabled).length,
  };
}

/** Optimistic-concurrency check before save (mission-process idiom): compare the rev
 *  we loaded against a freshly-fetched doc; a message means someone saved meanwhile.
 *  (Named differently from mission-process.ts's checkRevConflict — same idea,
 *  different return contract; a same-name auto-import would silently misbehave.) */
export function revConflictMessage(loadedRev: number, freshDoc: { rev: number } | null): string | null {
  const freshRev = freshDoc?.rev ?? 0;
  if (freshRev === loadedRev) return null;
  return `This tool's registry doc changed while you were editing (now rev ${freshRev}, you loaded rev ${loadedRev}). Refresh to pick up the latest, then re-apply your edit.`;
}

/** One-line row description: collapse whitespace/newlines, hard-cap with an ellipsis.
 *  Cuts on code points so an astral char (emoji) never splits into a lone surrogate. */
export function truncateDescription(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${[...oneLine].slice(0, max).join('')}…`;
}

// ── tool-loading profile (GET/POST /mcp-tools/profile) ────────────────────────
// A profile names the subset of tools this node ADVERTISES in `tools/list`. It is a
// context-budget control, not a security one: a hidden tool stays callable, and the
// admin gate + TOOL_SCOPES remain the only boundary. The helpers below are the same
// IO-free shape as the ones above — the page does the fetching.

/** One entry of `profiles[]` in GET /mcp-tools/profile. */
export interface McpProfileSummary {
  name: string;
  description: string;
  /** How many tools this profile would advertise ON THIS NODE — resolved against the
   *  live catalog, so it already accounts for plugins that are not installed. */
  tools: number;
  /** Selectors naming nothing here: a typo, or an uninstalled plugin. */
  unmatchedSelectors: string[];
  active: boolean;
}

/** GET /mcp-tools/profile (and the body POST returns). */
export interface McpProfileStatus {
  active: string;
  setAt: number | null;
  setBy: string | null;
  selectors: { categories: string[]; plugins: string[] };
  profiles: McpProfileSummary[];
}

/** Narrow first, so the list reads as a cost ladder rather than as declaration order;
 *  equal sizes fall back to the name so the order is stable across refreshes. */
export function sortProfiles(profiles: McpProfileSummary[]): McpProfileSummary[] {
  return [...profiles].sort((a, b) => (a.tools !== b.tools ? a.tools - b.tools : a.name.localeCompare(b.name)));
}

/** The row for the NODE DEFAULT — the profile the server reports as `active`, which is what
 *  UNPINNED clients get (a connector pinned to a profile URL keeps its own).
 *
 *  Trust `status.active` over the per-row `active` flag, and return null when no row
 *  carries that name: a node running an older build can report a default this build does
 *  not define, and inventing a row for it would state a tool count that was never measured. */
export function activeProfileRow(status: McpProfileStatus | null): McpProfileSummary | null {
  if (!status) return null;
  return status.profiles.find((p) => p.name === status.active) ?? null;
}

/** What making `candidate` the node default would cost or save, relative to the current node
 *  default. Empty for the default row itself and whenever the default is unknown — a delta
 *  against a guess would read as measured. */
export function profileDeltaLabel(active: McpProfileSummary | null, candidate: McpProfileSummary): string {
  if (!active || active.name === candidate.name) return '';
  const d = candidate.tools - active.tools;
  if (d === 0) return 'same size as the node default';
  return d < 0 ? `${-d} fewer than the node default` : `${d} more than the node default`;
}

/** A profile whose selectors do not all match is SMALLER than its description implies —
 *  say which ones missed, because the count alone looks like a deliberate choice. */
export function unmatchedSelectorNote(p: McpProfileSummary): string | null {
  if (!p.unmatchedSelectors?.length) return null;
  return `${p.unmatchedSelectors.join(', ')} — ${p.unmatchedSelectors.length === 1 ? 'this selector matches' : 'these selectors match'} no tool on this node (a typo, or a plugin that is not installed), so this profile advertises less than its description suggests.`;
}

/** Why the profile read failed, in the reader's terms.
 *
 *  There is one failure that does not mean what it says: a node whose Core predates the
 *  profile feature has no `/mcp-tools/profile` route, so the GET falls through to
 *  `GET /mcp-tools/:name` and 404s with `no advertised tool ... named "profile"`. Passed
 *  through verbatim that sends the reader hunting for a missing TOOL. Measured against
 *  this box's prod Core (0.2.4, npm) on 2026-09-09 — the route is dev-only until the next
 *  release, so this is the CURRENT answer on a prod node, not a hypothetical. */
export function profileUnavailableMessage(raw: string): string {
  if (/named\s+["'“]?profile/i.test(raw)) {
    return 'This node’s Core has no /mcp-tools/profile route — it predates the profile feature. '
      + 'The node advertises every tool (the admin default); the control appears once it is upgraded.';
  }
  return `Profile unavailable: ${raw}`;
}

// ── one connector per profile (GET/POST/DELETE /mcp/profile-connectors) ─────
// A connector on a profile URL (`https://mcp.<domain>/mcp/<profile>`) advertises THAT profile
// whatever the node default is; the unpinned `/mcp` URL follows the node default. Core matches
// claude.ai connectors to profiles by URL against this node's own hub. IO-free, like the above.

/** claude.ai's record of one connector, as the table shows it. */
export interface ClaudeAiConnectorState {
  uuid: string;
  name: string;
  connected: boolean;
  /** claude.ai's own word (`authenticated` | `auth_required` | …), passed through. */
  authStatus?: string | null;
  /** Tools claude.ai has loaded for it — 0 or null until it is connected. */
  toolCount?: number | null;
}

/** One row of the Connectors table (normalizeProfileConnectors builds these). */
export interface ProfileConnectorRow {
  /** null = the unpinned `/mcp` URL, which follows the node default. */
  profile: string | null;
  url: string;
  /** The claude.ai name a create uses: `lm-assist <hub> <profile>`. */
  name: string;
  /** claude.ai's connector on this URL, or null when there is none — or when claude.ai could not
   *  be read at all (then `claudeaiError` is set, and null means UNKNOWN). With duplicates, the one
   *  Core reports (connected first). */
  claudeai: ClaudeAiConnectorState | null;
  /** How many MORE claude.ai connectors sit on this same URL. Absent when there are none. Delete
   *  removes every one of them, so the UI must say how many. */
  duplicates?: number;
  /** Pinned to a profile this node does not know (a typo such as `/mcp/basci`, or a newer build's
   *  profile). It is served the NODE DEFAULT (spec §3: fail open, visibly) — so it is shown, and
   *  offered Delete only (never Create). */
  unknown?: true;
}

/** The Connectors table's model: one flat row list, the unpinned row as `profile: null`. */
export interface ProfileConnectorsStatus {
  /** This node's public MCP base (`https://mcp.<domain>`); null when the node has no hub. */
  base: string | null;
  nodeDefault: string;
  connectors: ProfileConnectorRow[];
  claudeaiError?: string | null;
}

// The REST body (GET /mcp/profile-connectors) keeps the unpinned connector and the
// per-profile rows in separate fields, because the mcp_connectors tool renders from that richer
// shape. The page and the pane want one row list, so this is the ONE place the wire shape
// becomes the table model — never read the wire fields anywhere else.
export type WireConn = { uuid: string | null; name: string; connected: boolean; authStatus: string | null; toolCount: number | null };
export interface ProfileConnectorsWire {
  base: string; hub: string; nodeDefault: string; claudeai: { ok: boolean; error?: string };
  unpinned: { url: string; suggestedName: string; connector: WireConn | null; duplicates: number };
  profiles: Array<{ profile: string; url: string; suggestedName: string; connector: WireConn | null; duplicates: number }>;
  unknownPins: Array<{ profile: string; url: string; connector: WireConn | null }>;
}
export function normalizeProfileConnectors(w: ProfileConnectorsWire): ProfileConnectorsStatus {
  const state = (c: WireConn | null): ClaudeAiConnectorState | null => (c ? { ...c, uuid: c.uuid ?? '' } : null);
  const row = (profile: string | null, r: { url: string; suggestedName: string; connector: WireConn | null; duplicates?: number }): ProfileConnectorRow => ({
    profile, url: r.url, name: r.suggestedName, claudeai: state(r.connector),
    ...(r.duplicates ? { duplicates: r.duplicates } : {}),
  });
  // The wire lists each unknown-pin connector on its own; the table has one row per URL, so group
  // them by profile — the connected one shown, the rest counted as duplicates.
  const byPin = new Map<string, Array<{ url: string; connector: WireConn | null }>>();
  for (const u of w.unknownPins || []) byPin.set(u.profile, [...(byPin.get(u.profile) || []), u]);
  const unknownRows = [...byPin.entries()].map(([profile, list]): ProfileConnectorRow => {
    const best = [...list].sort((a, b) => Number(!!b.connector?.connected) - Number(!!a.connector?.connected))[0];
    return {
      profile, url: best.url, name: best.connector?.name ?? '', claudeai: state(best.connector), unknown: true,
      ...(list.length > 1 ? { duplicates: list.length - 1 } : {}),
    };
  });
  return { base: w.base || null, nodeDefault: w.nodeDefault,
    claudeaiError: w.claudeai.ok ? null : (w.claudeai.error || 'claude.ai unreadable'),
    connectors: [row(null, w.unpinned), ...w.profiles.map((p) => row(p.profile, p)), ...unknownRows] };
}

/** A node with no hub has no public MCP URL, and the GET refuses with `HUB_NOT_CONFIGURED`
 *  (HTTP 400). `errText` keeps only the message, so test the RAW error string for the code. */
export function profileConnectorsHubMissing(raw: string): boolean {
  return /\bHUB_NOT_CONFIGURED\b/.test(raw);
}

/** What the table shows for such a node: no base, no rows — "no hub on this node". */
export function noHubProfileConnectors(): ProfileConnectorsStatus {
  return { base: null, nodeDefault: '', connectors: [], claudeaiError: null };
}

/** The envelope-free GET body → the table model. A body that is not the wire shape (an error
 *  envelope a transport passed through as data, or a shape this build does not know) THROWS with
 *  the body in the message, so the caller's HUB_NOT_CONFIGURED / route-missing checks still see
 *  its code — instead of the page crashing on `w.claudeai.ok`. */
export function parseProfileConnectors(body: unknown): ProfileConnectorsStatus {
  const w = body as Partial<ProfileConnectorsWire> | null;
  if (!w || typeof w !== 'object' || !w.unpinned || !Array.isArray(w.profiles) || !w.claudeai) {
    throw new Error(`unexpected /mcp/profile-connectors body: ${String(JSON.stringify(body)).slice(0, 400)}`);
  }
  return normalizeProfileConnectors(w as ProfileConnectorsWire);
}

/** POST /mcp/profile-connectors {profile}. Idempotent by URL: `created:false` means a
 *  connector on that URL already existed and is returned as-is. */
export interface ProfileConnectorCreateResult {
  profile: string;
  url: string;
  created: boolean;
  /** `uuid` is null when claude.ai's create response named none and the re-list missed it. */
  connector: WireConn;
  /** The one step left, in the reader's terms; null when the connector exists AND is connected. */
  nextStep?: string | null;
}

/** DELETE /mcp/profile-connectors/:profile — every claude.ai connector on that URL (duplicates
 *  included). `failed` is non-empty when some could not be removed; those still exist. */
export interface ProfileConnectorDeleteResult {
  profile: string;
  url: string;
  removed: Array<{ uuid: string; name: string }>;
  failed: Array<{ uuid: string; error: string }>;
}

/** GET /claude-ai/mcp/servers row, as far as the older-Core status fallback needs it. */
export interface ClaudeAiServerRow {
  name?: string;
  url?: string;
  connected?: boolean;
  toolCount?: number;
  tools?: string[];
}

export interface ConnectorStatusLine {
  label: string;
  ok: boolean | null;
  detail: string;
}

export type ConnectorTone = 'ok' | 'warn' | 'none' | 'unknown';

/** claude.ai generates the OAuth `state` in-page, so Connect cannot be completed server-side. */
export const CONNECT_STEP = 'claude.ai → Customize → Connectors → Connect on that connector';

/** An older Core has no /mcp/profile-connectors and no `/mcp/<x>` catch-all, so every method on
 *  it gets rest-server's generic 404: code `NOT_FOUND`, message
 *  `Route not found: GET /mcp/profile-connectors`. That means "this Core predates the feature":
 *  hide the table and post nothing to it. Only that message counts. A `NOT_FOUND` from the route
 *  itself (a DELETE with nothing on the URL) is a real error, not a missing route. Matches the
 *  `errText` message and a raw `API 404: {…}` string alike. */
export function profileConnectorsRouteMissing(raw: string): boolean {
  return /Route not found:\s*[A-Z]+\s+\/mcp\/profile-connectors(?![\w-])/.test(raw);
}

/** Unpinned first (the connector every existing conversation uses), then narrow → wide by what
 *  each profile advertises on this node, profiles with no count last, ties by name. */
export function orderConnectorRows(rows: ProfileConnectorRow[], profiles: McpProfileSummary[] = []): ProfileConnectorRow[] {
  const size = new Map(profiles.map((p) => [p.name, p.tools] as const));
  const rank = (r: ProfileConnectorRow): number =>
    r.profile === null ? -1 : size.get(r.profile) ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : (a.profile ?? '').localeCompare(b.profile ?? '');
  });
}

/** The claude.ai cell. `claudeai: null` means "not created" only when claude.ai was READ — with
 *  `claudeaiError` set it means nobody knows, and "not created" would invite a duplicate. */
export function connectorStateLabel(
  row: ProfileConnectorRow,
  claudeaiError?: string | null,
): { text: string; tone: ConnectorTone } {
  const c = row.claudeai;
  if (!c) {
    return claudeaiError
      ? { text: 'unknown — claude.ai could not be read', tone: 'unknown' }
      : { text: 'not created', tone: 'none' };
  }
  const dup = duplicatesNote(row);
  if (row.unknown) {
    return {
      text: `pinned to a profile this node does not know — served the node default · ${c.connected ? 'connected' : 'not connected'}${dup}`,
      tone: 'warn',
    };
  }
  if (c.connected) return { text: `connected${c.toolCount != null ? ` · ${c.toolCount} tools` : ''}${dup}`, tone: 'ok' };
  return { text: `not connected${c.authStatus ? ` (${c.authStatus})` : ''} — ${CONNECT_STEP}${dup}`, tone: 'warn' };
}

/** ` (+N duplicate[s])` — or '' — for a row whose URL carries several claude.ai connectors. */
export function duplicatesNote(row: ProfileConnectorRow): string {
  const n = row.duplicates ?? 0;
  return n > 0 ? ` (+${n} duplicate${n === 1 ? '' : 's'})` : '';
}

/** The Delete confirmation: names the connector and, with duplicates, that ALL of them go. */
export function deleteConfirmLabel(row: ProfileConnectorRow): string {
  const n = row.duplicates ?? 0;
  const name = row.claudeai?.name || row.name || row.url;
  return n > 0
    ? `Delete "${name}" and its ${n} duplicate${n === 1 ? '' : 's'} (${n + 1} connectors) from claude.ai?`
    : `Delete "${name}" from claude.ai?`;
}

/** The outcome line for a delete — how many went, and any that could not be removed. */
export function deleteConnectorMessage(profile: string, r?: Partial<ProfileConnectorDeleteResult> | null): string {
  const n = r?.removed?.length ?? 1;
  const failed = r?.failed ?? [];
  const what = n === 1 ? `the ${profile} connector` : `${n} connectors on the ${profile} URL (duplicates included)`;
  return `Deleted ${what} from claude.ai. Conversations that had it lose its tools.`
    + (failed.length ? ` ${failed.length} could not be deleted and still exist${failed.length === 1 ? 's' : ''}: ${failed.map((f) => `${f.uuid} (${f.error})`).join('; ')}.` : '');
}

/** Which button a row offers. The unpinned connector is never created or deleted from here —
 *  it is the one every existing conversation uses. Nothing is offered while claude.ai is
 *  unreadable, and only one write runs at a time: the hub registers each connector with a
 *  read-modify-write, and two at once can lose one. */
export function connectorActions(
  row: ProfileConnectorRow,
  ctx: { claudeaiError?: string | null; busy: string | null },
): { create: boolean; remove: boolean; disabled: boolean } {
  if (row.profile === null || ctx.claudeaiError) return { create: false, remove: false, disabled: true };
  // An unknown pin is never created from here (Core refuses the name) — only removed.
  return { create: !row.claudeai && !row.unknown, remove: !!row.claudeai, disabled: ctx.busy !== null };
}

/** The outcome line for a create — always names what is still left to do. */
export function createConnectorMessage(r: ProfileConnectorCreateResult): string {
  const step = (r.nextStep || CONNECT_STEP).replace(/\.\s*$/, '');
  const name = r.connector?.name || r.url;
  if (!r.created) {
    return r.connector?.connected
      ? `"${name}" already exists for ${r.url} and is connected — nothing to do.`
      : `"${name}" already exists for ${r.url} — nothing created. One step left: ${step}.`;
  }
  return `Created "${name}" for the ${r.profile} profile. One step left: ${step}.`;
}

/** Patch the row a create answered for, so the table updates without another claude.ai read.
 *  The wire `uuid` may be null; the row keeps '' — the next read names it. */
export function applyCreateResult(status: ProfileConnectorsStatus, r: ProfileConnectorCreateResult): ProfileConnectorsStatus {
  const claudeai: ClaudeAiConnectorState = { ...r.connector, uuid: r.connector.uuid ?? '' };
  return {
    ...status,
    connectors: status.connectors.map((row) => (row.profile === r.profile ? { ...row, claudeai } : row)),
  };
}

/** A delete removes EVERY connector on that URL: the row loses its connector and its duplicates,
 *  and an unknown-pin row (which exists only because a connector does) is dropped. */
export function applyDeleteResult(status: ProfileConnectorsStatus, profile: string): ProfileConnectorsStatus {
  return {
    ...status,
    connectors: status.connectors.flatMap((row) => {
      if (row.profile !== profile) return [row];
      if (row.unknown) return [];
      const cleared: ProfileConnectorRow = { ...row, claudeai: null };
      delete cleared.duplicates;
      return [cleared];
    }),
  };
}

/** The Status panel's connector lines: one per lm-assist connector of THIS hub that exists in
 *  claude.ai, replacing the old first-/langmart/i pick that showed one and hid the rest. That
 *  includes a connector pinned to a profile this node does not know (served the node default —
 *  shown as not OK, since it is not getting what its URL asks for), and a duplicate count. */
export function connectorStatusLines(status: ProfileConnectorsStatus): ConnectorStatusLine[] {
  if (status.claudeaiError) return [{ label: 'Connector', ok: false, detail: `claude.ai unreadable — ${status.claudeaiError}` }];
  if (!status.base) return [{ label: 'Connector', ok: null, detail: 'no hub on this node, so no connector URL' }];
  const existing = status.connectors.filter((r) => r.claudeai);
  if (!existing.length) return [{ label: 'Connector', ok: false, detail: `none in claude.ai for ${status.base}` }];
  return existing.map((r) => {
    const c = r.claudeai as ClaudeAiConnectorState;
    const state = c.connected ? 'connected' : `not connected${c.authStatus ? ` (${c.authStatus})` : ''}`;
    const tools = c.connected && c.toolCount != null ? ` · ${c.toolCount} tools` : '';
    return {
      label: r.profile ? `Connector · ${r.profile}${r.unknown ? ' (unknown profile)' : ''}` : 'Connector',
      ok: r.unknown ? false : c.connected,
      detail: `${c.name || r.name} · ${state}${tools}${r.unknown ? ' · pinned to a profile this node does not know — served the node default' : ''}${duplicatesNote(r)}`,
    };
  });
}

/** An older Core: the single pick the Status panel has always shown (first url/name matching
 *  /langmart/i, else the first server). Kept only for that fallback. */
export function legacyConnectorLine(servers: ClaudeAiServerRow[]): ConnectorStatusLine {
  const lm = servers.find((x) => /langmart/i.test(x.url || '') || /langmart/i.test(x.name || '')) || servers[0];
  if (!lm) return { label: 'Connector', ok: false, detail: 'no connector' };
  const n = lm.toolCount ?? lm.tools?.length;
  return {
    label: 'Connector',
    ok: !!lm.connected,
    detail: `${lm.name || 'langmart'} · ${lm.connected ? 'connected' : 'disconnected'}${n != null ? ` · ${n} tools` : ''}`,
  };
}
