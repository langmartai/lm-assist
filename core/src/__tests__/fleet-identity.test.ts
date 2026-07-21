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

// The caveat prose was reworded by the env-labeling work (PRODUCTION vs DEVELOPMENT
// connector); these assertions pin the CURRENT load-bearing phrases: both connectors
// may be attached, they are independent instances over different fleets, fall back.
test('formatFleetIdentity emits hub host, cluster + the multi-connector caveat', () => {
  const block = formatFleetIdentity({ hubHost: 'assist-api.langmart.ai', hostname: 'ubuntu-Virtual-Machine', gatewayId: 'gw4-332c6620-92db', cluster: 'default' });
  assert.match(block, /assist-api\.langmart\.ai/);
  assert.match(block, /cluster: default/);
  assert.match(block, /ubuntu-Virtual-Machine/);
  assert.match(block, /INDEPENDENT instances over DIFFERENT fleets/);
  assert.match(block, /BAD_NODE/);
  assert.match(block, /list_nodes/);
});

test('formatFleetIdentity with no hub falls back to local-only but keeps the caveat', () => {
  const block = formatFleetIdentity({ hubHost: null, hostname: 'h', gatewayId: null, cluster: 'default' });
  assert.match(block, /local-only/);
  assert.match(block, /INDEPENDENT instances over DIFFERENT fleets/);
});

test('the caveat names BOTH environments so an LLM can pick the right connector', () => {
  // The env discriminators (hub domain families) are intentionally part of the prose.
  const block = formatFleetIdentity({ hubHost: 'example-hub', hostname: 'h', gatewayId: 'g', cluster: 'c' });
  assert.match(block, /example-hub/, 'derived hub host appears');
  assert.match(block, /PRODUCTION connector/);
  assert.match(block, /DEVELOPMENT connector/);
});

test('fleetIdentity() never throws and returns the identity block', () => {
  const out = fleetIdentity();
  assert.match(out, /FLEET \/ CONNECTOR IDENTITY/);
  assert.match(out, /INDEPENDENT instances over DIFFERENT fleets/);
});
