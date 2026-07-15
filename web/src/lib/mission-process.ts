/**
 * Pure helpers for the Mission Processes page (/mission-processes):
 * namespace grouping of workflow docs, case.index cue parsing, invariant-preamble
 * splitting, and the save-time rev-conflict check. No IO — vitest-covered.
 */

/** Actor stamp as returned by the core workflow registry (subset the UI shows). */
export interface WorkflowActorSummary {
  kind?: string;
  channel?: string;
  id?: string | null;
  node?: string | null;
  label?: string;
  at?: number;
}

/** Stored workflow doc as returned by GET /mission/workflows (list) / :id (detail). */
export interface WorkflowDocSummary {
  id: string;
  title: string;
  body?: string;
  editPolicy: 'open' | 'human-only';
  rev: number;
  createdBy?: WorkflowActorSummary;
  lastUpdatedBy?: WorkflowActorSummary;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProcessRow {
  id: string;
  kind: 'stored' | 'default';
  doc?: WorkflowDocSummary;
}

export interface ProcessGroup {
  ns: string;
  rows: ProcessRow[];
}

/** Known namespaces in display order; anything else lands in 'other' (always last). */
export const NAMESPACE_ORDER = ['controller', 'onboard', 'drive', 'wrapup', 'recover', 'observe', 'case'] as const;

/**
 * Group stored docs + un-seeded default ids by namespace prefix (text before the first dot).
 * Groups follow NAMESPACE_ORDER (+ 'other'); empty groups are omitted; rows sort by id.
 * A stored doc wins over a same-id entry in `defaults`.
 */
export function groupWorkflows(workflows: WorkflowDocSummary[], defaults: string[]): ProcessGroup[] {
  const byNs = new Map<string, ProcessRow[]>();
  const add = (row: ProcessRow) => {
    const dot = row.id.indexOf('.');
    const prefix = dot > 0 ? row.id.slice(0, dot) : '';
    const ns = (NAMESPACE_ORDER as readonly string[]).includes(prefix) ? prefix : 'other';
    const rows = byNs.get(ns) ?? [];
    rows.push(row);
    byNs.set(ns, rows);
  };
  const stored = new Set<string>();
  for (const w of workflows) {
    stored.add(w.id);
    add({ id: w.id, kind: 'stored', doc: w });
  }
  for (const id of defaults) {
    if (!stored.has(id)) add({ id, kind: 'default' });
  }
  return [...NAMESPACE_ORDER, 'other']
    .filter((ns) => byNs.has(ns))
    .map((ns) => ({ ns, rows: byNs.get(ns)!.sort((a, b) => a.id.localeCompare(b.id)) }));
}

/** One `case.<slug> <dash> <cue>` row per line; em/en dash, `--`, or `-` separators. */
const CASE_ROW_RE = /^\s*(case\.[a-z0-9][a-z0-9.-]*)\s+(?:—|–|--|-)\s+(.+?)\s*$/;

/** Parse case.index body rows into an id→RECOGNIZE-cue map (later duplicates win). */
export function parseCaseIndex(body: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  for (const line of body.split('\n')) {
    const m = CASE_ROW_RE.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const PREAMBLE_END = '⟦/INVARIANTS⟧';

/**
 * Split rendered playbook text into the non-editable invariant preamble (marker line
 * included) and the doc body. Text without the marker is all body.
 */
export function splitRenderedPreamble(rendered: string): { preamble: string; body: string } {
  const i = rendered.indexOf(PREAMBLE_END);
  if (i < 0) return { preamble: '', body: rendered };
  const end = i + PREAMBLE_END.length;
  return { preamble: rendered.slice(0, end), body: rendered.slice(end).replace(/^\n+/, '') };
}

/**
 * Save-time optimistic-concurrency check: compare the rev remembered at load time
 * against a just-re-fetched doc. An un-stored default counts as rev 0.
 */
export function checkRevConflict(
  loadedRev: number,
  fresh: { rev: number } | null | undefined,
): { conflict: boolean; freshRev: number } {
  const freshRev = fresh?.rev ?? 0;
  return { conflict: freshRev !== loadedRev, freshRev };
}
