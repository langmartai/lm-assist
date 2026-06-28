import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubHostOf, formatFleetIdentity, fleetIdentity } from '../mcp-server/fleet-identity';

test('hubHostOf normalizes wss URL to bare host', () => {
  assert.equal(hubHostOf('wss://assist-api.langmart.ai'), 'assist-api.langmart.ai');
  assert.equal(hubHostOf('wss://assist-api.xeenhub.com/ws'), 'assist-api.xeenhub.com');
  assert.equal(hubHostOf('https://h.example.com:8443/x'), 'h.example.com:8443');
  assert.equal(hubHostOf(''), null);
  assert.equal(hubHostOf(undefined), null);
  assert.equal(hubHostOf(null), null);
});

test('formatFleetIdentity emits hub host, cluster + the multi-connector caveat', () => {
  const block = formatFleetIdentity({ hubHost: 'assist-api.langmart.ai', hostname: 'ubuntu-Virtual-Machine', gatewayId: 'gw4-332c6620-92db', cluster: 'default' });
  assert.match(block, /assist-api\.langmart\.ai/);
  assert.match(block, /cluster: default/);
  assert.match(block, /ubuntu-Virtual-Machine/);
  assert.match(block, /OTHER lm-assist MCP connectors/);
  assert.match(block, /BAD_NODE/);
  assert.match(block, /list_nodes/);
});

test('formatFleetIdentity with no hub falls back to local-only but keeps the caveat', () => {
  const block = formatFleetIdentity({ hubHost: null, hostname: 'h', gatewayId: null, cluster: 'default' });
  assert.match(block, /local-only/);
  assert.match(block, /OTHER lm-assist MCP connectors/);
});

test('the emitted block hardcodes NO connector name (only derived hub host appears)', () => {
  // With a neutral hub host, the template text must not contain langmart/xeenhub literals.
  const block = formatFleetIdentity({ hubHost: 'example-hub', hostname: 'h', gatewayId: 'g', cluster: 'c' });
  assert.doesNotMatch(block, /langmart|xeenhub/);
});

test('fleetIdentity() never throws and returns the identity block', () => {
  const out = fleetIdentity();
  assert.match(out, /FLEET \/ CONNECTOR IDENTITY/);
  assert.match(out, /OTHER lm-assist MCP connectors/);
});
