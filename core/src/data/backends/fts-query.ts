// core/src/data/backends/fts-query.ts
// Build a SAFE FTS5 MATCH expression out of raw human text.
//
// FTS5's MATCH argument is a real query GRAMMAR, not a bag of words: `-` is NOT,
// `"` opens a phrase, `*` is a prefix operator, `(`/`)` group, `:` is a column
// filter, and the bare words AND / OR / NOT / NEAR are operators. A malformed
// expression does not return zero rows — it throws `SqliteError: fts5: syntax
// error near "..."` straight out of the driver. So a user typing an ordinary
// query like `auto-model discovery` or `what's the "right" fix?` would CRASH the
// search rather than run it.
//
// Every token is therefore extracted and re-emitted as a double-quoted literal
// phrase. Nothing the caller typed is ever handed to FTS5 as syntax.

/**
 * Words that appear in essentially every transcript and carry no topical signal.
 *
 * This list is small on purpose. FTS5 tokenizes on word boundaries, so it is
 * already immune to the substring bug that broke the old scorer (`and` matching
 * inside `command`/`understand`/`expand`). Stopwords here are about PRECISION —
 * keeping a filler word from contributing a match in OR mode — not correctness.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of',
  'on', 'or', 'so', 'that', 'the', 'then', 'there', 'they', 'this', 'to', 'up',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'why', 'with', 'you',
]);

/** Cap on emitted terms — bounds the expression handed to SQLite for a pathological query. */
const MAX_TERMS = 24;

/**
 * Split raw text into FTS-safe terms: unicode letters/digits/underscore only,
 * lowercased, stopwords and 1-character tokens dropped, de-duplicated, bounded.
 */
export function tokenizeFts(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of String(raw || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (t.length < 2) continue;             // single chars match far too much to be worth a term
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

export type FtsMode = 'and' | 'or';

/**
 * Build an FTS5 MATCH expression, or null when the query has no usable terms
 * (all stopwords/punctuation) — callers must treat null as "cannot run FTS"
 * rather than as an empty match, so a junk query never silently returns nothing.
 *
 * `and` demands every term (precision); `or` demands one (recall). The search
 * path tries `and` first and only widens to `or` when that finds nothing, so the
 * common case stays tight without a distinctive query dead-ending.
 */
export function buildFtsMatch(raw: string, mode: FtsMode = 'and'): string | null {
  const terms = tokenizeFts(raw);
  if (terms.length === 0) return null;
  // Double quotes are impossible here (the tokenizer keeps only letters/digits/_),
  // so quoting can never be broken out of — but escape anyway rather than rely on it.
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(mode === 'and' ? ' AND ' : ' OR ');
}
