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
 *  we loaded against a freshly-fetched doc; a message means someone saved meanwhile. */
export function checkRevConflict(loadedRev: number, freshDoc: { rev: number } | null): string | null {
  const freshRev = freshDoc?.rev ?? 0;
  if (freshRev === loadedRev) return null;
  return `This tool's registry doc changed while you were editing (now rev ${freshRev}, you loaded rev ${loadedRev}). Refresh to pick up the latest, then re-apply your edit.`;
}

/** One-line row description: collapse whitespace/newlines, hard-cap with an ellipsis. */
export function truncateDescription(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}
