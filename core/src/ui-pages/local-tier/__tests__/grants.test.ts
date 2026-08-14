import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDeclaredGrant, grantAllows } from '../grants';

function writeConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-cfg-'));
  fs.writeFileSync(path.join(dir, 'lmui.config.json'), JSON.stringify(obj));
  return dir;
}

/** Read a one-rule config and return the parsed grant — the shape every case below starts from. */
function rule(r: Record<string, unknown>): ReturnType<typeof readDeclaredGrant> {
  return readDeclaredGrant(writeConfig({ grant: [r] }));
}

test('reads and normalizes declared grants (verbs uppercased, exact defaulted)', () => {
  const dir = writeConfig({ grant: [{ service: 'node', pathPrefix: '/backlog', verbs: ['get', 'Post'] }] });
  assert.deepEqual(readDeclaredGrant(dir), [{ service: 'node', pathPrefix: '/backlog', verbs: ['GET', 'POST'], exact: false }]);
});

test('missing config and malformed JSON yield an empty grant', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-empty-'));
  assert.deepEqual(readDeclaredGrant(empty), []);
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-bad-'));
  fs.writeFileSync(path.join(badDir, 'lmui.config.json'), '{ not json');
  assert.deepEqual(readDeclaredGrant(badDir), []);
});

test('rules missing service or pathPrefix are dropped; non-array/absent grant → []', () => {
  const dir = writeConfig({ grant: [
    { pathPrefix: '/x', verbs: ['GET'] },                 // no service
    { service: 'node', verbs: ['GET'] },                  // no pathPrefix
    { service: 'node', pathPrefix: '/ok', verbs: ['GET'] },
  ] });
  assert.deepEqual(readDeclaredGrant(dir).map((r) => r.pathPrefix), ['/ok']);
  assert.deepEqual(readDeclaredGrant(writeConfig({ grant: 'nope' })), []);
  assert.deepEqual(readDeclaredGrant(writeConfig({})), []);
});

test('grantAllows enforces the segment boundary', () => {
  const grant = rule({ service: 'node', pathPrefix: '/backlog', verbs: ['GET'] });
  assert.ok(grantAllows(grant, 'node', '/backlog', 'GET'));
  assert.ok(grantAllows(grant, 'node', '/backlog/x', 'GET'));
  assert.ok(!grantAllows(grant, 'node', '/backlogx', 'GET')); // not a boundary
});

test('grantAllows checks verb (case-insensitive) and service', () => {
  const grant = rule({ service: 'node', pathPrefix: '/data', verbs: ['post'] });
  assert.ok(grantAllows(grant, 'node', '/data', 'POST'));
  assert.ok(grantAllows(grant, 'node', '/data', 'post')); // method case-insensitive
  assert.ok(!grantAllows(grant, 'node', '/data', 'GET'));  // verb not granted
  assert.ok(!grantAllows(grant, 'other', '/data', 'POST')); // wrong service
});

test('a trailing-slash prefix is its own boundary and matches deeper paths', () => {
  const grant = rule({ service: 'node', pathPrefix: '/data/', verbs: ['GET'] });
  assert.ok(grantAllows(grant, 'node', '/data/', 'GET'));
  assert.ok(grantAllows(grant, 'node', '/data/x/y', 'GET'));
  assert.ok(!grantAllows(grant, 'node', '/database', 'GET'));
});

// ── exact / leaf rules ─────────────────────────────────────────────────────────────────────

test('exact:true grants the path ITSELF and nothing below it', () => {
  const grant = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: true });
  assert.ok(grantAllows(grant, 'node', '/mission', 'POST'));
  assert.ok(grantAllows(grant, 'node', '/mission/', 'POST'));       // trailing slash is not a segment
  assert.ok(!grantAllows(grant, 'node', '/mission/x', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/missions', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '', 'POST'));
});

