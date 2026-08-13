/**
 * CHECK WHAT YOU EXECUTE — the node's grant decision, the string it forwards, and the string
 * Core's router resolves must all be the same string.
 *
 * ── THE DEFECT THESE TESTS WERE WRITTEN AGAINST ───────────────────────────────────────────
 * `serveData` used to hand `grantAllows` the RAW `/data/…` tail and then forward that same raw
 * tail to Core. Core does not route on it: `rest-server.ts` resolves
 * `new URL(req.url, …).pathname` FIRST and matches the route patterns against that. The WHATWG
 * parser treats `\` as a path SEPARATOR and DELETES a `.` segment; the grant matcher splits on
 * `/` and models neither. Since `exact` and `*` are expressed in segment COUNTS, moving a
 * boundary is precisely what defeats them.
 *
 * Measured on the SHIPPED ui-apps configs before the fix — five panes, all `403`-worthy, all
 * `200` in practice:
 *   assist-backlog            POST /backlog/b1\remove          → executed POST /backlog/b1/remove
 *   assist-missions           GET  /mission/session\s1\read    → executed GET  /mission/session/s1/read
 *   assist-missions           PATCH /mission/views\v1          → executed PATCH /mission/views/v1
 *   assist-sessions           GET  /sessions/s1\dag\branches   → executed GET  /sessions/s1/dag/branches
 *   assist-mission-processes  POST /mission/workflows/x\rollback\force
 * The first is the sharpest: assist-backlog is granted "update an item" (`/backlog/*`) and
 * "discuss an item" and nothing else, yet `POST /backlog/(?<id>[^/]+)/remove` is a real
 * registered route (core/src/routes/core/backlog.routes.ts) — the pane could DELETE.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────────────────────
 * Not "these paths are denied" — a deny-list is the thing that failed. The property:
 *
 *     for every crafted path, grantAllows' answer must describe the path the ROUTER resolves
 *     from what the tier actually sends.
 *
 * Every case below runs `resolveDataTarget` (the real one serveData calls), then re-resolves the
 * forwarded string through `new URL(...).pathname` — the literal line from rest-server.ts — and
 * demands the two agree. That fails on the old code by construction, because the old code
 * forwarded a string it had not normalized.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readDeclaredGrant, grantAllows, canonicalRequestPath, resolveDataTarget, GrantRule,
} from '../grants';

const APPS_ROOT = path.join(__dirname, '../../../../../ui-apps');
const UI_ID = 'demo-pane';

/**
 * THE ROUTER. Copied from core/src/rest-server.ts `parseRequest`:
 *   const url = new URL(req.url || '/', `http://${req.headers.host}`);  →  path: url.pathname
 * Measured: `.pathname` does not depend on the base host, so the stub host is faithful.
 */
function routerPathname(p: string): string {
  return new URL(p, 'http://127.0.0.1:3100').pathname;
}

/**
 * A slice of the REAL Core route table — same shape (`{ method, pattern }`) and the same
 * `parsed.path.match(route.pattern)` selection rest-server.ts does. Copied from
 * core/src/routes/core/{backlog,mission,session-dag,skills}.routes.ts.
 *
 * The invariant under test does not depend on this table — it depends on the resolver — but a
 * failure that can name `POST /backlog/:id/remove` is worth more than one that says `false`.
 */
