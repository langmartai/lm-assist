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

/** The row for the profile the server says is active.
 *
 *  Trust `status.active` over the per-row `active` flag, and return null when no row
 *  carries that name: a node running an older build can report an active profile this
 *  build does not define, and inventing a row for it would state a tool count that was
 *  never measured. */
export function activeProfileRow(status: McpProfileStatus | null): McpProfileSummary | null {
  if (!status) return null;
  return status.profiles.find((p) => p.name === status.active) ?? null;
}

/** What switching would cost or save, relative to what is advertised now. Empty for the
 *  active row itself and whenever the active row is unknown — a delta against a guess
 *  would read as measured. */
export function profileDeltaLabel(active: McpProfileSummary | null, candidate: McpProfileSummary): string {
  if (!active || active.name === candidate.name) return '';
  const d = candidate.tools - active.tools;
  if (d === 0) return 'same size';
  return d < 0 ? `${-d} fewer advertised` : `${d} more advertised`;
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
