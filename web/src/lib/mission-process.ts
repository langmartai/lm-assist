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
export const NAMESPACE_ORDER = ['process', 'controller', 'onboard', 'drive', 'wrapup', 'recover', 'observe', 'case'] as const;

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

/** Doc-id pattern for link navigation (mission contract). Greedy over dots/hyphens —
 *  callers trim trailing `.`/`-` against the registry before deciding a match. */
export const DOC_ID_RE = /(?:controller|onboard|drive|case|wrapup|recover|observe|process)\.[a-z0-9][a-z0-9.-]*/g;

const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * Rewrite known doc ids in markdown into `[id](#doc:id)` links for click-to-open
 * navigation. Skips fenced code blocks entirely (mermaid node labels contain doc
 * ids) and inline code spans unless the span is exactly one known id.
 */
export function linkifyDocIds(markdown: string, knownIds: ReadonlySet<string>): string {
  const out: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  const flush = () => {
    if (prose.length) out.push(linkifyProse(prose.join('\n'), knownIds));
    prose = [];
  };
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      if (!inFence) flush();
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** Linkify one non-fenced chunk: handle inline code spans, then bare ids. */
function linkifyProse(text: string, knownIds: ReadonlySet<string>): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1);
        return knownIds.has(inner) ? `[${part}](#doc:${inner})` : part;
      }
      return linkifyBareIds(part, knownIds);
    })
    .join('');
}

function linkifyBareIds(text: string, knownIds: ReadonlySet<string>): string {
  DOC_ID_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = DOC_ID_RE.exec(text))) {
    const start = m.index;
    // left boundary: never link a substring of a longer token (e.g. supercase.index)
    const prev = start > 0 ? text[start - 1] : '';
    const bounded = !prev || !/[a-z0-9._-]/i.test(prev);
    // the greedy pattern swallows sentence dots — trim `.`/`-` until the registry knows the id
    let cand = m[0];
    let tail = '';
    while (cand && !knownIds.has(cand) && /[.-]$/.test(cand)) {
      tail = cand.slice(-1) + tail;
      cand = cand.slice(0, -1);
    }
    if (bounded && knownIds.has(cand)) {
      out += text.slice(last, start) + `[${cand}](#doc:${cand})` + tail;
      last = start + m[0].length;
    }
  }
  return out + text.slice(last);
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
