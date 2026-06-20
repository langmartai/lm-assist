// core/src/mcp-server/tools/data-tools-format.ts
// LLM-facing formatting helpers for the data_* MCP tools.
//
// Two concerns, both found by an e2e run through the live langmart connector:
//  - normalizeFilter: accept the symbolic comparison operators an LLM naturally
//    reaches for (>=, >, <=, <, =, ==, !=, <>) and map them to the engine's
//    named ops; throw a clear, listing error for a genuinely-unknown op instead
//    of the engine's silent "0 rows, no error".
//  - compactResult / compactRecord: bound the serialized size of a result so a
//    handful of large records (e.g. ~50KB knowledge entries) can't blow the MCP
//    token cap. Small records pass through untouched; large ones are snippeted
//    with a pointer to data_get for the full record.
import * as crypto from 'crypto';
import { globToRegExp, isDangerousPattern, safeTest } from '../../data/backends/query-filter';
import type { QueryFilter, DataRecord } from '../../data/types';

const CANON = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'regex', 'wildcard', 'exists']);
const ALIAS: Record<string, string> = {
  '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt',
  '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne',
};
const VALID_OPS_MSG = 'eq, ne, gt, gte, lt, lte, in, nin, contains, regex, wildcard, exists (symbolic >=, >, <=, <, =, != are also accepted; regex/wildcard take an optional flags:"i")';

/**
 * Coerce a numeric tool arg that may arrive as a number OR a numeric string.
 * The claude.ai connector → hub relay serializes number-typed args as strings
 * (verified 2026-06-20: data_get offset/limit arrived as "10"/"5"), so a strict
 * `typeof === 'number'` check silently drops them. Returns undefined for
 * non-numeric / empty input so the caller falls back to its default.
 */
export function numArg(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); if (Number.isFinite(n)) return n; }
  return undefined;
}

/** Coerce a boolean tool arg that may arrive as a bool, "true"/"false", or 1/0 (same connector stringification as numArg). */
export function boolArg(v: unknown): boolean {
  return v === true || v === 1 || v === 'true' || v === '1';
}

/**
 * Normalize a QueryFilter[] to the engine's canonical operators.
 * - undefined/null -> undefined (no filter)
 * - non-array -> throws (the `{field: value}` object form is silently ignored by
 *   the engine, so reject it loudly rather than return everything)
 * - unknown op -> throws BAD_FILTER_OP listing the valid operators
 */
export function normalizeFilter(filter: unknown): QueryFilter[] | undefined {
  if (filter === undefined || filter === null) return undefined;
  if (!Array.isArray(filter)) {
    throw new Error('BAD_FILTER: `filter` must be an array of { field, op, value } clauses (not an object).');
  }
  return filter.map((f: any, i: number) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`BAD_FILTER: clause ${i} must be an object { field, op, value }.`);
    }
    const rawOp = String(f.op ?? '');
    const op = CANON.has(rawOp) ? rawOp : ALIAS[rawOp];
    if (!op) {
      throw new Error(`BAD_FILTER_OP: unknown operator "${f.op}". Valid operators: ${VALID_OPS_MSG}.`);
    }
    if (typeof f.flags === 'string' && !/^[ims]*$/.test(f.flags)) {
      throw new Error(`BAD_FLAGS: regex flags "${f.flags}" not allowed — only i, m, s (g/y corrupt cross-row matching).`);
    }
    if (op === 'regex' || op === 'wildcard') {
      let src: string;
      try { src = op === 'wildcard' ? globToRegExp(String(f.value)).source : new RegExp(String(f.value), typeof f.flags === 'string' ? f.flags : undefined).source; }
      catch (e) { throw new Error(`BAD_REGEX: invalid ${op} "${f.value}"${f.flags ? ` /${f.flags}` : ''}: ${e instanceof Error ? e.message : String(e)}`); }
      if (isDangerousPattern(src)) throw new Error(`BAD_PATTERN: ${op} "${f.value}" rejected as potentially catastrophic (nested/overlapping quantifiers) — simplify it.`);
    }
    const clause: QueryFilter = { field: String(f.field ?? ''), op: op as QueryFilter['op'], value: f.value };
    if (typeof f.flags === 'string') clause.flags = f.flags;
    return clause;
  });
}