const CORE_ROUTES: { method: string; pattern: RegExp; name: string }[] = [
  { method: 'GET', pattern: /^\/backlog$/, name: 'GET /backlog' },
  { method: 'POST', pattern: /^\/backlog$/, name: 'POST /backlog' },
  { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/discuss$/, name: 'POST /backlog/:id/discuss' },
  { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/remove$/, name: 'POST /backlog/:id/remove' },
  { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)\/rollback$/, name: 'POST /backlog/:id/rollback' },
  { method: 'GET', pattern: /^\/backlog\/(?<id>[^/]+)$/, name: 'GET /backlog/:id' },
  { method: 'POST', pattern: /^\/backlog\/(?<id>[^/]+)$/, name: 'POST /backlog/:id' },
  { method: 'GET', pattern: /^\/mission$/, name: 'GET /mission' },
  { method: 'GET', pattern: /^\/mission\/workflows$/, name: 'GET /mission/workflows' },
  { method: 'POST', pattern: /^\/mission\/workflows\/(?<id>[^/]+)$/, name: 'POST /mission/workflows/:id' },
  { method: 'POST', pattern: /^\/mission\/workflows\/(?<id>[^/]+)\/rollback$/, name: 'POST /mission/workflows/:id/rollback' },
  { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)$/, name: 'GET /mission/:id' },
  { method: 'GET', pattern: /^\/mission\/(?<id>[^/]+)\/sessions$/, name: 'GET /mission/:id/sessions' },
  { method: 'POST', pattern: /^\/mission\/session\/(?<id>[^/]+)\/read$/, name: 'POST /mission/session/:id/read' },
  { method: 'GET', pattern: /^\/sessions\/(?<id>[^/]+)$/, name: 'GET /sessions/:id' },
  { method: 'GET', pattern: /^\/sessions\/(?<id>[^/]+)\/dag\/branches$/, name: 'GET /sessions/:id/dag/branches' },
  { method: 'GET', pattern: /^\/sessions\/(?<id>[^/]+)\/skills$/, name: 'GET /sessions/:id/skills' },
];

function selectRoute(method: string, pathName: string): string | null {
  const hit = CORE_ROUTES.find((r) => r.method === method.toUpperCase() && r.pattern.test(pathName));
  return hit ? hit.name : null;
}

/** The tier's decision, through the code serveData actually runs. */
interface Decision { forwarded: string | null; service: string; allowed: boolean }
function decide(grant: GrantRule[], method: string, dataPath: string, uiId = UI_ID): Decision {
  const t = resolveDataTarget(dataPath, uiId);
  if (t === null) return { forwarded: null, service: '', allowed: false };
  return { forwarded: t.path, service: t.service, allowed: grantAllows(grant, t.service, t.path, method) };
}

function paneGrant(pane: string): GrantRule[] {
  const g = readDeclaredGrant(path.join(APPS_ROOT, pane));
  assert.ok(g.length > 0, `${pane}: shipped config did not parse — the case below would prove nothing`);
  return g;
}

function tmpGrant(rules: Record<string, unknown>[]): GrantRule[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-canon-'));
  fs.writeFileSync(path.join(dir, 'lmui.config.json'), JSON.stringify({ grant: rules }));
  return readDeclaredGrant(dir);
}

/**
 * THE INVARIANT. Whatever the tier sends is what Core resolves, and the grant answer is about
 * THAT string — never about the string the caller typed.
 */
function assertChecksWhatItExecutes(grant: GrantRule[], method: string, dataPath: string, uiId = UI_ID): Decision {
  const d = decide(grant, method, dataPath, uiId);
  if (d.forwarded === null) return d;                    // refused outright: nothing executes
  const executed = routerPathname(d.forwarded);
  assert.equal(executed, d.forwarded,
    `${method} ${dataPath}: forwarded ${JSON.stringify(d.forwarded)} but the router resolves it to ${JSON.stringify(executed)}`);
  assert.equal(grantAllows(grant, d.service, executed, method), d.allowed,
    `${method} ${dataPath}: authorized ${d.allowed} for ${JSON.stringify(d.forwarded)}, but the EXECUTED path ${JSON.stringify(executed)} says otherwise`);
  if (d.allowed) {
    const route = selectRoute(method, executed);
    assert.ok(route === null || grantAllows(grant, d.service, executed, method),
      `${method} ${dataPath}: would execute ${route} outside the grant`);
  }
  return d;
}

// ── the five measured bypasses, one test each, against the SHIPPED configs ────────────────

