import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveUpgradeSource,
  checkUpgradeTarget,
  checkSourceExists,
  formatPreflight,
  type SelfIdentity,
} from '../mcp-server/tools/node-upgrade';

test('explicit source used', () => {
  const r = resolveUpgradeSource('/abs/lm-assist-0.1.111.tgz');
  assert.ok(r.ok && r.source === '/abs/lm-assist-0.1.111.tgz');
});

test('ref → github spec', () => {
  const r = resolveUpgradeSource(undefined, 'main');
  assert.ok(r.ok && r.source === 'github:langmartai/lm-assist#main');
});

test('source wins over ref', () => {
  const r = resolveUpgradeSource('https://x/y.tgz', 'main');
  assert.ok(r.ok && r.source === 'https://x/y.tgz');
});

test('neither → error (downgrade guard)', () => {
  const r = resolveUpgradeSource();
  assert.ok(!r.ok && /DOWNGRADE/.test(r.error));
  // Guard message must convey it is a SAFE no-op (nothing upgraded), not a destructive action.
  assert.ok(!r.ok && /nothing|no-op|rejected/i.test(r.error));
});

test('empty/whitespace source → error', () => {
  assert.ok(!resolveUpgradeSource('   ').ok);
});

test('explicit latest rejected', () => {
  assert.ok(!resolveUpgradeSource('latest').ok);
  assert.ok(!resolveUpgradeSource('lm-assist@latest').ok);
});

test('bare lm-assist rejected (resolves to npm latest)', () => {
  assert.ok(!resolveUpgradeSource('lm-assist').ok);
});

// ---------------------------------------------------------------------------
// checkUpgradeTarget — the node that RECEIVES a destructive call must prove it
// is the node that was NAMED.
//
// Measured 2026-07-28: the `node` argument is chosen at the hub
// (LangMartDesign assist-api /internal/mcp-relay) and SURVIVES the relay into
// the target handler — a fabric_probe routed to yitest echoed the id back
// instead of erroring "node is required". So the target can check its own
// identity locally. Two failure modes matter: `node` omitted (hub silently
// picks its most-recently-connected default) and `node` named but landed
// elsewhere (hub fallback, stdio, or wrong connector).
// ---------------------------------------------------------------------------

const SELF: SelfIdentity = {
  hostId: 'gw4-332c6620-92db-4d57-99dc-db49f29faa39',
  hostname: 'ubuntu-Virtual-Machine',
  cluster: 'prod',
  hubHost: 'assist-api.langmart.ai',
};

test('no node named → refuses, and says nothing was upgraded', () => {
  const r = checkUpgradeTarget(undefined, SELF);
  assert.ok(!r.ok);
  assert.match(r.error, /nothing was upgraded/i);
});

test('no node named → names the machine it would have replaced', () => {
  // The whole point: the default node is NOT necessarily the one you mean.
  const r = checkUpgradeTarget(undefined, SELF);
  assert.ok(!r.ok && r.error.includes('ubuntu-Virtual-Machine'));
});

test('node matching this hostId → allowed', () => {
  assert.ok(checkUpgradeTarget(SELF.hostId, SELF).ok);
});

test('node matching this hostname → allowed', () => {
  assert.ok(checkUpgradeTarget('ubuntu-Virtual-Machine', SELF).ok);
});

test('hostname match tolerates case and surrounding whitespace', () => {
  assert.ok(checkUpgradeTarget('  UBUNTU-virtual-machine ', SELF).ok);
});

test('a (dev) hostname suffix still matches the bare name', () => {
  // getHubConfig appends "(dev)" when Core runs from a git checkout.
  const dev: SelfIdentity = { ...SELF, hostname: 'ubuntu-Virtual-Machine (dev)' };
  assert.ok(checkUpgradeTarget('ubuntu-Virtual-Machine', dev).ok);
});

test('named another node but landed here → refuses', () => {
  const r = checkUpgradeTarget('DESKTOP-GDKLATG', SELF);
  assert.ok(!r.ok && /nothing was upgraded/i.test(r.error));
});