// ---- bounded projection ----

const MAX_STR = 200;       // truncate any single string value to this many chars
const ARR_HEAD = 3;        // keep the first N elements of a long array
const REC_BUDGET = 900;    // per-record budget inside a list (search/query)
const OBJ_DEPTH = 4;       // recursion guard

function truncStr(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars; use data_get for the full record]`;
}

/** Recursively bound strings and arrays inside a value (fields/metadata). */
function shrink(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return truncStr(v, MAX_STR);
  if (Array.isArray(v)) {
    const head = v.slice(0, ARR_HEAD).map((x) => shrink(x, depth + 1));
    return v.length > ARR_HEAD ? [...head, `…(+${v.length - ARR_HEAD} more, ${v.length} total)`] : head;
  }
  if (v && typeof v === 'object' && depth < OBJ_DEPTH) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shrink(val, depth + 1);
    return o;
  }
  return v;
}

/** Keep only small scalar fields; list the names of the omitted (large) ones. */
function summarizeFields(fields: unknown): unknown {
  if (!fields || typeof fields !== 'object') return fields;
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if ((typeof v === 'string' && v.length <= 80) || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else omitted.push(k);
  }
  if (omitted.length) out._omittedFields = omitted;
  return out;
}

/**
 * Project one record to a bounded form. Small records are unchanged; large ones
 * get snippeted text/fields and a `_note` pointing at data_get.
 */
export function compactRecord(rec: any, budget = REC_BUDGET): any {
  if (!rec || typeof rec !== 'object') return rec;
  const out: Record<string, unknown> = {};
  if ('id' in rec) out.id = rec.id;
  if (typeof rec.score === 'number') out.score = rec.score;
  if (rec.version != null) out.version = rec.version;
  if (rec.fields !== undefined) out.fields = shrink(rec.fields);
  if (typeof rec.text === 'string') out.text = truncStr(rec.text, MAX_STR);
  else if (rec.text !== undefined) out.text = rec.text;
  if (rec.metadata !== undefined) out.metadata = shrink(rec.metadata);

  if (JSON.stringify(out).length > budget) {
    out._note = 'record truncated to fit the response budget; call data_get(dataset, id) for the full record';
    if (typeof out.text === 'string') out.text = truncStr(out.text, 80);
    if (JSON.stringify(out).length > budget && out.fields !== undefined) out.fields = summarizeFields(rec.fields);
  }
  return out;
}

/**
 * Compact a query/search result value in place-of-shape:
 *  - a bare array (search) -> array of compacted records
 *  - { records, total } (query) -> records compacted
 *  - { results } -> results compacted
 * Anything else passes through unchanged.
 */
export function compactResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((r) => summarizeRecord(r));
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.records)) return { ...v, records: (v.records as any[]).map((r) => summarizeRecord(r)) };
    if (Array.isArray(v.results)) return { ...v, results: (v.results as any[]).map((r) => summarizeRecord(r)) };
  }
  return value;
}

// ============================================================================
// Content-type auto-detection + type-aware partial access (requested 2026-06-20)
// ============================================================================

export interface TypeInfo {
  type: 'text' | 'code' | 'json' | 'binary' | 'scalar' | 'null';
  chars?: number; bytes?: number; lines?: number; lang?: string;
  keys?: string[]; length?: number; kind?: 'object' | 'array';
}

/** Only treat a string as JSON when it is an object/array literal — not a bare "42"/"true". */
function tryJsonStructure(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try { const v = JSON.parse(t); return (v && typeof v === 'object') ? v : undefined; } catch { return undefined; }
}

function looksBinaryString(s: string): boolean {
  if (!s) return false;
  if (s.includes(' ')) return true;
  const n = Math.min(s.length, 65536); // sample only the head (bounds O(content))
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32) || c === 0xfffd) ctrl++;
  }
  return ctrl / n > 0.1;
}

function looksBase64Blob(s: string): boolean {
  const t = s.trim();
  if (t.length < 64) return false;
  if (/\s/.test(t.replace(/[\r\n]/g, ''))) return false; // base64 has no internal spaces
  if (!/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(t)) return false;
  const c = t.replace(/\s+/g, '');
  if (c.length % 4 !== 0) return false;
  if (/^[0-9a-fA-F]+$/.test(c)) return false;                  // a pure-hex digest is NOT base64-binary
  if (/[+/=]/.test(c)) return true;                            // base64-specific chars → real base64
  return /[a-z]/.test(c) && /[A-Z]/.test(c) && /[0-9]/.test(c); // else require mixed-case+digit evidence
}

/** Best-effort language guess for a code string (head-only, cheap). */
export function guessLang(s: string): string | undefined {
  const h = s.slice(0, 4000);
  if (/^#!.*\b(bash|sh|zsh)\b/.test(h)) return 'sh';
  if (/^#!.*\bpython/.test(h)) return 'py';
  if (/^#!.*\bnode\b/.test(h)) return 'js';
  if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b[\s\S]*\b(FROM|INTO|SET|WHERE|VALUES|TABLE)\b/i.test(h)) return 'sql';
  if (/<(div|span|html|body|head|p|a|script|template|svg)\b/i.test(h) || /<\/[a-z]+>/i.test(h)) return 'html';
  if (/\bdef\s+\w+\s*\([^)]*\)\s*:/.test(h) || /^\s*(from\s+\w+\s+import|import\s+\w+)\s*$/m.test(h)) return 'py';
  if ((/\b(interface|enum)\s+\w+/.test(h) || /:\s*(string|number|boolean|any|void|unknown)\b/.test(h) || /\bas\s+\w+/.test(h)) && /\b(const|let|function|export|import|=>)\b/.test(h)) return 'ts';
  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(/.test(h)) return 'go';
  if (/\bfn\s+\w+\s*\(|\blet\s+mut\b/.test(h)) return 'rust';
  if (/\b(function|const|let|var|import|export|require\()\b/.test(h) || /=>/.test(h)) return 'js';
  return undefined;
}

function looksLikeCode(s: string): boolean {
  if (guessLang(s)) return true;
  const lines = s.split('\n');
  if (lines.length >= 3) {
    const codey = lines.filter((l) => /[{};]\s*$|^\s{2,}\S|=>|\b(if|for|while|return|function|def|class)\b/.test(l)).length;
    if (codey / lines.length > 0.4) return true;
  }
  return false; // single-line: only guessLang-recognized code counts (avoids prose-with-punctuation → 'code')
}

function latinBytes(s: string): Buffer { return Buffer.from(s, 'latin1'); }
function toBinaryBuffer(s: string): Buffer { return looksBase64Blob(s) ? Buffer.from(s.replace(/\s+/g, ''), 'base64') : latinBytes(s); }
function sha8(s: string): string { return crypto.createHash('sha256').update(latinBytes(s)).digest('hex').slice(0, 8); }

/** Classify a value as bin/text/json/code (+ size, code language). Never returns content. */
export function detectType(value: unknown): TypeInfo {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number' || typeof value === 'boolean') return { type: 'scalar' };
  if (Array.isArray(value)) return { type: 'json', kind: 'array', length: value.length, bytes: safeBytes(value) };
  if (typeof value === 'object') return { type: 'json', kind: 'object', keys: Object.keys(value as object), bytes: safeBytes(value) };
  const s = value as string;
  if (looksBinaryString(s) || looksBase64Blob(s)) return { type: 'binary', bytes: toBinaryBuffer(s).length };
  const parsed = tryJsonStructure(s);
  if (parsed !== undefined) {
    return Array.isArray(parsed)
      ? { type: 'json', kind: 'array', length: parsed.length, bytes: s.length }
      : { type: 'json', kind: 'object', keys: Object.keys(parsed as object), bytes: s.length };
  }
  if (looksLikeCode(s)) return { type: 'code', lang: guessLang(s) || 'unknown', chars: s.length, lines: s.split('\n').length };
  return { type: 'text', chars: s.length };
}

function safeBytes(v: unknown): number { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } }

const INLINE_TEXT = 200;   // text shorter than this is returned inline (no descriptor)
const INLINE_JSON = 200;   // structured values smaller than this (serialized) inline as-is

/**
 * Type-aware summary of one value for the default (summary) view: small scalars/
 * text/json pass through inline; large text/code/json and ALL binary collapse to
 * a typed descriptor with size (+ code lang/lines, + a short snippet) and never
 * the full body. Pair with windowValue()/resolvePath() to fetch a specific part.
 */
export function summarizeValue(value: unknown): unknown {
  const ti = detectType(value);
  switch (ti.type) {
    case 'null': return null;
    case 'scalar': return value;
    case 'binary': return { type: 'binary', bytes: ti.bytes, sha8: sha8(value as string), note: 'not inlined — request a byte range to read' };
    case 'code': {
      const s = value as string;
      return { type: 'code', lang: ti.lang, lines: ti.lines, chars: s.length, snippet: s.split('\n').slice(0, 5).join('\n') };
    }
    case 'text': {
      const s = value as string;
      return s.length <= INLINE_TEXT ? s : { type: 'text', chars: s.length, snippet: truncStr(s, INLINE_TEXT) };
    }
    case 'json': {
      const bytes = ti.bytes ?? safeBytes(value);
      if (bytes <= INLINE_JSON) return value; // small structured value → inline
      return ti.kind === 'array'
        ? { type: 'json', kind: 'array', length: ti.length, bytes }
        : { type: 'json', kind: 'object', keys: ti.keys, bytes };
    }
    default: return value;
  }
}

/** Type-aware summary of a whole record (used by data_query/data_search results). */
export function summarizeRecord(rec: any): any {
  if (!rec || typeof rec !== 'object') return rec;
  const out: Record<string, unknown> = {};
  if ('id' in rec) out.id = rec.id;
  if (typeof rec.score === 'number') out.score = rec.score;
  if (rec.version != null) out.version = rec.version;
  if (rec.fields && typeof rec.fields === 'object') {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec.fields as Record<string, unknown>)) f[k] = summarizeValue(v);
    out.fields = f;
  }
  if (rec.text !== undefined) out.text = summarizeValue(rec.text);
  if (rec.metadata !== undefined) out.metadata = summarizeValue(rec.metadata);
  // Overall budget: even all-small fields can sum past the MCP cap (hundreds of fields).
  // Collapse to a field-name digest when over budget (per-field shrink isn't enough).
  const REC_SUMMARY_BUDGET = 8000;
  if (JSON.stringify(out).length > REC_SUMMARY_BUDGET) {
    const keys = rec.fields && typeof rec.fields === 'object' ? Object.keys(rec.fields) : [];
    out.fields = { _fieldCount: keys.length, _names: keys.slice(0, 60), _note: 'fields elided to fit — use data_get(dataset, id, field=...) to read one' };
    if (typeof out.text === 'string' && out.text.length > 200) out.text = out.text.slice(0, 200) + '…';
  }
  return out;
}

interface PathTok { key: string | number; }
function parsePathTokens(sel: string): PathTok[] {
  const out: PathTok[] = [];
  for (const m of sel.matchAll(/([^.\[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) out.push({ key: Number(m[2]) });
    else if (m[1] !== undefined) out.push({ key: m[1] });
  }
  return out;
}

/**
 * Resolve a selector against a record:
 *  - "text" / "id" → that top-level field
 *  - "fields.x" / "metadata.x" → nested
 *  - bare "name" → fields.name
 *  - "parts[2].summary" → JSON path (arrays via [n])
 *  - "part:<id>" → the fields.parts[] element whose partId/id matches
 */
export function resolvePath(record: DataRecord, sel: string):
  | { ok: true; value: unknown; path: string }
  | { ok: false; error: string } {
  const rec = record as any;
  if (!sel) return { ok: false, error: 'empty selector' };
  if (sel.startsWith('part:')) {
    const pid = sel.slice(5);
    const parts = rec.fields?.parts;
    if (Array.isArray(parts)) {
      const found = parts.find((p: any) => p && (p.partId === pid || p.id === pid));
      if (found) return { ok: true, value: found, path: sel };
    }
    return { ok: false, error: `no part "${pid}"` };
  }
  const tokens = parsePathTokens(sel);
  if (!tokens.length) return { ok: false, error: `bad selector "${sel}"` };
  let cur: any; let rest: PathTok[];
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  if (tokens.some((t) => typeof t.key === 'string' && BLOCKED.has(t.key))) return { ok: false, error: `path "${sel}" not allowed` };
  const head = tokens[0].key;
  if ((head === 'text' || head === 'id' || head === 'version') && (rec as any)[head] !== undefined) { cur = (rec as any)[head]; rest = tokens.slice(1); }
  else if (head === 'fields' || head === 'metadata') { cur = (rec as any)[head]; rest = tokens.slice(1); }
  else { cur = rec.fields; rest = tokens; } // bare name (incl. a reserved name absent up top) → into fields
  for (const t of rest) {
    if (cur == null || typeof cur !== 'object') return { ok: false, error: `path "${sel}" not found` };
    if (typeof t.key === 'string' && !Object.prototype.hasOwnProperty.call(cur, t.key)) return { ok: false, error: `path "${sel}" not found` };
    cur = (cur as any)[t.key];
  }
  if (cur === undefined) return { ok: false, error: `path "${sel}" not found` };
  return { ok: true, value: cur, path: sel };
}

const TEXT_WIN = 4000, CODE_WIN = 200, BIN_WIN = 48 * 1024, ARR_WIN = 50;

/**
 * Return a window of a value in the unit natural to its type, self-describing:
 *  - text   → chars  [offset, offset+limit)         {unit:'chars',  total, hasMore}
 *  - code   → lines  (offset = 1-based start line)   {unit:'lines',  totalLines, lang}
 *  - json[] → elements                                {unit:'elements', total}
 *  - json{} → the object (you pathed to it)           {unit:'json', keys}
 *  - binary → bytes as base64 (range REQUIRED, capped){unit:'bytes',  total, encoding}
 */
export function windowValue(value: unknown, opts: { offset?: number; limit?: number }): any {
  const ti = detectType(value);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));                 // clamp negatives, truncate floats
  const rawLimit = opts.limit === undefined ? undefined : Math.trunc(opts.limit);
  const clampLimit = (def: number, cap: number) => Math.max(0, Math.min(rawLimit ?? def, cap));

  if (ti.type === 'json') {
    const v = typeof value === 'string' ? JSON.parse((value as string).trim()) : value;
    if (Array.isArray(v)) {
      const limit = clampLimit(ARR_WIN, 1000);
      const slice = v.slice(offset, offset + limit);
      return { unit: 'elements', total: v.length, offset, returned: slice.length, content: slice, hasMore: offset + limit < v.length };
    }
    return { unit: 'json', keys: Object.keys(v ?? {}), content: v };
  }
  if (ti.type === 'binary') {
    if (rawLimit === undefined) return { unit: 'bytes', total: ti.bytes, note: 'binary content — pass offset/limit (in bytes) to read a base64 slice' };
    const buf = toBinaryBuffer(value as string);
    const limit = clampLimit(BIN_WIN, BIN_WIN);
    const slice = buf.subarray(offset, offset + limit);
    return { unit: 'bytes', total: buf.length, offset, returned: slice.length, encoding: 'base64', content: slice.toString('base64'), hasMore: offset + limit < buf.length };
  }
  // text/code: address by LINE for any multi-line content (so `offset` is a line number,
  // consistent with grep/selectLines — fixes the text→chars unit trap); single-line text → chars.
  const s = value == null ? '' : String(value);
  const lines = s.split(/\r?\n/);
  if (ti.type === 'code' || lines.length > 1) {
    const start = offset > 0 ? offset - 1 : 0; // offset is a 1-based line number
    const limit = clampLimit(CODE_WIN, 5000);
    const sel = lines.slice(start, start + limit);
    return { unit: 'lines', totalLines: lines.length, lang: ti.lang, offset: start + 1, returned: sel.length, content: sel.join('\n'), hasMore: start + limit < lines.length };
  }
  const limit = clampLimit(TEXT_WIN, TEXT_WIN * 4);
  return { unit: 'chars', total: s.length, offset, returned: Math.max(0, Math.min(limit, s.length - offset)), content: s.slice(offset, offset + limit), hasMore: offset + limit < s.length };
}

// ---- line-oriented content retrieval (grep / explicit ranges) ----

/** Render a value as line-oriented text for grep/lines: strings as-is, json pretty-printed, binary => null. */
function toLineText(value: unknown): string | null {
  if (detectType(value).type === 'binary') return null;
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const GREP_CAP = 100;

/**
 * Grep a field's lines for a pattern, returning each match with its 1-based line
 * number (like `grep -n`). `wildcard` treats the pattern as an unanchored glob;
 * otherwise it's a regex. `context` includes N lines before/after each match.
 */
export function grepField(
  value: unknown,
  pattern: string,
  opts: { wildcard?: boolean; ignoreCase?: boolean; context?: number; maxMatches?: number },
): any {
  const text = toLineText(value);
  if (text === null) return { unit: 'matches', error: 'grep is not supported on binary content — read a byte range with offset/limit instead' };
  let re: RegExp;
  const flags = opts.ignoreCase ? 'i' : '';
  try { re = opts.wildcard ? globToRegExp(pattern, { anchored: false, flags }) : new RegExp(pattern, flags); }
  catch (e) { return { unit: 'matches', error: `BAD_PATTERN: invalid ${opts.wildcard ? 'wildcard' : 'regex'} "${pattern}": ${e instanceof Error ? e.message : String(e)}` }; }
  if (isDangerousPattern(re.source)) return { unit: 'matches', error: `BAD_PATTERN: ${opts.wildcard ? 'wildcard' : 'regex'} "${pattern}" rejected as potentially catastrophic — simplify it` };
  const lines = text.split(/\r?\n/);
  const ctx = Math.max(0, opts.context ?? 0);
  const cap = Math.max(1, opts.maxMatches ?? GREP_CAP);
  const matches: any[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!safeTest(re, lines[i])) continue;
    total++;
    if (matches.length < cap) {
      const m: any = { line: i + 1, text: lines[i] };
      if (ctx > 0) { m.before = lines.slice(Math.max(0, i - ctx), i); m.after = lines.slice(i + 1, i + 1 + ctx); }
      matches.push(m);
    }
  }
  return { unit: 'matches', pattern, mode: opts.wildcard ? 'wildcard' : 'regex', totalLines: lines.length, totalMatches: total, returned: matches.length, matches, hasMore: total > matches.length };
}

function parseLineRanges(spec: string, maxLine: number): number[] {
  const set = new Set<number>();
  const CAP = 10000;
  for (const part of spec.split(',')) {
    if (set.size >= CAP) break;
    const p = part.trim();
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Math.max(1, Math.min(+m[1], +m[2]));            // clamp endpoints BEFORE expanding
      const b = Math.min(Math.max(+m[1], +m[2]), maxLine);
      for (let n = a; n <= b && set.size < CAP; n++) set.add(n);
    } else if (/^\d+$/.test(p)) { const n = +p; if (n >= 1 && n <= maxLine) set.add(n); }
  }
  return [...set].sort((a, b) => a - b);
}

/** Return exactly the lines named by a multi-range spec like "2-4,7,9-10", each tagged with its 1-based number. */
export function selectLines(value: unknown, spec: string): any {
  const text = toLineText(value);
  if (text === null) return { unit: 'lines', error: 'line selection is not supported on binary content — read a byte range with offset/limit instead' };
  const lines = text.split(/\r?\n/);
  const wanted = parseLineRanges(spec, lines.length);
  return { unit: 'lines', totalLines: lines.length, returned: wanted.length, lines: wanted.map((n) => ({ line: n, text: lines[n - 1] })) };
}
