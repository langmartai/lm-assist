/** Pure helpers for the /assist-content page (design §6). Mirrors lib/mission-process.ts
 *  and lib/mcp-tools.ts: types matching the core payloads + IO-free grouping/badge
 *  logic, vitest-covered in __tests__/assist-content.test.ts. The rev-conflict check is
 *  the imported, already-tested `checkRevConflict` from lib/mission-process. */

export type ContentGroup = 'bootstrap' | 'guide';

export interface ContentActorSummary {
  kind?: string;
  channel?: string;
  node?: string | null;
  label?: string;
  at?: number;
}

/** One row of GET /assist-content (code catalog joined with the registry delta). */
export interface ContentUnitRow {
  id: string;
  group: ContentGroup;
  key: string;
  title: string;
  renderedIn: ReadonlyArray<'bootstrap' | 'guide'>;
  hasBlurb: boolean;
  defaultBytes: number;
  hasOverride: boolean;
  hasBlurbOverride: boolean;
  overrideBytes?: number;
  rev?: number;
  lastUpdatedBy?: ContentActorSummary;
  updatedAt?: number;
}

export interface ContentHistoryEntry {
  rev: number;
  at: number;
  actor: ContentActorSummary;
  state: { contentOverride: string | null; blurbOverride: string | null };
  changes: Record<string, { from: unknown; to: unknown }>;
}

/** Registry doc as served inside GET /assist-content/:id. */
export interface ContentDocView {
  name: string;
  contentOverride: string | null;
  blurbOverride: string | null;
  rev: number;
  history: ContentHistoryEntry[];
  lastUpdatedBy?: ContentActorSummary;
  createdAt?: number;
  updatedAt?: number;
}

export interface ContentDetailResponse extends Partial<ContentUnitRow> {
  id?: string;
  knownUnit: boolean;
  defaultBody: string | null;
  defaultBlurb?: string | null;
  doc: ContentDocView | null;
  effectiveBody: string | null;
  effectiveBlurb?: string | null;
}

export interface ContentGroupRows {
  group: string;
  rows: ContentUnitRow[];
}

/** Group rows by content group following the server-provided group order (unknown
 *  groups sort last, alphabetical); row order WITHIN a group preserves the server
 *  list order (it mirrors the rendering order of bootstrap/guide, which is more
 *  meaningful here than alphabetics). Empty groups are dropped. */
export function groupContentUnits(rows: ContentUnitRow[], groupOrder: readonly string[]): ContentGroupRows[] {
  const byGroup = new Map<string, ContentUnitRow[]>();
  for (const r of rows) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }
  const rank = new Map(groupOrder.map((g, i) => [g, i]));
  const groups = [...byGroup.keys()].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  return groups.map((group) => ({ group, rows: byGroup.get(group)! }));
}

export interface ContentBadges {
  stored: boolean;
  override: boolean;
  blurbOverride: boolean;
  inBootstrap: boolean;
}

export function contentBadges(row: ContentUnitRow): ContentBadges {
  return {
    stored: row.rev != null,
    override: row.hasOverride,
    blurbOverride: row.hasBlurbOverride,
    inBootstrap: row.renderedIn.includes('bootstrap'),
  };
}

export function summarizeContentCounts(rows: ContentUnitRow[]): { units: number; overridden: number } {
  return {
    units: rows.length,
    overridden: rows.filter((r) => r.hasOverride || r.hasBlurbOverride).length,
  };
}

/** Human byte size for the editor's cap counter ("512 B", "1.5 KB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  return `${kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
}

/** UTF-8 byte length (mirrors the server-side cap check). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}
