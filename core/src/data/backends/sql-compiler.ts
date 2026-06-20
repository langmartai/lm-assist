// core/src/data/backends/sql-compiler.ts
// Compile a QuerySpec into PARAMETERIZED SQL fragments. Every caller value is bound (never inlined);
// field names resolve ONLY to a declared generated column ("f_<name>") or json_extract(fields, ?)
// with the JSON path BOUND — never a physical/internal column (version/origin/created_at/rowid),
// never a raw caller-interpolated identifier. This is the security boundary for the sql backend.
import type { QuerySpec, QueryFilter } from '../types';

const FIELD_RE = /^[A-Za-z0-9_.]+$/;
function genCol(field: string): string { return '"f_' + field.replace(/[^a-z0-9_]/gi, '_') + '"'; }

/** SQL column expression for a logical field + the params it contributes (the bound json path, if any). */
function colExpr(field: string, indexed: Set<string>, params: unknown[]): string {
  if (!FIELD_RE.test(field)) throw new Error(`invalid field name "${field}"`);
  if (indexed.has(field)) return genCol(field);     // safe: from validated indexedFields config
  params.push('$.' + field);                         // bound json path — caller field never inlined
  return 'json_extract(fields, ?)';
}

function opSql(col: string, f: QueryFilter, params: unknown[]): string {
  // better-sqlite3 can only bind number/string/bigint/buffer/null — a JS boolean throws.
  // Coerce booleans to 0/1 so a boolean filter behaves like the cache backend instead of crashing.
  const bind = (v: unknown) => params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  switch (f.op) {
    case 'eq': bind(f.value); return `${col} IS ?`;
    case 'ne': bind(f.value); return `${col} IS NOT ?`;
    case 'gt': bind(f.value); return `${col} > ?`;
    case 'gte': bind(f.value); return `${col} >= ?`;
    case 'lt': bind(f.value); return `${col} < ?`;
    case 'lte': bind(f.value); return `${col} <= ?`;
    case 'in': case 'nin': {
      const arr = Array.isArray(f.value) ? f.value : [];
      const not = f.op === 'nin' ? 'NOT ' : '';
      // Empty IN matches nothing. Still reference `col` (X IN (NULL) → NULL/false) so the json-path
      // param `colExpr` already pushed stays aligned with a placeholder — returning a bare '0' would
      // leave that param dangling and better-sqlite3 would over-bind.
      if (!arr.length) return `${col} ${not}IN (NULL)`;
      arr.forEach(bind);
      return `${col} ${not}IN (${arr.map(() => '?').join(', ')})`;
    }
    case 'contains': {
      const v = String(f.value).replace(/[%_\\]/g, '\\$&'); // escape LIKE wildcards in the value
      params.push(`%${v}%`);
      return `${col} LIKE ? ESCAPE '\\'`;
    }
    case 'wildcard': params.push(String(f.value)); return `${col} GLOB ?`;           // native *,? glob
    case 'regex': params.push(String(f.value)); return `${col} REGEXP ?`;            // REGEXP fn registered on the connection
    case 'exists': return f.value === false ? `${col} IS NULL` : `${col} IS NOT NULL`;
    default: throw new Error(`unsupported op "${(f as any).op}"`);
  }
}

export function compileQuery(q: QuerySpec, indexed: Set<string>): { where: string; whereParams: unknown[]; order: string; orderParams: unknown[] } {
  const whereParams: unknown[] = [];
  const clauses: string[] = [];
  for (const f of q.filter || []) {
    const col = colExpr(f.field, indexed, whereParams);
    clauses.push(opSql(col, f, whereParams));
  }
  if (q.fts) {
    whereParams.push(q.fts);
    clauses.push(`records.rowid IN (SELECT rowid FROM records_fts WHERE records_fts MATCH ?)`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const orderParams: unknown[] = [];
  let order = '';
  if (q.sort?.length) {
    const parts = q.sort.map((s) => {
      const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
      const col = colExpr(s.field, indexed, orderParams); // pushes the bound json path (if non-indexed) into orderParams
      return `${col} ${dir}`;
    });
    order = `ORDER BY ${parts.join(', ')}`;
  }
  return { where, whereParams, order, orderParams };
}