test('THE DEFECT: a backslash smuggles an extra segment past an exact:true leaf grant', () => {
  // assist-backlog may update an item (POST /backlog/*) and discuss it. It may not remove it.
  const grant = paneGrant('assist-backlog');
  const bypass = decide(grant, 'POST', 'node/backlog/b1\\remove');
  assert.equal(bypass.forwarded, '/backlog/b1/remove', 'the tier must forward what the router will resolve');
  assert.equal(selectRoute('POST', '/backlog/b1/remove'), 'POST /backlog/:id/remove', 'and that is a real, destructive route');
  assert.equal(bypass.allowed, false, 'a pane granted "update" must not reach "remove" via a backslash');

  // The controls the fix must NOT break: the calls the pane really makes.
  assert.equal(decide(grant, 'POST', 'node/backlog/b1').allowed, true, 'POST /backlog/:id is the pane\'s own grant');
  assert.equal(decide(grant, 'POST', 'node/backlog/b1/discuss').allowed, true);
  assert.equal(decide(grant, 'GET', 'node/backlog').allowed, true);
});

test('THE DEFECT: the same trick on every other shipped pane it reached', () => {
  const cases: [string, string, string, string][] = [
    // pane, method, crafted /data tail, the path Core would have executed
    ['assist-missions', 'GET', 'node/mission/session\\s1\\read', '/mission/session/s1/read'],
    ['assist-missions', 'PATCH', 'node/mission/views\\v1', '/mission/views/v1'],
    ['assist-sessions', 'GET', 'node/sessions/s1\\dag\\branches', '/sessions/s1/dag/branches'],
    ['assist-mission-processes', 'POST', 'node/mission/workflows/x\\rollback\\force', '/mission/workflows/x/rollback/force'],
  ];
  for (const [pane, method, dataPath, executed] of cases) {
    const grant = paneGrant(pane);
    const d = decide(grant, method, dataPath);
    assert.equal(d.forwarded, executed, `${pane}: ${method} ${dataPath}`);
    assert.equal(d.allowed, false, `${pane}: ${method} ${executed} is outside its grant and must be refused`);
  }
});

test('every shipped pane keeps its OWN reach — the fix denies nothing it was granted', () => {
  // Same inventory the grant suite uses, re-run through the canonicalizing path so a
  // fail-closed over-correction (denying real traffic) shows up here rather than in prod.
  const OWN: Record<string, [string, string][]> = {
    'assist-backlog': [['GET', '/backlog'], ['POST', '/backlog'], ['GET', '/backlog/b1'], ['POST', '/backlog/b1'], ['POST', '/backlog/b1/discuss']],
    'assist-missions': [['GET', '/mission'], ['POST', '/mission'], ['GET', '/mission/m1'], ['PATCH', '/mission/m1'], ['GET', '/mission/m1/sessions'], ['POST', '/mission/session/s1/read']],
    'assist-sessions': [['GET', '/projects'], ['GET', '/projects/sessions'], ['GET', '/projects/p1/sessions'], ['GET', '/sessions/s1']],
    'assist-mission-processes': [['GET', '/mission/workflows'], ['GET', '/mission/workflows/w1'], ['POST', '/mission/workflows/w1'], ['POST', '/mission/workflows/w1/rollback']],
    'assist-scheduler': [['GET', '/scheduler/jobs'], ['GET', '/scheduler/jobs/j1'], ['GET', '/scheduler/jobs/j1/logs'], ['POST', '/scheduler/jobs/j1/run']],
    'assist-mcp-tools': [['GET', '/mcp-tools'], ['POST', '/mcp-tools/t1'], ['POST', '/mcp-tools/t1/rollback'], ['GET', '/health'], ['POST', '/mcp/pending/p1/confirm']],
    'assist-data': [['GET', '/data/catalog'], ['POST', '/data/datasets'], ['DELETE', '/data/datasets/d1'], ['DELETE', '/data/access/k1']],
    'assist-content': [['GET', '/assist-content'], ['POST', '/assist-content/c1'], ['POST', '/assist-content/c1/rollback'], ['GET', '/assist-resources/x']],
    'assist-clusters': [['GET', '/cluster/list'], ['POST', '/cluster/assign'], ['GET', '/hub/machines']],
    'assist-manage': [['GET', '/ui-pages'], ['POST', '/ui-pages/enable'], ['DELETE', '/ui-pages/registry/r1']],
    'assist-projects': [['GET', '/projects'], ['GET', '/ttyd/processes'], ['POST', '/ttyd/process/p1/kill'], ['GET', '/health']],
    'assist-mission-graph': [['GET', '/mission/m1'], ['GET', '/mission/m1/sessions'], ['GET', '/mission/views/v1/graph'], ['POST', '/mission/graph']],
    'assist-knowledge': [['GET', '/knowledge'], ['POST', '/knowledge/review']],
    'assist-memory': [['GET', '/memory'], ['GET', '/rules/x']],
    'assist-skills': [['GET', '/skills']],
    'assist-tasks': [['GET', '/tasks/all'], ['GET', '/health']],
    'assist-whatsapp': [['GET', '/whatsapp'], ['POST', '/whatsapp/send']],
    'hello-pane': [['GET', '/health']],
  };
  for (const [pane, calls] of Object.entries(OWN)) {
    const grant = paneGrant(pane);
    for (const [method, p] of calls) {
      const d = assertChecksWhatItExecutes(grant, method, 'node' + p);
      assert.equal(d.forwarded, p, `${pane}: ${method} ${p} must go on the wire unchanged`);
      assert.equal(d.allowed, true, `${pane}: ${method} ${p} is its own grant and must still be ALLOWED`);
    }
  }
});

