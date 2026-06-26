/** Pure attribute filter over missions — the data_query op vocabulary + tag-dimension/array semantics. No IO. */
import type { Mission } from './mission-model';
import { globToRegExp, isDangerousPattern, safeTest } from '../data/backends/query-filter';

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'regex' | 'wildcard' | 'exists';
export interface MissionFilter { field: string; op: FilterOp; value: unknown; flags?: string; }
export interface MissionSort { field: string; dir: 'asc' | 'desc'; }

export class FilterError extends Error {
  constructor(public code: 'BAD_FILTER_OP' | 'BAD_REGEX', message: string) { super(message); this.name = 'FilterError'; }
}

const OP_ALIAS: Record<string, FilterOp> = { '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt', '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne' };

/** Resolve a filter/sort field to a mission value. `tags.<dim>` → that dimension's string[]; else the top-level field. */
export function missionFieldValue(m: Mission, field: string): unknown {
  if (field.startsWith('tags.')) return (m.tags ?? {})[field.slice(5)];
  return (m as unknown as Record<string, unknown>)[field];
}

function reFor(kind: 'regex' | 'wildcard', value: string, flags?: string): RegExp {
  let re: RegExp;
  try { re = kind === 'wildcard' ? globToRegExp(value, { flags }) : new RegExp(value, flags); }
  catch { throw new FilterError('BAD_REGEX', `invalid ${kind}: ${value}`); }
  if (isDangerousPattern(re.source)) throw new FilterError('BAD_REGEX', `unsafe ${kind}: ${value}`);
  return re;
}

function matchOne(v: unknown, fr: MissionFilter): boolean {
  const op = OP_ALIAS[fr.op as string] ?? fr.op;
  const isArr = Array.isArray(v);
  switch (op) {
    case 'exists': return (isArr ? (v as unknown[]).length > 0 : v !== undefined && v !== null) === Boolean(fr.value);
    case 'contains':
      if (isArr) return (v as unknown[]).includes(fr.value);
      return typeof v === 'string' && typeof fr.value === 'string' && v.toLowerCase().includes(fr.value.toLowerCase());
    case 'in':
      if (!Array.isArray(fr.value)) return false;
      return isArr ? (v as unknown[]).some((x) => (fr.value as unknown[]).includes(x)) : (fr.value as unknown[]).includes(v);
    case 'nin':
      if (!Array.isArray(fr.value)) return false;
      return isArr ? !(v as unknown[]).some((x) => (fr.value as unknown[]).includes(x)) : !(fr.value as unknown[]).includes(v);
    case 'eq': return fr.value === null ? v === undefined || v === null : v === fr.value;
    case 'ne': return fr.value === null ? !(v === undefined || v === null) : v !== fr.value;
    case 'gt': return (v as never) > (fr.value as never);
    case 'gte': return (v as never) >= (fr.value as never);
    case 'lt': return (v as never) < (fr.value as never);
    case 'lte': return (v as never) <= (fr.value as never);
    case 'regex': return safeTest(reFor('regex', String(fr.value), fr.flags), String(v));
    case 'wildcard': return safeTest(reFor('wildcard', String(fr.value), fr.flags), String(v));
    default: throw new FilterError('BAD_FILTER_OP', `unknown filter op: ${fr.op}`);
  }
}

export function filterMissions(missions: Mission[], filter?: MissionFilter[], opts?: { sort?: MissionSort[]; limit?: number }): Mission[] {
  let out = missions;
  if (filter?.length) out = out.filter((m) => filter.every((fr) => matchOne(missionFieldValue(m, fr.field), fr)));
  if (opts?.sort?.length) {
    const s = opts.sort;
    out = out.slice().sort((a, b) => {
      for (const { field, dir } of s) {
        const av = missionFieldValue(a, field) as never, bv = missionFieldValue(b, field) as never;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }
  if (opts?.limit != null) out = out.slice(0, opts.limit);
  return out;
}
