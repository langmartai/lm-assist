// core/src/data/backends/query-filter.ts
// Shared in-memory filter/sort/limit logic for backends that don't push these
// down to a native engine (cache = LMDB range scan; vector = post-fetch over docs).
import type { DataRecord, QuerySpec, QueryFilter } from '../types';

export function getField(rec: DataRecord, field: string): unknown {
  if (rec.fields && field in rec.fields) return rec.fields[field];
  if (rec.metadata && field in rec.metadata) return rec.metadata[field];
  return (rec as unknown as Record<string, unknown>)[field];
}

export function matches(rec: DataRecord, f: QueryFilter): boolean {
  const v = getField(rec, f.field);
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'ne': return v !== f.value;
    case 'gt': return (v as any) > (f.value as any);
    case 'gte': return (v as any) >= (f.value as any);
    case 'lt': return (v as any) < (f.value as any);
    case 'lte': return (v as any) <= (f.value as any);
    case 'in': return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
    case 'contains': return typeof v === 'string' && typeof f.value === 'string' && v.includes(f.value);
    default: return false;
  }
}

/** Apply a QuerySpec's filter + sort + offset/limit to an in-memory row set. `total` is the count after filtering, before pagination. */
export function applyQuery(rows: DataRecord[], q: QuerySpec): { records: DataRecord[]; total?: number } {
  let out = rows;
  if (q.filter?.length) out = out.filter((r) => q.filter!.every((f) => matches(r, f)));
  if (q.sort?.length) {
    const s = q.sort;
    out = out.slice().sort((a, b) => {
      for (const { field, dir } of s) {
        const av = getField(a, field) as any, bv = getField(b, field) as any;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }
  const total = out.length;
  const offset = q.offset ?? 0;
  const limit = q.limit ?? out.length;
  return { records: out.slice(offset, offset + limit), total };
}
