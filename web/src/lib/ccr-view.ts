/**
 * The ONE filter/sort engine for the CCR page. Both the left sidebar (Recents)
 * and the main-pane session list derive their order from the SAME persisted
 * view state and the SAME comparator — there is deliberately no second filter
 * logic anywhere on the page.
 *
 * Rules (as specified by the user across iterations):
 *  - category (all/cloud/remote/local) is a PRIORITY, not a hide: everything
 *    stays visible, the chosen category floats to the top / renders first.
 *  - node is a per-node FILTER over node-attributed rows; account-wide cloud
 *    rows (node=null) are accessible from every machine so they stay visible.
 *    Default is 'all' machines. Picking a node NEVER navigates anywhere.
 *  - status is an explicit opt-in HIDE filter.
 *  - every ordering ends in the STABLE row key so the order changes only when
 *    the data changes (a tie falling back to API array order reshuffles the
 *    DOM every poll — the "list keeps refreshing" class of bug).
 */
import { ccrStatusPill } from './ccr-status';
import type { CcrRow } from '@/components/ccr/ccrTypes';

export type CcrCategory = 'all' | 'cloud' | 'remote' | 'local';
export type CcrSort = 'recency' | 'name';

export interface CcrView {
  category: CcrCategory;
  /** 'all' or a gateway-id present in the fleet payload. */
  node: string;
  /** 'all' or a status pill label (Working, Needs input, …). */
  status: string;
  sort: CcrSort;
}

export const DEFAULT_CCR_VIEW: CcrView = { category: 'all', node: 'all', status: 'all', sort: 'recency' };

export const CCR_VIEW_KEY = 'ccr-view';
const LEGACY_KEYS = ['ccr-list-filter', 'ccr-side-env', 'ccr-side-status', 'ccr-side-sort'];

const CATS: CcrCategory[] = ['all', 'cloud', 'remote', 'local'];

export function loadCcrView(): CcrView {
  if (typeof window === 'undefined') return DEFAULT_CCR_VIEW;
  try {
    const raw = window.localStorage.getItem(CCR_VIEW_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CcrView>;
      return {
        category: CATS.includes(p.category as CcrCategory) ? (p.category as CcrCategory) : 'all',
        node: typeof p.node === 'string' && p.node ? p.node : 'all',
        status: typeof p.status === 'string' && p.status ? p.status : 'all',
        sort: p.sort === 'name' ? 'name' : 'recency',
      };
    }
    // One-time migration from the pre-unification per-pane keys.
    const legacyCat = window.localStorage.getItem('ccr-side-env') || window.localStorage.getItem('ccr-list-filter');
    const v: CcrView = {
      ...DEFAULT_CCR_VIEW,
      category: CATS.includes(legacyCat as CcrCategory) ? (legacyCat as CcrCategory) : 'all',
      status: window.localStorage.getItem('ccr-side-status') || 'all',
      sort: window.localStorage.getItem('ccr-side-sort') === 'name' ? 'name' : 'recency',
    };
    for (const k of LEGACY_KEYS) window.localStorage.removeItem(k);
    return v;
  } catch {
    return DEFAULT_CCR_VIEW;
  }
}

export function saveCcrView(v: CcrView): void {
  try { window.localStorage.setItem(CCR_VIEW_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

const ms = (t?: string | null) => (t ? Date.parse(t) || 0 : 0);
const live = (r: CcrRow) => (r.status && (r.status as { live?: boolean }).live ? 0 : 1);

/** status hide + node filter (cloud/null rows always pass — they're account-wide). */
export function filterRows(rows: CcrRow[], view: CcrView): CcrRow[] {
  let out = rows;
  if (view.status !== 'all') out = out.filter((r) => ccrStatusPill(r.status).label === view.status);
  if (view.node !== 'all') out = out.filter((r) => !r.node || r.node === view.node);
  return out;
}

/** Total, deterministic comparator: recency/name → live-first → stable key. */
function cmpBase(view: CcrView) {
  return (a: CcrRow, b: CcrRow): number =>
    (view.sort === 'name'
      ? a.title.localeCompare(b.title)
      : ms(b.time) - ms(a.time) || live(a) - live(b)) || a.key.localeCompare(b.key);
}

const prio = (chosen: string, actual: string | null | undefined, all: string) =>
  chosen === all ? 0 : actual === chosen ? 0 : 1;

/**
 * Flat ordering for the sidebar Recents: chosen node first, then chosen
 * category first, then the base sort. Nothing is hidden except `status`.
 */
export function orderRows(rows: CcrRow[], view: CcrView): CcrRow[] {
  const cmp = cmpBase(view);
  return [...filterRows(rows, view)].sort((a, b) =>
    prio(view.node, a.node, 'all') - prio(view.node, b.node, 'all')
    || prio(view.category, a.kind, 'all') - prio(view.category, b.kind, 'all')
    || cmp(a, b));
}

export const KIND_ORDER: Array<CcrRow['kind']> = ['cloud', 'remote', 'local'];

/**
 * Grouped ordering for the main list: same filters, same comparator, groups
 * by category with the chosen one first. Empty groups are dropped.
 */
export function groupRows(rows: CcrRow[], view: CcrView): Array<{ kind: CcrRow['kind']; rows: CcrRow[] }> {
  const filtered = filterRows(rows, view);
  const cmp = cmpBase(view);
  const kinds = view.category !== 'all'
    ? [view.category, ...KIND_ORDER.filter((k) => k !== view.category)]
    : KIND_ORDER;
  return kinds
    .map((kind) => ({
      kind,
      rows: filtered.filter((r) => r.kind === kind).sort((a, b) =>
        prio(view.node, a.node, 'all') - prio(view.node, b.node, 'all') || cmp(a, b)),
    }))
    .filter((g) => g.rows.length > 0);
}

/** Category counts for the main list's tabs (after status+node filtering). */
export function categoryCounts(rows: CcrRow[], view: CcrView): Record<CcrCategory, number> {
  const filtered = filterRows(rows, view);
  return {
    all: filtered.length,
    cloud: filtered.filter((r) => r.kind === 'cloud').length,
    remote: filtered.filter((r) => r.kind === 'remote').length,
    local: filtered.filter((r) => r.kind === 'local').length,
  };
}