test('THE DEFECT: POST /mission must not carry the mission-workflow write routes', () => {
  // The shipped grant — a bare prefix — reached every mutating route in the subtree.
  const subtree = rule({ service: 'node', pathPrefix: '/mission', verbs: ['GET', 'POST'] });
  assert.ok(grantAllows(subtree, 'node', '/mission/workflows/case.index', 'POST'));
  assert.ok(grantAllows(subtree, 'node', '/mission/workflows/case.index/rollback', 'POST'));

  // The leaf form: create a mission, and rewrite nobody's playbook.
  const leaf = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: true });
  assert.ok(grantAllows(leaf, 'node', '/mission', 'POST'));
  assert.ok(!grantAllows(leaf, 'node', '/mission/workflows', 'POST'));
  assert.ok(!grantAllows(leaf, 'node', '/mission/workflows/case.index', 'POST'));
  assert.ok(!grantAllows(leaf, 'node', '/mission/workflows/case.index/rollback', 'POST'));
});

test('exact:false is explicitly the subtree form (unchanged meaning)', () => {
  const grant = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: false });
  assert.ok(grantAllows(grant, 'node', '/mission', 'POST'));
  assert.ok(grantAllows(grant, 'node', '/mission/workflows/x/rollback', 'POST'));
});

test('a non-boolean `exact` DROPS the rule rather than guessing', () => {
  // "false" is a truthy string: read as a flag it would mean exact, read as a value it would
  // mean subtree. Either guess writes an authority the author did not express.
  assert.deepEqual(rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: 'false' }), []);
  assert.deepEqual(rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: 1 }), []);
  assert.deepEqual(rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: null }), []);
  // …and dropping means DENY, not "fall back to subtree".
  const g = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: 'true' });
  assert.ok(!grantAllows(g, 'node', '/mission', 'POST'));
});

// ── wildcard segments ──────────────────────────────────────────────────────────────────────

