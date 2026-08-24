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
  // 'deleted' mirrors the cache backend's getField(): prefer the user's fields.deleted,
  // fall back to the TOP-LEVEL tombstone flag (NULLIF maps live rows' 0 to NULL, i.e.
  // "absent" — same as rowToRecord's 0 → undefined). Without this, the tombstone GC's
  // prefilter can never find a tombstone on a sql dataset. The `"deleted"` identifier is
  // a code literal, never caller input — the parameterization boundary is unchanged.
  if (field === 'deleted') {
    params.push('$.' + field);
    return `COALESCE(json_extract(fields, ?), NULLIF("deleted", 0))`;
  }
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

export function compileQuery(q: QuerySpec, indexed: Set<string>): { join: string; where: string; whereParams: unknown[]; order: string; orderParams: unknown[]; ranked: boolean } {
  const whereParams: unknown[] = [];
  const clauses: string[] = [];
  for (const f of q.filter || []) {
    const col = colExpr(f.field, indexed, whereParams);
    clauses.push(opSql(col, f, whereParams));
  }
  // FTS is JOINed rather than an `IN (SELECT ...)` subquery specifically so bm25()
  // is in scope for ORDER BY. A subquery can only answer "does it match"; ranking
  // needs the fts table itself in the FROM clause. Without this the fts path returns
  // matches in rowid (i.e. insertion) order — an unranked pile, which is the failure
  // mode this whole change exists to remove.
  const join = q.fts ? `JOIN records_fts ON records_fts.rowid = records.rowid` : '';
  if (q.fts) {
    whereParams.push(q.fts);
    clauses.push(`records_fts MATCH ?`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const orderParams: unknown[] = [];
  let order = '';
  let ranked = false;
  if (q.sort?.length) {
    const parts = q.sort.map((s) => {
      const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
      const col = colExpr(s.field, indexed, orderParams); // pushes the bound json path (if non-indexed) into orderParams
      return `${col} ${dir}`;
    });
    order = `ORDER BY ${parts.join(', ')}`;
  } else if (q.fts) {
    // bm25() returns a NEGATIVE score where a better match is more negative, so plain
    // ascending order puts the best match first. bm25 also normalizes by document
    // length, which is what stops a huge document outranking a relevant short one.
    order = `ORDER BY bm25(records_fts)`;
    ranked = true;
  }
  return { join, where, whereParams, order, orderParams, ranked };
}