// ── the required matrix, category by category ────────────────────────────────────────────

/** A leaf rule and a subtree rule — the two shapes a crafted path can attack. */
const LEAF = tmpGrant([{ service: 'node', pathPrefix: '/mission/*', verbs: ['GET'], exact: true }]);
const SUBTREE = tmpGrant([{ service: 'node', pathPrefix: '/mission', verbs: ['GET'] }]);

test('backslash is a SEPARATOR to the router, so it is a separator here too', () => {
  // The wildcard's contract is "exactly ONE segment, never a /". A backslash IS a /.
  const d = assertChecksWhatItExecutes(LEAF, 'GET', 'node/mission/a\\b');
  assert.equal(d.forwarded, '/mission/a/b');
  assert.equal(d.allowed, false, '`*` matched two segments');
  // Two backslashes collapse to `//`, which is refused outright rather than forwarded.
  assert.equal(decide(LEAF, 'GET', 'node/mission/a\\\\b').forwarded, null);
  // A backslash in the SERVICE position cannot move the service boundary either.
  const svc = assertChecksWhatItExecutes(SUBTREE, 'GET', 'node\\mission\\m1');
  assert.equal(svc.service, 'node');
  assert.equal(svc.forwarded, '/mission/m1');
  // Leading `\` is protocol-relative to the parser (measured: host becomes the next token) —
  // the leading segment VANISHES, so it must never be forwarded.
  assert.equal(decide(SUBTREE, 'GET', '\\evil.example/mission/m1').forwarded, null);
  assert.equal(decide(SUBTREE, 'GET', '//evil.example/mission/m1').forwarded, null);
});

test('a `.` segment is DELETED by the router, so the grant must not count it', () => {
  const d = assertChecksWhatItExecutes(LEAF, 'GET', 'node/mission/./m1');
  assert.equal(d.forwarded, '/mission/m1', 'the dot segment is gone before the route is picked');
  assert.equal(d.allowed, true, 'and the surviving path IS the granted leaf');
  // A trailing `/.` is the same story.
  assert.equal(decide(SUBTREE, 'GET', 'node/mission/.').forwarded, '/mission/');
  assertChecksWhatItExecutes(SUBTREE, 'GET', 'node/mission/.');
});

test('a `..` segment is refused, raw and once-decoded — normalization would erase the evidence', () => {
  for (const tail of [
    'node/mission/m1/../../backlog',      // literal
    'node/mission/..',
    'node/mission/m1/%2e%2e/backlog',     // encoded
    'node/mission/m1/%2E%2E/backlog',     // encoded, upper
    'node/mission/m1/.%2e/backlog',       // half-encoded
    'node/mission/m1/%252e%252e/backlog', // double-encoded
    'node/mission/m1\\..\\backlog',       // behind a backslash separator
  ]) {
    assert.equal(decide(SUBTREE, 'GET', tail).forwarded, null, `${tail} must be refused, not normalized`);
  }
});

