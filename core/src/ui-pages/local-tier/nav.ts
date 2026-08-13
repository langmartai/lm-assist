/**
 * Cross-pane navigation — parameter validation and canonical serialization.
 *
 * A pane never builds a URL to another pane: it calls `lmui.goto(uiId, params)` and the
 * SERVING TIER constructs the destination (see serveGo in server.ts, and the hub's
 * /go/:ui). This module is the shared, zero-I/O rule table both server-side entry points
 * use — the standalone `/go/<uiId>` redirect and POST /ui-pages/local-url.
 *
 * The rules are duplicated (deliberately, by hand) in three other places that a hand-typed
 * URL can reach without passing through any of the others:
 *   - the browser shim            ui-apps/<pane>/assets/lmui.js  (throws, never truncates)
 *   - the hub gateway             LangMartDesign ui-gateway/src/registry/nav-params.ts
 *   - the shell's forwarder       LangMartDesign assist-web/src/lib/pane-nav.ts
 * Keep the four tables in sync or a deep link that works on one tier silently loses a
 * param on another.
 *
 * Two invariants are worth more than the rest:
 *   - REFUSE, NEVER TRUNCATE. A clipped `id=` opens a DIFFERENT record, silently.
 *   - Reserved keys belong to the serving tier (`lt` is a live entry token, `embed`/`theme`
 *     are the shell's embedding contract). A caller may not set them, so they are dropped
 *     here and thrown on in the shim, where the author can still fix the call.
 */

/** A pane id: lower-case, hyphenated, one segment. Same shape the hub's registry enforces. */
export const UI_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A forwardable param NAME. Deliberately narrower than URL syntax allows. */
export const NAV_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/;
/** Owned by the serving tier / the shell — silently dropped here, thrown in the shim. */
export const RESERVED_NAV_PARAMS: ReadonlySet<string> = new Set(['lt', 'embed', 'theme', 'code', 'token', 'returnTo']);
export const NAV_MAX_KEYS = 16;
export const NAV_MAX_VALUE = 512;
export const NAV_MAX_QS = 2048;

export type NavQuery = { ok: true; qs: string } | { ok: false; reason: string };

/** Loud but safe: a refusal names what was sent without echoing raw bytes into a response. */
function excerpt(s: string): string {
  return s.slice(0, 40).replace(/[^\w.\- ]/g, '?');
}

/**
 * Raw '?a=1&b=2' (or '') → the canonical forwardable query, WITHOUT the leading '?'.
 *
 * Re-serialized through a fresh URLSearchParams, so '#', '&', '=', CR, LF and %00 come back
 * percent-encoded and cannot escape the query they are in. Idempotent: sanitize(sanitize(x))
 * === sanitize(x).
 */
export function sanitizeNavQuery(search: string): NavQuery {
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  if (!raw) return { ok: true, qs: '' };
  let parsed: URLSearchParams;
  try { parsed = new URLSearchParams(raw); } catch { return { ok: false, reason: 'nav: unparseable query' }; }

  const out = new URLSearchParams();
  const seen = new Set<string>();
  let keys = 0;
  for (const [k, v] of parsed) {
    // Reserved first: '_lmX' would otherwise fail the charset check and 400 a link whose
    // only sin is carrying a key this tier owns.
    if (RESERVED_NAV_PARAMS.has(k) || k.startsWith('_lm')) continue;
    if (!NAV_KEY_RE.test(k)) return { ok: false, reason: `nav: illegal param name "${excerpt(k)}"` };
    // Never merge a repeated key: '?id=7&id=8' has no honest single answer, and picking
    // one opens a record the caller did not ask for.
    if (seen.has(k)) return { ok: false, reason: `nav: repeated param "${excerpt(k)}"` };
    seen.add(k);
    if (v.length > NAV_MAX_VALUE) return { ok: false, reason: `nav: "${excerpt(k)}" exceeds ${NAV_MAX_VALUE} chars` };
    if (++keys > NAV_MAX_KEYS) return { ok: false, reason: `nav: at most ${NAV_MAX_KEYS} params` };
    out.append(k, v);
  }
  const qs = out.toString();
  if (qs.length > NAV_MAX_QS) return { ok: false, reason: `nav: query too long (${qs.length} > ${NAV_MAX_QS})` };
  return { ok: true, qs };
}

/**
 * Object form, for POST /ui-pages/local-url and any other server-side caller.
 *
 * Values are string | number | boolean (String()-coerced); null/undefined drop the key;
 * an object value is refused. Arrays serialize as repeated keys — which sanitizeNavQuery
 * then REFUSES (see the repeated-key rule above); an array of one element is the only form
 * that survives. That asymmetry is inherited from the wire contract, not invented here.
 */
export function navQueryFromObject(o: unknown): NavQuery {
  if (o === undefined || o === null) return { ok: true, qs: '' };
  if (typeof o !== 'object' || Array.isArray(o)) return { ok: false, reason: 'nav: params must be a plain object' };
  const sp = new URLSearchParams();
  for (const [k, raw] of Object.entries(o as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (item === null || item === undefined || typeof item === 'object') {
        return { ok: false, reason: `nav: "${excerpt(k)}" must be a string, number or boolean` };
      }
      sp.append(k, String(item));
    }
  }
  // One rule table: the object form is validated by the same code the URL form is.
  return sanitizeNavQuery(sp.toString());
}