test('mismatch refusal names BOTH the requested and the actual node', () => {
  const r = checkUpgradeTarget('DESKTOP-GDKLATG', SELF);
  assert.ok(!r.ok);
  assert.ok(r.error.includes('DESKTOP-GDKLATG'), 'must echo what was requested');
  assert.ok(r.error.includes('ubuntu-Virtual-Machine'), 'must name where it landed');
});

test('mismatch refusal points at the wrong-connector possibility', () => {
  // Two connectors serve identical tool names over independent fleets.
  const r = checkUpgradeTarget('DESKTOP-GDKLATG', SELF);
  assert.ok(!r.ok && /connector|fleet/i.test(r.error));
});

// ---------------------------------------------------------------------------
// checkSourceExists — a local .tgz path must exist BEFORE dispatch.
//
// upgrade.js resolveSource() falls through to the npm-spec branch when the
// path does not exist, and main() kills every service (step 2) BEFORE running
// the install (step 3). So a typo'd path tears the node down, fails to
// install, and the tool has already returned "Upgrade started".
// ---------------------------------------------------------------------------

const missing = () => false;
const present = () => true;

test('a local .tgz that does not exist → refuses before dispatch', () => {
  const r = checkSourceExists('/home/ubuntu/lm-assist-0.1.120.tgz', missing);
  assert.ok(!r.ok && /nothing was upgraded/i.test(r.error));
});

test('missing-tarball refusal explains the node would have been taken down', () => {
  const r = checkSourceExists('/home/ubuntu/lm-assist-0.1.120.tgz', missing);
  assert.ok(!r.ok && /stop|kill|down|services/i.test(r.error));
});

test('missing-tarball refusal echoes the path that was not found', () => {
  const r = checkSourceExists('/home/ubuntu/typo.tgz', missing);
  assert.ok(!r.ok && r.error.includes('/home/ubuntu/typo.tgz'));
});

test('a local .tgz that exists → allowed', () => {
  assert.ok(checkSourceExists('/home/ubuntu/lm-assist-0.1.120.tgz', present).ok);
});

test('.tar.gz is treated as a local tarball too', () => {
  assert.ok(!checkSourceExists('/tmp/lm-assist.tar.gz', missing).ok);
});

test('an https .tgz URL is never checked on disk', () => {
  assert.ok(checkSourceExists('https://example.com/lm-assist.tgz', missing).ok);
});

test('a github: spec is never checked on disk', () => {
  assert.ok(checkSourceExists('github:langmartai/lm-assist#main', missing).ok);
});

test('a bare version spec is never checked on disk', () => {
  assert.ok(checkSourceExists('0.1.120', missing).ok);
});

// ---------------------------------------------------------------------------
// formatPreflight — state the resolved target BEFORE dispatching.
//
// The result footer (⟦lm-assist@hub · node · cluster⟧) is good provenance but
// arrives AFTER the services have already been restarted.
// ---------------------------------------------------------------------------

test('preflight names hub, cluster, node and the build transition', () => {
  const s = formatPreflight(SELF, '0.1.135', '/home/ubuntu/lm-assist-0.1.136.tgz');
  assert.ok(s.includes('assist-api.langmart.ai'), 'hub');
  assert.ok(s.includes('prod'), 'cluster');
  assert.ok(s.includes('ubuntu-Virtual-Machine'), 'hostname');
  assert.ok(s.includes(SELF.hostId as string), 'hostId');
  assert.ok(s.includes('0.1.135'), 'current build');
  assert.ok(s.includes('/home/ubuntu/lm-assist-0.1.136.tgz'), 'intended build');
});

test('preflight labels a langmart hub PRODUCTION', () => {
  assert.match(formatPreflight(SELF, '0.1.135', 'x.tgz'), /PRODUCTION/);
});

test('preflight labels an xeenhub hub DEVELOPMENT', () => {
  const dev: SelfIdentity = { ...SELF, hubHost: 'assist-api.xeenhub.com' };
  assert.match(formatPreflight(dev, '0.1.135', 'x.tgz'), /DEVELOPMENT/);
});

test('preflight tolerates an unknown current build', () => {
  assert.ok(formatPreflight(SELF, '?', 'x.tgz').includes('?'));
});