test('a `*` segment matches exactly one segment, never a separator', () => {
  const grant = rule({ service: 'node', pathPrefix: '/mission/*', verbs: ['POST'], exact: true });
  assert.ok(grantAllows(grant, 'node', '/mission/m-123', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/mission', 'POST'));                    // too few
  assert.ok(!grantAllows(grant, 'node', '/mission/workflows/x', 'POST'));        // too many
  assert.ok(!grantAllows(grant, 'node', '/mission/workflows/x/rollback', 'POST'));
  // A caller cannot smuggle a second segment through the hole with an encoded slash.
  assert.ok(!grantAllows(grant, 'node', '/mission/workflows%2fx', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/mission/workflows%2Fx', 'POST'));
});

test('a `*` in the middle addresses a path parameter (the session routes)', () => {
  const grant = rule({ service: 'node', pathPrefix: '/mission/session/*/read', verbs: ['POST'], exact: true });
  assert.ok(grantAllows(grant, 'node', '/mission/session/abc-123/read', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/mission/session/abc-123/drive', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/mission/session/read', 'POST'));
  assert.ok(!grantAllows(grant, 'node', '/mission/session/a/b/read', 'POST'));
});

test('`*` without exact still bounds the head, not the tail', () => {
  const grant = rule({ service: 'node', pathPrefix: '/mission/*/sessions', verbs: ['GET'] });
  assert.ok(grantAllows(grant, 'node', '/mission/m-1/sessions', 'GET'));
  assert.ok(grantAllows(grant, 'node', '/mission/m-1/sessions/deeper', 'GET')); // subtree form
  assert.ok(!grantAllows(grant, 'node', '/mission/m-1/tags', 'GET'));
});

test('a literal `*` in the REQUEST path is not a wildcard', () => {
  // The hole is in the RULE. A request path of '*' matches a '*' rule segment (it is just a
  // segment value) but must not match a literal one.
  const literal = rule({ service: 'node', pathPrefix: '/mission/workflows', verbs: ['POST'], exact: true });
  assert.ok(!grantAllows(literal, 'node', '/mission/*', 'POST'));
});

// ── path traversal + encoding ──────────────────────────────────────────────────────────────

test('traversal never matches, on any rule form', () => {
  const subtree = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'] });
  const leaf = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: true });
  for (const g of [subtree, leaf]) {
    assert.ok(!grantAllows(g, 'node', '/mission/../sessions', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission/..', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission//workflows/x/rollback', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission/./../secrets', 'POST'));
  }
});

test('percent-encoded separators never match (the matcher does not decode, it refuses)', () => {
  const subtree = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'] });
  const leaf = rule({ service: 'node', pathPrefix: '/mission', verbs: ['POST'], exact: true });
  for (const g of [subtree, leaf]) {
    assert.ok(!grantAllows(g, 'node', '/mission/%2e%2e/sessions', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission/%2E%2E/sessions', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission%2fworkflows%2fx%2frollback', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission/%2Fworkflows', 'POST'));
    assert.ok(!grantAllows(g, 'node', '/mission/..%5csecrets', 'POST'));
  }
});

test('a rule whose OWN prefix carries traversal is dropped', () => {
  assert.deepEqual(rule({ service: 'node', pathPrefix: '/mission/../health', verbs: ['GET'] }), []);
  assert.deepEqual(rule({ service: 'node', pathPrefix: '//', verbs: ['GET'] }), []);
  assert.deepEqual(rule({ service: 'node', pathPrefix: '/a%2fb', verbs: ['GET'] }), []);
});

test('an unrooted prefix is dropped, not silently promoted to a segment match', () => {
  // Segment comparison would make 'mission' and '/mission' identical; the old string-prefix
  // matcher never matched an unrooted rule, and it must stay that way.
  assert.deepEqual(rule({ service: 'node', pathPrefix: 'mission', verbs: ['POST'] }), []);
  const g = rule({ service: 'node', pathPrefix: 'mission', verbs: ['POST'] });
  assert.ok(!grantAllows(g, 'node', '/mission', 'POST'));
});

// ── the shipped configs ────────────────────────────────────────────────────────────────────

test('assist-missions: the narrowed grant covers every call app.js makes', () => {
  const grant = readDeclaredGrant(path.join(__dirname, '../../../../../ui-apps/assist-missions'));
  assert.ok(grant.length > 0, 'the shipped config must parse');
  const calls: Array<[string, string]> = [
    ['GET', '/mission'],
    ['GET', '/mission/controller'],
    ['GET', '/mission/controller/trace'],
    ['GET', '/mission/sessions'],
    ['GET', '/mission/m-1'],
    ['GET', '/mission/m-1/sessions'],
    ['GET', '/mission/session/sid-1/status'],
    ['GET', '/ccr/remote'],
    ['GET', '/ccr/cloud/repos'],
    ['GET', '/ccr/cloud/branches'],
    ['POST', '/mission'],
    // 🔴 PATCH, not POST. app.js:542 sends `{ method: 'PATCH' }` for a mission edit, and the
    // config grants PATCH on `/mission/*`. Core routes BOTH verbs to handlePatch
    // (mission.routes.ts:2284 + :2286), so asserting POST here reads as a missing grant and
    // invites someone to widen the config to an alias the pane never calls. See the
    // companion `mustNot` below, which pins that the POST alias stays out.
    ['PATCH', '/mission/m-1'],
    ['POST', '/mission/session/sid-1/read'],
    ['POST', '/mission/session/sid-1/drive'],
    ['POST', '/mission/session/sid-1/answer'],
    ['POST', '/mission/session/sid-1/control'],
    ['POST', '/mission/session/sid-1/resume'],
    ['POST', '/scheduler/jobs/mission-controller/run'],
  ];
  for (const [m, p] of calls) assert.ok(grantAllows(grant, 'node', p, m), `${m} ${p} must be granted`);
});

test('assist-missions: the workflow write routes are OUT of the grant', () => {
  const grant = readDeclaredGrant(path.join(__dirname, '../../../../../ui-apps/assist-missions'));
  const denied: Array<[string, string]> = [
    ['POST', '/mission/workflows/case.index'],           // rewrite a controller playbook
    ['POST', '/mission/workflows/case.index/rollback'],  // roll one back
    // The POST ALIAS of the patch route. Core accepts it (mission.routes.ts:2286) but the pane
    // only ever sends PATCH, so the alias is authority nobody asked for — keep it out.
    ['POST', '/mission/m-1'],
    ['POST', '/mission/controller/adopt'],
    ['POST', '/mission/m-1/spawn'],
    ['POST', '/mission/m-1/tags'],
    ['POST', '/mission/m-1/neighbors'],
    ['POST', '/mission/views/v-1/delete'],
    ['DELETE', '/mission/views/v-1'],
    ['POST', '/scheduler/jobs'],                         // create a scheduled job
    ['POST', '/scheduler/jobs/other-job/run'],
    ['POST', '/ccr/remote/stop'],
    ['GET', '/sessions'],
  ];
  for (const [m, p] of denied) assert.ok(!grantAllows(grant, 'node', p, m), `${m} ${p} must be denied`);
});

test('every shipped pane config parses to at least one rule', () => {
  const appsRoot = path.join(__dirname, '../../../../../ui-apps');
  const panes = fs.readdirSync(appsRoot)
    .filter((n) => fs.existsSync(path.join(appsRoot, n, 'lmui.config.json')));
  assert.ok(panes.length >= 10, `expected the shipped panes, found ${panes.length}`);
  for (const p of panes) {
    const g = readDeclaredGrant(path.join(appsRoot, p));
    assert.ok(g.length > 0, `${p}: every rule was dropped — a typo in service/pathPrefix/exact?`);
    // The gateway rejects an unrooted or traversing prefix at registration; a config that only
    // ever ran on the local tier must not be able to drift past that.
    for (const r of g) assert.ok(r.pathPrefix.startsWith('/'), `${p}: '${r.pathPrefix}' is not rooted`);
  }
});

/**
 * Every pane's REAL call inventory, read off its assets/app.js (or index.html for the two
 * inline panes) — `must` is every data-plane call the app makes, `mustNot` is what the old
 * subtree rule handed it and the narrowed rule takes away.
 *
 * 🔴 This is the safety net for narrowing a grant without touching an app: over-narrow by one
 * route and the `must` list fails here rather than at 403 in someone's browser.
 */
const PANE_CALLS: Record<string, { must: Array<[string, string]>; mustNot: Array<[string, string]> }> = {
  'assist-backlog': {
    must: [['GET', '/backlog'], ['GET', '/backlog/b-1'], ['GET', '/backlog/graph'], ['POST', '/backlog'],
      ['POST', '/backlog/b-1'], ['POST', '/backlog/b-1/discuss']],
    mustNot: [['POST', '/backlog/b-1/remove'], ['POST', '/backlog/b-1/rollback'],
      ['POST', '/backlog/b-1/link'], ['POST', '/backlog/b-1/unlink'], ['POST', '/backlog/b-1/review']],
  },
  'assist-clusters': {
    must: [['GET', '/cluster/list'], ['POST', '/cluster/assign'], ['POST', '/cluster/unassign'],
      ['POST', '/cluster/describe']],
    mustNot: [['GET', '/cluster/self'], ['POST', '/cluster/list']],
  },
  'assist-content': {
    must: [['GET', '/assist-content'], ['GET', '/assist-content/doc-1'], ['POST', '/assist-content/doc-1'],
      ['POST', '/assist-content/doc-1/rollback'], ['GET', '/assist-resources/files'],
      ['GET', '/assist-resources/file-stat'], ['GET', '/assist-resources/file'], ['GET', '/assist-resources/log']],
    mustNot: [['POST', '/assist-content'], ['POST', '/assist-resources/file']],
  },
  'assist-data': {
    must: [['GET', '/data/catalog'], ['GET', '/data/keys'], ['GET', '/data/sync/status'],
      ['POST', '/data/datasets'], ['DELETE', '/data/datasets/ds-1'], ['DELETE', '/data/access/k-1'],
      ['POST', '/data/sync']],
    mustNot: [['DELETE', '/data/datasets'], ['POST', '/data/datasets/ds-1'], ['DELETE', '/data/access'],
      ['POST', '/data/ds-1/records'], ['POST', '/data/ds-1/sql'], ['POST', '/data/ds-1/admin']],
  },
  'assist-knowledge': {
    must: [['GET', '/knowledge'], ['GET', '/knowledge/search'], ['GET', '/knowledge/K1'],
      ['GET', '/knowledge/review/status'], ['POST', '/knowledge/review']],
    mustNot: [['POST', '/knowledge'], ['POST', '/knowledge/generate'], ['POST', '/knowledge/generate/all'],
      ['POST', '/knowledge/dedup'], ['POST', '/knowledge/remote-sync'], ['POST', '/knowledge/K1'],
      ['POST', '/knowledge/K1/regenerate'], ['DELETE', '/knowledge/K1']],
  },
  'assist-manage': {
    must: [['GET', '/ui-pages'], ['GET', '/ui-pages/registry'], ['GET', '/ui-pages/grants/assist-missions'],
      ['POST', '/ui-pages/enable'], ['POST', '/ui-pages/control'], ['DELETE', '/ui-pages/registry/some-ui']],
    // 🔴 The two that mattered: registering a pane is registering a GRANT, and /local-url mints
    // an entry token for an arbitrary uiId — a pane that can call it can open any sibling.
    mustNot: [['POST', '/ui-pages/register'], ['POST', '/ui-pages/local-url'],
      ['POST', '/ui-pages/grants/release'], ['POST', '/ui-pages/screenshot']],
  },
  'assist-mcp-tools': {
    must: [['GET', '/mcp-tools'], ['GET', '/mcp-tools/some_tool'], ['POST', '/mcp-tools/some_tool'],
      ['POST', '/mcp-tools/some_tool/rollback'], ['GET', '/mcp-plugins'], ['GET', '/mcp-plugins/p/audit'],
      ['GET', '/mcp/access'], ['GET', '/mcp/pending'], ['GET', '/health'], ['GET', '/hub/status'],
      ['GET', '/claude-ai/mcp/servers']],
    mustNot: [['POST', '/mcp-plugins'], ['POST', '/health'], ['POST', '/claude-ai/mcp/servers']],
  },
  'assist-memory': {
    must: [['GET', '/memory/projects'], ['GET', '/memory/by-project/p-1'],
      ['GET', '/memory/by-project/p-1/file/MEMORY.md'], ['GET', '/rules/list'], ['GET', '/rules/file/x.md']],
    mustNot: [['POST', '/memory'], ['POST', '/rules/list']],
  },
  'assist-mission-graph': {
    must: [['GET', '/mission/m-1'], ['GET', '/mission/views'], ['GET', '/mission/sessions'],
      ['GET', '/mission/m-1/sessions'], ['GET', '/mission/views/v-1/graph'],
      ['POST', '/mission/graph'], ['POST', '/mission/schedule'], ['POST', '/mission/views']],
    mustNot: [['POST', '/mission/views/v-1/delete'], ['POST', '/mission'], ['POST', '/mission/m-1'],
      ['POST', '/mission/workflows/w-1'], ['POST', '/mission/workflows/w-1/rollback']],
  },
  // 🔴 The ONE pane that legitimately WRITES a controller playbook. Its editor + rollback were
  // restored this round, so the two POSTs below moved from `mustNot` to `must` — read off
  // assets/app.js:810 (save) and :839 (rollback), not off the config. The audit that used to say
  // "this pane never writes" now says "this pane writes EXACTLY these two routes"; the `mustNot`
  // list is what keeps that from being a licence, and it grew rather than shrank.
  'assist-mission-processes': {
    must: [['GET', '/mission/workflows'], ['GET', '/mission/workflows/case.index'],
      ['GET', '/mission/workflows/case.index/history'],
      ['POST', '/mission/workflows/case.index'],           // app.js:810 — save an edited doc
      ['POST', '/mission/workflows/case.index/rollback']], // app.js:839 — restore a revision
    mustNot: [
      // Every near-miss of the two writes above. A subtree POST rule would allow all of them.
      ['POST', '/mission/workflows'],                         // create at the collection root
      ['POST', '/mission/workflows/case.index/history'],      // rewrite the audit trail
      ['POST', '/mission/workflows/case.index/rollback/extra'],
      ['POST', '/mission/workflows/a/b'],                     // a 2-segment id is not one segment
      ['DELETE', '/mission/workflows/case.index'],            // the write grant is POST-only
      // …and nothing outside the workflows registry at all.
      ['POST', '/mission'], ['POST', '/mission/m-1'],
      ['GET', '/mission'], ['GET', '/mission/m-1'], ['GET', '/sessions']],
  },
  'assist-projects': {
    must: [['GET', '/projects'], ['GET', '/ttyd/processes'], ['POST', '/ttyd/process/identify'],
      ['POST', '/ttyd/process/12345/kill'], ['GET', '/sessions/batch-check'], ['GET', '/health']],
    mustNot: [['POST', '/ttyd/shell/start'], ['POST', '/ttyd/start-all'], ['POST', '/ttyd/cleanup'],
      ['POST', '/ttyd/session/s-1/input'], ['GET', '/sessions']],
  },
  'assist-scheduler': {
    must: [['GET', '/scheduler/jobs'], ['GET', '/scheduler/jobs/j-1'], ['GET', '/scheduler/jobs/j-1/logs'],
      ['POST', '/scheduler/jobs/j-1/run']],
    mustNot: [['POST', '/scheduler/jobs'], ['POST', '/scheduler/jobs/j-1'], ['DELETE', '/scheduler/jobs/j-1']],
  },
  // Read off assets/app.js, which has exactly THREE `api('node', …)` call sites — :341
  // (`/projects`), :310 (`/projects/sessions` or `/projects/<key>/sessions`, one or the other per
  // `state.source`) and :427 (`/sessions/<id>`). Four routes, all GET, no writes anywhere. The
  // `fetch('/auth/me')` at :754 is the tier's own origin surface, not a data-plane call, so it is
  // not grant-bearing; `lmui.goto(…)` at :695 is navigation, not a call.
  'assist-sessions': {
    must: [['GET', '/projects'], ['GET', '/projects/sessions'],
      ['GET', '/projects/-home-ubuntu-lm-assist/sessions'], ['GET', '/sessions/sid-1']],
    // 🔴 A session browser that could POST is a session DRIVER. The queue routes are the sharp
    // ones: `POST /sessions/<id>/queue` injects a prompt into a live Claude Code session, and
    // `/rename` rewrites how every other surface names it (sessions.routes.ts:342, :522). The
    // bare `GET /sessions` is out too — the pane pages via /projects/sessions, and the leaf rule
    // keeps the whole-node dump it never asked for out of reach.
    mustNot: [['POST', '/sessions/sid-1/queue'], ['POST', '/sessions/sid-1/rename'],
      ['POST', '/sessions/sid-1'], ['DELETE', '/sessions/sid-1'],
      ['GET', '/sessions'], ['GET', '/sessions/sid-1/conversation'],
      ['POST', '/projects'], ['POST', '/projects/sessions'],
      ['GET', '/projects/costs'], ['GET', '/projects/p-1'], ['GET', '/projects/p-1/tasks']],
  },
  'assist-skills': {
    must: [['GET', '/skills'], ['GET', '/skills/analytics'], ['GET', '/skills/analytics/chains'],
      ['GET', '/skills/detail/some-skill']],
    mustNot: [['POST', '/skills']],
  },
  'assist-tasks': {
    must: [['GET', '/tasks/all']],
    mustNot: [['POST', '/tasks/all'], ['GET', '/tasks']],
  },
  'assist-whatsapp': {
    must: [['GET', '/whatsapp/chats'], ['GET', '/whatsapp/messages'], ['GET', '/whatsapp/status'],
      ['POST', '/whatsapp/send']],
    // The pane could POST its OWN inbound webhook — i.e. fabricate received messages.
    mustNot: [['POST', '/whatsapp/webhook'], ['PUT', '/whatsapp/config']],
  },
  'hello-pane': {
    must: [['GET', '/health']],
    mustNot: [['POST', '/health'], ['GET', '/sessions']],
  },
};

test('every pane still reaches every call its app makes — and nothing it does not', () => {
  const root = path.join(__dirname, '../../../../../ui-apps');
  for (const [pane, { must, mustNot }] of Object.entries(PANE_CALLS)) {
    const g = readDeclaredGrant(path.join(root, pane));
    assert.ok(g.length > 0, `${pane}: config did not parse`);
    for (const [m, p] of must) assert.ok(grantAllows(g, 'node', p, m), `${pane}: ${m} ${p} must be GRANTED`);
    for (const [m, p] of mustNot) assert.ok(!grantAllows(g, 'node', p, m), `${pane}: ${m} ${p} must be DENIED`);
  }
});

test('the inventory covers every shipped pane (a new pane cannot skip the audit)', () => {
  const root = path.join(__dirname, '../../../../../ui-apps');
  const panes = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'lmui.config.json')));
  const missing = panes.filter((p) => !(p in PANE_CALLS) && p !== 'assist-missions');
  assert.deepEqual(missing, [], `panes with no call inventory above: ${missing.join(', ')}`);
});

/**
 * The Mission Processes pane may POST to EXACTLY two routes.
 *
 * 🔴 This test used to assert the pane was read-only on workflows. It is not, and has not been
 * since its editor and rollback were restored — so the honest assertion is not "no writes" but
 * "these writes and no others". The distinction is the entire value of the leaf/wildcard rule
 * form: a pane that needs `POST /mission/workflows/<id>` written as a bare prefix would also
 * hold `POST /mission/workflows/<id>/anything-added-later`, which is how the original defect
 * (`POST /mission` reaching the playbooks) happened one level up.
 *
 * The two granted writes are checked against TWO doc ids (so nothing passes on a hard-coded
 * name), and the denial list walks the near misses one segment at a time — collection root, the
 * sibling `history` route, one segment too deep, a two-segment id, and the same paths under the
 * other mutating verbs. Verified by mutation: widening the config to
 * `{'/mission/workflows', ['GET','POST']}` fails this test AND the inventory test above; dropping
 * the rollback rule fails both as well. It is not a test that only passes.
 */
test('the Mission Processes pane may POST exactly two workflow routes, and no sibling may POST any', () => {
  const root = path.join(__dirname, '../../../../../ui-apps');
  const proc = readDeclaredGrant(path.join(root, 'assist-mission-processes'));

  // The two writes it legitimately holds — for two different doc ids, so nothing here can pass
  // by accident on a hard-coded name.
  for (const id of ['case.index', 'mission.pass']) {
    assert.ok(grantAllows(proc, 'node', `/mission/workflows/${id}`, 'POST'), `save ${id}`);
    assert.ok(grantAllows(proc, 'node', `/mission/workflows/${id}/rollback`, 'POST'), `rollback ${id}`);
  }
  // Reads it needs (the editor cannot save what it cannot load).
  assert.ok(grantAllows(proc, 'node', '/mission/workflows', 'GET'));
  assert.ok(grantAllows(proc, 'node', '/mission/workflows/case.index', 'GET'));
  assert.ok(grantAllows(proc, 'node', '/mission/workflows/case.index/history', 'GET'));

  // EXACTLY two: every other POST-shaped path in and around the subtree is denied.
  const deniedPosts = [
    '/mission', '/mission/m-1', '/mission/workflows',
    '/mission/workflows/case.index/history',
    '/mission/workflows/case.index/rollback/extra',
    '/mission/workflows/case.index/publish',
    '/mission/workflows/a/b', '/mission/workflows/a/b/rollback',
    '/mission/controller/adopt', '/scheduler/jobs', '/sessions/s-1/queue',
  ];
  for (const p of deniedPosts) assert.ok(!grantAllows(proc, 'node', p, 'POST'), `POST ${p} must be denied`);
  // The write grant is POST — it does not carry the other mutating verbs on the same paths.
  for (const verb of ['DELETE', 'PUT', 'PATCH']) {
    assert.ok(!grantAllows(proc, 'node', '/mission/workflows/case.index', verb), `${verb} must be denied`);
    assert.ok(!grantAllows(proc, 'node', '/mission/workflows/case.index/rollback', verb), `${verb} rollback must be denied`);
  }

  // …and no sibling pane may write a playbook at all — that was the whole bug. The Mission
  // Processes pane holding these two routes is precisely why no one else may.
  for (const pane of ['assist-missions', 'assist-mission-graph']) {
    const g = readDeclaredGrant(path.join(root, pane));
    assert.ok(!grantAllows(g, 'node', '/mission/workflows/case.index', 'POST'), `${pane} writes a playbook`);
    assert.ok(!grantAllows(g, 'node', '/mission/workflows/case.index/rollback', 'POST'), `${pane} rolls back a playbook`);
  }
});