test('percent-encoded separators are refused at every depth of encoding', () => {
  for (const tail of [
    'node/mission/a%2fb', 'node/mission/a%2Fb',       // encoded slash
    'node/mission/a%5cb', 'node/mission/a%5Cb',       // encoded backslash
    'node/mission/%2e/m1',                            // encoded dot
    'node/mission/a%252fb',                           // double-encoded slash
    'node/mission/a%255cb',                           // double-encoded backslash
    'node/mission/%252e/m1',                          // double-encoded dot
  ]) {
    assert.equal(decide(SUBTREE, 'GET', tail).forwarded, null, `${tail} must be refused`);
  }
  // …and the matcher refuses them too, so a caller that skipped canonicalization still fails closed.
  assert.equal(grantAllows(SUBTREE, 'node', '/mission/a%2fb', 'GET'), false);
  assert.equal(grantAllows(SUBTREE, 'node', '/mission/a\\b', 'GET'), false);
});

test('duplicate slashes are refused, and a trailing slash is forwarded verbatim', () => {
  assert.equal(decide(SUBTREE, 'GET', 'node/mission//m1').forwarded, null);
  assert.equal(decide(SUBTREE, 'GET', 'node//mission/m1').forwarded, null);
  const d = assertChecksWhatItExecutes(SUBTREE, 'GET', 'node/mission/m1/');
  assert.equal(d.forwarded, '/mission/m1/', 'a trailing slash survives — the router keeps it too');
  assert.equal(d.allowed, true);
  // An empty tail names no service, so nothing can grant it (no rule declares service '').
  const empty = decide(SUBTREE, 'GET', '');
  assert.equal(empty.service, '');
  assert.equal(empty.allowed, false);
});

test('case is NOT folded — the router matches its patterns case-sensitively', () => {
  const d = assertChecksWhatItExecutes(SUBTREE, 'GET', 'node/MISSION/m1');
  assert.equal(d.forwarded, '/MISSION/m1');
  assert.equal(d.allowed, false, 'folding case here would grant a path the router resolves elsewhere');
  assert.equal(selectRoute('GET', '/MISSION/m1'), null);
  // Verb case IS folded (HTTP methods are case-insensitive in the grant, by design).
  assert.equal(decide(SUBTREE, 'get', 'node/mission/m1').allowed, true);
});

test('a query string reaching the PATH is refused, not silently truncated', () => {
  // parseReq already split the query off; a `?` or `#` here means the caller wrote something the
  // router would throw away (measured: new URL('/a?b').pathname === '/a').
  for (const tail of ['node/mission/m1?x=1', 'node/mission?/../backlog', 'node/mission/m1#frag', 'node/mission#/x']) {
    assert.equal(decide(SUBTREE, 'GET', tail).forwarded, null, `${tail} must be refused`);
  }
});

test('unicode and overlong encodings are DATA, never separators', () => {
  // Percent-encoding is canonical output, so the forwarded form is a fixed point of the router.
  const accented = assertChecksWhatItExecutes(LEAF, 'GET', 'node/mission/café');
  assert.equal(accented.forwarded, '/mission/caf%C3%A9');
  assert.equal(accented.allowed, true, 'a non-ASCII id is one ordinary segment');

  // U+2024 ONE DOT LEADER and U+FF0E FULLWIDTH FULL STOP are not dot segments…
  const lookalike = assertChecksWhatItExecutes(SUBTREE, 'GET', 'node/mission/․․/m1');
  assert.equal(lookalike.forwarded, '/mission/%E2%80%A4%E2%80%A4/m1');
  assert.equal(decide(SUBTREE, 'GET', 'node/mission/．．/m1').forwarded, '/mission/%EF%BC%8E%EF%BC%8E/m1');
  // …and U+FF3C FULLWIDTH REVERSE SOLIDUS is not a separator.
  const fullwidth = assertChecksWhatItExecutes(LEAF, 'GET', 'node/mission/a＼b');
  assert.equal(fullwidth.forwarded, '/mission/a%EF%BC%BCb');
  assert.equal(fullwidth.allowed, true, 'one segment, so the leaf rule still fits');

  // Overlong UTF-8 `%c0%ae` is the classic `..` smuggle. decodeURIComponent THROWS on it and the
  // URL parser leaves it alone, so it stays one literal segment — and the grant sees it as one.
  const overlong = assertChecksWhatItExecutes(LEAF, 'GET', 'node/mission/%c0%ae%c0%ae/m1');
  assert.equal(overlong.forwarded, '/mission/%c0%ae%c0%ae/m1');
  assert.equal(overlong.allowed, false, 'three segments do not fit a two-segment leaf rule');
  assert.equal(decide(SUBTREE, 'GET', 'node/mission/%c0%ae%c0%ae/m1').allowed, true, 'and it is still inside the subtree');
  // A malformed escape must not fail the request outright — `/100%` is a legal path.
  const pct = assertChecksWhatItExecutes(SUBTREE, 'GET', 'node/mission/100%');
  assert.equal(pct.forwarded, '/mission/100%');
});

