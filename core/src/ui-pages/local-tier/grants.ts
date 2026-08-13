/**
 * Local-tier grant primitives — the declared allow-list a pane's data-plane calls
 * are checked against. Grants are DECLARED by the app in <appDir>/lmui.config.json
 * ({ grant: [{ service, pathPrefix, verbs, exact? }] }); this module reads that file and
 * answers "is (service, path, method) allowed?".
 *
 * A malformed/absent config yields no grant (deny-all), never an error — a broken
 * config must not open the data plane, and must not crash the server either.
 *
 * ── THE RULE FORM ─────────────────────────────────────────────────────────────────────────
 * A rule's path is a SEGMENT PATTERN, not a string prefix:
 *
 *   { "service":"node", "pathPrefix":"/mission",   "verbs":["GET"]  }               subtree
 *   { "service":"node", "pathPrefix":"/mission",   "verbs":["POST"], "exact":true } leaf
 *   { "service":"node", "pathPrefix":"/mission/*", "verbs":["POST"], "exact":true } one wildcard segment
 *
 *   • a literal segment matches itself;
 *   • a segment that is exactly `*` matches exactly ONE non-empty segment (it is a
 *     path-parameter hole, e.g. `/mission/session/{*}/read`), and never a `/`;
 *   • `exact:true` means the request must have the SAME NUMBER OF SEGMENTS as the rule —
 *     a LEAF match. Without it the rule keeps its historical meaning: itself plus the whole
 *     subtree beneath it.
 *
 * 🔴 WHY `exact` IS A FIELD AND NOT A MARKER INSIDE THE PATH (e.g. "/mission$").
 * Two independent evaluators read this same rule — this module, and the hub's ui-gateway
 * (`ui-gateway/src/viewtoken/grant.ts`, fed by `registry/scope.ts` validation). A marker lives
 * inside `pathPrefix`, which both of them already parse as a PLAIN PATH: the gateway rejects
 * `..`/`//` in it and does `path.startsWith(prefix + '/')`. An evaluator that did not learn the
 * marker would silently treat `$` as a path character and deny every real call, and a validator
 * would have no way to tell a marker from a legal (if odd) path segment. A separate boolean is
 * greppable (`grep -rn '"exact"' ui-apps/`), schema-checkable, and — crucially — its failure
 * mode is loud in review rather than invisible in a string.
 *
 * 🔴 WHY `*` EXISTS AT ALL. `exact` alone cannot narrow the pane this form was written for.
 * `ui-apps/assist-missions` calls `POST /mission/<id>` (mission patch), so without a
 * single-segment wildcard the minimum expressible POST grant is still the ENTIRE `/mission`
 * subtree — which is exactly the defect (it carries `POST /mission/workflows/<id>` and
 * `/rollback`, i.e. authority to rewrite and roll back the Mission-Controller playbooks that the
 * Mission Processes pane deliberately restricted to GET). `*` is the smallest addition that
 * closes it without touching any pane's app.js.
 *
 * ── COMPATIBILITY ─────────────────────────────────────────────────────────────────────────
 * Every rule written before this change keeps its exact meaning: no `exact` key means subtree,
 * and no shipped path contains a `*` segment (verified across ui-apps/). The asymmetry is worth
 * stating plainly, because it decides how this rolls out:
 *   • an OLD evaluator reading a NEW `exact:true` rule ignores the flag and is MORE permissive
 *     → the hub-side evaluator MUST be upgraded in lockstep (it was; see the file above);
 *   • an OLD evaluator reading a NEW `*` rule treats `*` as a literal segment, matches nothing,
 *     and DENIES — fail-closed.
 * So a config using `*` degrades safely on a stale evaluator; one using only `exact` does not.
 *
 * ── PATH SAFETY ───────────────────────────────────────────────────────────────────────────
 * No rule ever matches a path carrying traversal or an encoded separator (`..`, `//`, `%2e`,
 * `%2f`, `%5c`). The caller (`server.ts serveData`) rejects those before it gets here, and the
 * hub's gateway canonicalizes before ITS check — this is the third copy on purpose: a matcher
 * whose contract is "answers whether this path is granted" must not answer "yes" for a path
 * that means something else after normalization. It can only ever deny, so it cannot widen
 * anything.
 *
 * 🔴 CANONICALIZE BEFORE YOU CHECK — `canonicalRequestPath` below, and why it is in THIS file.
 * This matcher compares SEGMENTS split on `/`. The thing that finally selects a route does not:
 * `rest-server.ts` resolves `new URL(req.url, …).pathname` first, and the WHATWG parser treats
 * `\` as a path SEPARATOR and DELETES a `.` segment. So the raw string and the executed string
 * disagree about where the segment boundaries are — and every narrowing this file added (`exact`,
 * `*`) is expressed in segment COUNTS, which is exactly what the disagreement moves. Measured on
 * the shipped configs before the fix: `GET /mission/session\abc\read` matched
 * assist-missions' `{'/mission/*', exact:true}` LEAF rule as two segments and then executed as
 * the four-segment `/mission/session/abc/read`; five shipped panes were reachable that way.
 *
 * The canonicalizer therefore lives next to the matcher rather than next to the caller, so the
 * two cannot drift: whatever `canonicalRequestPath` returns is what `grantAllows` is asked about
 * AND what gets forwarded. The hub's twin does the same in the same order
 * (`ui-gateway/src/data/routes.ts` → `canonicalUpstreamPath` → `grantAllows` → relay the
 * canonical form), which is why the two evaluators now agree on a crafted path instead of only
 * on a well-behaved one.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface GrantRule {
  service: string;
  pathPrefix: string;
  verbs: string[];
  /** Leaf match: the request path must have exactly this rule's segment count. */
  exact: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function readDeclaredGrant(appDir: string): GrantRule[] {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path.join(appDir, 'lmui.config.json'), 'utf8')); }
  catch { return []; }
  const grant = isRecord(parsed) ? parsed.grant : undefined;
  if (!Array.isArray(grant)) return [];
  const out: GrantRule[] = [];
  for (const g of grant) {
    if (!isRecord(g)) continue;
    const { service, pathPrefix, verbs, exact } = g;
    // A rule missing either identifier is meaningless — drop it rather than guess.
    if (typeof service !== 'string' || !service) continue;
    if (typeof pathPrefix !== 'string' || !pathPrefix) continue;
    // 🔴 Must be rooted. The matcher below compares SEGMENTS, so a relative 'mission' would
    // split to the same ['mission'] as '/mission' and silently start matching — a widening
    // that the old string-prefix matcher could not produce. The hub's validateGrantRules
    // refuses an unrooted prefix at registration for the same reason; refuse it here too.
    if (!pathPrefix.startsWith('/')) continue;
    // Traversal in the RULE itself: the hub refuses to register it (validateGrantRules), so a
    // node that honoured it would grant reach no hub-served pane could ever have.
    if (isUnsafePath(pathPrefix)) continue;
    // An `exact` that is not a boolean is a typo in a security decision ("exact":"false" is a
    // TRUTHY string). Drop the whole rule: guessing either way writes an authority the author
    // did not express.
    if (exact !== undefined && typeof exact !== 'boolean') continue;
    out.push({
      service,
      pathPrefix,
      verbs: Array.isArray(verbs)
        ? verbs.filter((v): v is string => typeof v === 'string').map((v) => v.toUpperCase())
        : [],
      exact: exact === true,
    });
  }
  return out;
}

