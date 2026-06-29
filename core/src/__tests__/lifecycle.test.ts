import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeTarget, coreServeInvocation, relauncherArgs, isSystemdManaged } from '../lifecycle';

test('normalizeTarget — defaults to core; passes web/both; rejects junk', () => {
  assert.equal(normalizeTarget(undefined), 'core');
  assert.equal(normalizeTarget('core'), 'core');
  assert.equal(normalizeTarget('web'), 'web');
  assert.equal(normalizeTarget('both'), 'both');
  assert.equal(normalizeTarget('bogus'), 'core');
  assert.equal(normalizeTarget(42), 'core');
});

test('coreServeInvocation — reads cli path + serve args + --port (preserves --extra-ca)', () => {
  const r = coreServeInvocation(
    ['/usr/bin/node', '/x/core/dist/cli.js', 'serve', '--port', '3100', '--project', '/home/ubuntu', '--extra-ca', '/c/ca.crt'],
    {},
  );
  assert.equal(r.cliPath, '/x/core/dist/cli.js');
  assert.deepEqual(r.serveArgs, ['serve', '--port', '3100', '--project', '/home/ubuntu', '--extra-ca', '/c/ca.crt']);
  assert.equal(r.port, 3100);
});

test('coreServeInvocation — falls back to API_PORT then 3100', () => {
  assert.equal(coreServeInvocation(['node', 'cli.js', 'serve'], { API_PORT: '3200' }).port, 3200);
  assert.equal(coreServeInvocation(['node', 'cli.js', 'serve'], {}).port, 3100);
});

test('isSystemdManaged — false without INVOCATION_ID (so non-systemd nodes self-respawn)', () => {
  assert.equal(isSystemdManaged({}), false);
  assert.equal(isSystemdManaged({ INVOCATION_ID: '' }), false);
});

test('relauncherArgs — passes config as ARGV (no code-gen), preserving --extra-ca order', () => {
  const a = relauncherArgs('/d/relaunch-helper.js', 3100, '/usr/bin/node', '/x/cli.js', ['serve', '--port', '3100', '--extra-ca', '/c/ca.crt']);
  assert.deepEqual(a, ['/d/relaunch-helper.js', '3100', '/usr/bin/node', '/x/cli.js', 'serve', '--port', '3100', '--extra-ca', '/c/ca.crt']);
});