test('the explicit <uiId>/<service>/<path> shape canonicalizes identically', () => {
  const implicit = decide(LEAF, 'GET', 'node/mission/./m1');
  const explicit = decide(LEAF, 'GET', `${UI_ID}/node/mission/./m1`);
  assert.deepEqual(explicit, implicit);
  assert.equal(explicit.forwarded, '/mission/m1');
  // …and a backslash cannot fake the uiId shape to shift the service boundary.
  assert.equal(decide(LEAF, 'GET', `${UI_ID}\\node\\mission\\m1`).service, 'node');
});

// ── cross-implementation parity with the hub ─────────────────────────────────────────────

/**
 * The hub's evaluator, transcribed from LangMartDesign/ui-gateway/src/{data/routes.ts,
 * viewtoken/grant.ts} as of this fix. A transcription, not an import: the two live in different
 * repos and ship independently, which is exactly why they drifted — so what is asserted is that
 * the two ALGORITHMS agree, not that one calls the other.
 *
 * 🔴 Re-diff against those two files when either repo moves. A transcription that has silently
 * gone stale asserts parity with a gateway nobody runs, which is worse than asserting nothing.
 */
function hubUnsafePath(p: string): boolean {
  return p.includes('..') || p.includes('//') || /%2e|%2f|%5c/i.test(p);
}
function hubSegments(p: string): string[] {
  const out: string[] = [];
  for (const s of p.split('/')) if (s !== '') out.push(s);
  return out;
}
function hubPathMatches(rule: GrantRule, p: string): boolean {
  if (hubUnsafePath(p)) return false;
  const want = hubSegments(rule.pathPrefix);
  const got = hubSegments(p);
  if (rule.exact === true ? got.length !== want.length : got.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '*') continue;
    if (want[i] !== got[i]) return false;
  }
  return true;
}
function hubGrantAllows(grant: GrantRule[], service: string, method: string, p: string): boolean {
  const m = method.toUpperCase();
  return grant.some((r) => r.service === service && r.verbs.map((v) => String(v).toUpperCase()).includes(m) && hubPathMatches(r, p));
}
function hubCanonicalUpstreamPath(p: string): string | null {
  try {
    const norm = new URL(p, 'http://canon.invalid').pathname;
    if (/%2e/i.test(norm) || /%2f/i.test(norm) || /%5c/i.test(norm)) return null;
    return norm;
  } catch { return null; }
}
function hubIsSafeNodePath(p: string): boolean {
  return !p.includes('..') && !p.includes('//');
}
/** The gateway sits behind ONE Express param decode; this transport does not. Model it. */
function hubDecide(grant: GrantRule[], method: string, apiPath: string): { forwarded: string | null; allowed: boolean } {
  let raw: string;
  try { raw = decodeURIComponent(apiPath); } catch { return { forwarded: null, allowed: false }; } // Express 400s
  const upstream = hubCanonicalUpstreamPath(raw);
  if (!upstream || !hubIsSafeNodePath(upstream)) return { forwarded: null, allowed: false };
  return { forwarded: upstream, allowed: hubGrantAllows(grant, 'node', method, upstream) };
}