/** `.` / `/` / `\` hidden in percent-encoding — a separator the segment split cannot see. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

/**
 * Structure that the URL parser honours and a `split('/')` does not — measured, not assumed:
 *   `new URL('/a\\b').pathname` === '/a/b'   (backslash IS a separator on a special scheme)
 *   `new URL('/a#b').pathname` === '/a'      (fragment TERMINATES the path)
 *   `new URL('/a?b').pathname` === '/a'      (so does a query)
 * None of the three can occur in a canonical pathname, so refusing them costs a correct caller
 * nothing — and it makes this matcher fail CLOSED if some future caller forgets to canonicalize.
 */
const PATH_STRUCTURE = /[\\#?]/;

/** Traversal, an encoded separator, or raw URL structure — never matchable, whatever the rule says. */
function isUnsafePath(p: string): boolean {
  return p.includes('..') || p.includes('//') || ENCODED_SEPARATOR.test(p) || PATH_STRUCTURE.test(p);
}

/**
 * The base only has to parse; it never reaches the result. Measured: `.pathname` is identical
 * for any base host, so canonicalization here matches Core's `new URL(req.url, 'http://'+host)`
 * without needing to know the host.
 */
const CANON_BASE = 'http://local-tier.invalid';
const CANON_ORIGIN = new URL(CANON_BASE).origin;

/**
 * The path the ROUTER will actually resolve, or `null` if this request must not be forwarded
 * at all. Callers must check AND forward this exact string — that equality is the whole point.
 *
 * The three steps are ordered, and the order is the security property:
 *
 *  1. **Traversal intent, before normalization erases the evidence.** `new URL` *resolves* `..`,
 *     so a post-hoc `includes('..')` sees nothing: `/sessions/../secrets` normalizes to
 *     `/secrets`, which is a perfectly clean-looking path for a route that was never granted.
 *     The raw form is checked, and so is the once-decoded form — `%2e%2e` and `%252e%252e` are
 *     the same request wearing a hat. (A malformed `%` sequence keeps the raw string rather than
 *     failing the request, so a legitimate `/100%` still works.)
 *  2. **Normalize with the router's own algorithm** — literally `new URL(p, base).pathname`, the
 *     line from `rest-server.ts`. Not a reimplementation: a hand-rolled normalizer is a second
 *     thing to keep in sync, and the drift is invisible until someone crafts a path.
 *  3. **Re-check the result.** `\\` collapses to `//` and an encoded separator can survive the
 *     parser untouched (`%2f` stays `%2f`), so the output gets the same guard as the input.
 *
 * A raw `?` or `#` is refused rather than normalized. The transport already split the query off
 * (`parseReq`), so one arriving HERE is malformed — and `new URL` would silently TRUNCATE the
 * path at it (measured: `/a?b` and `/a#b` both give `.pathname === '/a'`), quietly discarding
 * whatever the caller wrote after it. Refusing says so; truncating forwards a request nobody made.
 *
 * 🔴 Step 2 also compares the ORIGIN, which is not paranoia about a host escaping (we only ever
 * read `.pathname`) but about the LEADING SEGMENT VANISHING. Measured: `//evil.example/mission/m1`
 * AND `/\evil.example/mission/m1` both parse as protocol-relative — host `evil.example`,
 * pathname `/mission/m1`. Resolved as a path that says "service `mission`, path `/m1`": the
 * service boundary moved, which is as grant-relevant as a change gets. A path whose
 * normalization changes which HOST it addresses was never a path.
 *
 * Against the hub this is fail-closed by construction: an encoded separator is refused here and
 * merely normalized there (the hub sits behind an Express decode this transport does not have),
 * so the node denies a superset of what the hub denies and never the other way round.
 */
export function canonicalRequestPath(rawPath: string): string | null {
  const p = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch { decoded = p; }
  if (p.includes('..') || p.includes('//') || decoded.includes('..') || decoded.includes('//')) return null;
  if (ENCODED_SEPARATOR.test(p) || ENCODED_SEPARATOR.test(decoded)) return null;
  if (p.includes('?') || p.includes('#')) return null;
  let parsed: URL;
  try { parsed = new URL(p, CANON_BASE); } catch { return null; }
  if (parsed.origin !== CANON_ORIGIN) return null;
  const canonical = parsed.pathname;
  if (canonical.includes('..') || canonical.includes('//') || ENCODED_SEPARATOR.test(canonical)) return null;
  return canonical;
}

/** '/a/b/' → ['a','b'] · '/' → [] · 'a' → ['a'] (callers guarantee a rooted path). */
function segments(p: string): string[] {
  const out: string[] = [];
  for (const s of p.split('/')) if (s !== '') out.push(s);
  return out;
}

/**
 * Segment-pattern match: '/backlog' allows '/backlog' and '/backlog/x' but NOT '/backlogx';
 * with `exact` it allows '/backlog' alone. A '*' segment fills exactly one segment.
 *
 * Empty segments are dropped on both sides, so a trailing slash is not significant — the
 * historical behaviour ('/data/' being its own boundary) survives as a special case of that.
 */
function pathMatchesRule(pathName: string, rule: GrantRule): boolean {
  if (isUnsafePath(pathName)) return false;
  const want = segments(rule.pathPrefix);
  const got = segments(pathName);
  if (rule.exact ? got.length !== want.length : got.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '*') continue;      // one segment, any value — got[i] exists and is non-empty
    if (want[i] !== got[i]) return false;
  }
  return true;
}

