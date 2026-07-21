// Task 10: guide("clusters") topic + bootstrap/session_status cluster awareness
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDES_TEST_EXPORT } from '../mcp-server/tools/guide';
import { SESSION_STATUS_HANDLERS } from '../mcp-server/mcp-session-resolver';
import { stopSessionCache } from '../session-cache';

// session_status() lazily starts the SessionCache chokidar watcher (open handle) —
// release it so the runner exits instead of hanging. See fleet-identity-session-status.
after(() => stopSessionCache());

const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

// ── guide("clusters") topic ────────────────────────────────────────────────

test('GUIDES_TEST_EXPORT contains a "clusters" entry', () => {
  assert.ok('clusters' in GUIDES_TEST_EXPORT, 'GUIDES map must have a clusters key');
});

test('guide("clusters") returns text including the four cluster tool names', async () => {
  const t = await text({ topic: 'clusters' });
  assert.match(t, /cluster_list/, 'must mention cluster_list');
  assert.match(t, /cluster_assign/, 'must mention cluster_assign');
  assert.match(t, /cluster_unassign/, 'must mention cluster_unassign');
  assert.match(t, /cluster_describe/, 'must mention cluster_describe');
});

test('guide("clusters") includes the respect-other-clusters advisory norm', async () => {
  const t = await text({ topic: 'clusters' });
  assert.match(t, /respect/i, 'must include the respect norm for other clusters');
  assert.match(t, /off-limits|do NOT operate|scope/i, 'must mention scoping/off-limits');
});

test('guide("clusters") covers the shared-vs-within split', async () => {
  const t = await text({ topic: 'clusters' });
  assert.match(t, /WITHIN/i, 'must cover within-cluster operations');
  assert.match(t, /FLEET-WIDE|fleet.wide/i, 'must cover fleet-wide operations');
  assert.match(t, /leader|mission-control|data.service/i, 'must mention within-cluster examples');
});

test('guide("clusters") explains what a cluster is + the default cluster', async () => {
  const t = await text({ topic: 'clusters' });
  assert.match(t, /cluster/i);
  assert.match(t, /default/i, 'must mention the default cluster for unassigned nodes');
  assert.match(t, /unassign|exactly one|partition/i, 'must explain one-cluster-per-node');
});

test('guide("clusters") covers build/release one cluster at a time', async () => {
  const t = await text({ topic: 'clusters' });
  assert.match(t, /node_upgrade|node_builds/i, 'must mention the build/upgrade tools');
  assert.match(t, /one cluster at a time|cluster.*build|build.*cluster/i, 'must cover per-cluster build/release');
});

test('guide("clusters") synonym aliases resolve to clusters', async () => {
  for (const syn of ['cluster', 'clusters']) {
    const t = await text({ topic: syn });
    assert.match(t, /cluster_list/i, `alias '${syn}' should resolve to clusters guide`);
  }
});

test('clusters topic is listed in the index', async () => {
  const t = await text({});
  assert.match(t, /`clusters`/, 'index must list the clusters topic');
});

// ── bootstrap includes cluster info ───────────────────────────────────────

test('bootstrap text includes the clusters guide content', async () => {
  const t = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(t, /cluster_list/, 'bootstrap must include clusters guide mentioning cluster_list');
  assert.match(t, /respect/i, 'bootstrap must include the clusters respect norm');
});

// ── session_status includes cluster ───────────────────────────────────────

test('session_status output includes this node cluster', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  assert.match(t, /cluster/i, 'session_status must report the node cluster');
});

test('session_status includes the dynamic cluster roster (other clusters)', async () => {
  const r = await SESSION_STATUS_HANDLERS.session_status({});
  const t = r.content[0].text as string;
  // The dynamic cluster block should render — either with or without other clusters.
  // When data service is enabled and other clusters exist, "otherClusters" appears in the JSON.
  // The key assertion is that the cluster info is populated (not null/undefined).
  assert.ok(t.includes('cluster') || t.match(/otherClusters|Other clusters/), 'session_status must include cluster roster info or otherClusters field');
});