/** Everything a pane could send, benign and hostile, applied to every shipped config. */
const PROBE_TAILS = [
  '/mission/m1', '/backlog/b1', '/sessions/s1', '/health', '/scheduler/jobs/j1/run',
  '/backlog/b1/discuss', '/mission/workflows/w1/rollback', '/ui-pages/enable', '/data/catalog',
  '/mission/m1/', '/MISSION/m1', '/mission/café', '/mission/a+b', '/mission/a%20b',
  '/backlog/b1\\remove', '/mission/session\\s1\\read', '/sessions/s1\\dag\\branches',
  '/mission/./m1', '/mission/m1/.', '/mission/x/../backlog', '/mission//m1',
  '/mission/%2e%2e/backlog', '/mission/%252e%252e/backlog', '/mission/a%2fb', '/mission/a%5cb',
  '/mission/%c0%ae%c0%ae/m1', '/mission/․․/m1', '/mission/m1?x=1', '/mission/m1#f',
];
const PROBE_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'];

test('the node is NEVER more permissive than the hub, on every shipped config', () => {
  const panes = fs.readdirSync(APPS_ROOT).filter((n) => fs.existsSync(path.join(APPS_ROOT, n, 'lmui.config.json')));
  assert.ok(panes.length >= 15, `expected the shipped panes, found ${panes.length}`);
  let compared = 0;
  for (const pane of panes) {
    const grant = paneGrant(pane);
    for (const tail of PROBE_TAILS) {
      for (const method of PROBE_METHODS) {
        const node = decide(grant, method, 'node' + tail);
        const hub = hubDecide(grant, method, tail);
        compared++;
        if (!node.allowed) continue;
        assert.ok(hub.allowed,
          `${pane}: node ALLOWS ${method} ${tail} (as ${node.forwarded}) but the hub denies it — the node is the permissive one again`);
        assert.equal(node.forwarded, hub.forwarded,
          `${pane}: ${method} ${tail} — node forwards ${node.forwarded}, hub forwards ${hub.forwarded}`);
      }
    }
  }
  assert.ok(compared > 2000, `parity matrix ran only ${compared} comparisons`);
});

test('on every path with no hostile structure the two evaluators AGREE exactly', () => {
  const benign = PROBE_TAILS.filter((t) => !/[\\%?#]|\.\.|\/\/|\/\.\/|\/\.$/.test(t));
  assert.ok(benign.length >= 10, 'the benign subset must not be empty');
  const panes = fs.readdirSync(APPS_ROOT).filter((n) => fs.existsSync(path.join(APPS_ROOT, n, 'lmui.config.json')));
  for (const pane of panes) {
    const grant = paneGrant(pane);
    for (const tail of benign) {
      for (const method of PROBE_METHODS) {
        const node = decide(grant, method, 'node' + tail);
        const hub = hubDecide(grant, method, tail);
        assert.equal(node.allowed, hub.allowed, `${pane}: ${method} ${tail} — node ${node.allowed}, hub ${hub.allowed}`);
        assert.equal(node.forwarded, hub.forwarded, `${pane}: ${method} ${tail} forwarded differently`);
      }
    }
  }
});

// ── the canonicalizer on its own ──────────────────────────────────────────────────────────

test('canonicalRequestPath is idempotent and is a fixed point of the router', () => {
  for (const p of ['/mission/m1', '/mission/./m1', '/mission/a\\b', '/mission/café', '/mission/m1/', '/health']) {
    const once = canonicalRequestPath(p);
    if (once === null) continue;
    assert.equal(canonicalRequestPath(once), once, `${p}: canonicalizing twice changed the answer`);
    assert.equal(routerPathname(once), once, `${p}: the router would still rewrite ${once}`);
  }
});

test('canonicalRequestPath roots an unrooted tail rather than resolving it against nothing', () => {
  assert.equal(canonicalRequestPath('mission/m1'), '/mission/m1');
  assert.equal(canonicalRequestPath('/mission/m1'), '/mission/m1');
});