export function grantAllows(grant: GrantRule[], service: string, pathName: string, method: string): boolean {
  const verb = method.toUpperCase();
  return grant.some((r) => r.service === service && r.verbs.includes(verb) && pathMatchesRule(pathName, r));
}

/** What a `/data/…` tail resolves to: which service, and the ONE path string to check and send. */
export interface DataTarget {
  service: string;
  /** Canonical — `grantAllows` is asked about exactly this, and exactly this goes on the wire. */
  path: string;
}

/**
 * Collapse a `/data/…` tail (everything after `/data/`) into the service + canonical path pair
 * the tier acts on, or `null` if it must not be forwarded at all.
 *
 * Two shapes mean the same thing: `<service>/<path>` and `<uiId>/<service>/<path>`. Only the
 * caller's OWN uiId (from its view token, never from the URL) selects the explicit shape.
 *
 * 🔴 The shape split happens on the CANONICAL path, not the raw one, so `\` cannot move the
 * service boundary either — and the single returned `path` is what makes "the string that was
 * authorized is the string that executes" structural rather than a convention. serveData calls
 * this and the tests call this: one implementation, so a check and an execution cannot drift.
 */
export function resolveDataTarget(dataPath: string, uiId: string): DataTarget | null {
  const canonical = canonicalRequestPath(dataPath);
  if (canonical === null) return null;
  const parts = canonical.replace(/^\//, '').split('/');
  const explicit = parts[0] === uiId;
  const service = (explicit ? parts[1] : parts[0]) || '';
  const rest = explicit ? parts.slice(2) : parts.slice(1);
  return { service, path: '/' + rest.join('/') };
}
